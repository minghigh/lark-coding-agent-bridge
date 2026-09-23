import WebSocket from 'ws';
import { log } from '../../core/logger';
import type { SandboxMode } from '../../config/profile-schema';
import type { AgentEvent, AgentModel, AgentRun, AgentRunOptions } from '../types';

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  socket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: JsonObject) => void;
  reject: (error: Error) => void;
}

interface RunState {
  run: AgentRunState;
  threadId?: string;
  turnId?: string;
  stopped: boolean;
}

interface AgentRunState {
  runId: string;
  queue: EventQueue;
  done: Promise<void>;
  finish: () => void;
  resolveDone: () => void;
  closed: boolean;
  tools: Map<string, string>;
  agentMessages: Set<string>;
  agentMessagePhases: Map<string, string>;
  reasoningItems: Set<string>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

type AppServerRunOptions = AgentRunOptions & { developerInstructions?: string };

/** JSON-RPC client for one local Codex app-server WebSocket endpoint. */
export class CodexAppServer {
  private readonly url: string;
  private readonly reasoningEffort: string | undefined;
  private readonly requestTimeoutMs: number;
  private socket: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly runs = new Map<string, RunState>();

  constructor(
    url: string,
    reasoningEffort?: string,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.url = url;
    this.reasoningEffort = reasoningEffort;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async listModels(): Promise<AgentModel[]> {
    await this.ensureConnected();
    const result = await this.request('model/list', { limit: 100, includeHidden: false });
    const data = Array.isArray(result.data) ? result.data : [];
    return data.flatMap((value) => {
      const model = objectValue(value);
      const id = stringValue(model?.model) ?? stringValue(model?.id);
      if (!model || !id) return [];
      const efforts = Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.flatMap((entry) => {
            const effort = stringValue(objectValue(entry)?.reasoningEffort);
            return effort ? [effort] : [];
          })
        : [];
      return [{
        id,
        label: stringValue(model.displayName) ?? id,
        isDefault: model.isDefault === true,
        reasoningEfforts: efforts,
      }];
    });
  }

  run(opts: AppServerRunOptions): AgentRun {
    const queue = new EventQueue();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const state: AgentRunState = {
      runId: opts.runId,
      queue,
      done,
      resolveDone,
      finish: () => {},
      closed: false,
      tools: new Map(),
      agentMessages: new Set(),
      agentMessagePhases: new Map(),
      reasoningItems: new Set(),
    };
    const active: RunState = { run: state, stopped: false };
    state.finish = () => this.finishRun(active);
    void this.startRun(active, opts);

    return {
      runId: opts.runId,
      events: queue,
      stop: async () => {
        active.stopped = true;
        if (active.threadId && active.turnId) {
          await this.request('turn/interrupt', {
            threadId: active.threadId,
            turnId: active.turnId,
          }).catch(() => undefined);
        }
        this.finishRun(active, 'interrupted');
      },
      waitForExit: (timeoutMs) =>
        Promise.race([
          done.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]),
    };
  }

  private async startRun(active: RunState, opts: AppServerRunOptions): Promise<void> {
    try {
      await this.ensureConnected();
      if (active.stopped) return this.finishRun(active, 'interrupted');

      const thread = opts.threadId
        ? await this.request('thread/resume', {
            threadId: opts.threadId,
            cwd: opts.cwd,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.developerInstructions
              ? { developerInstructions: opts.developerInstructions }
              : {}),
            sandbox: toAppSandbox(opts.sandbox),
          })
        : await this.request('thread/start', {
            cwd: opts.cwd,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.developerInstructions
              ? { developerInstructions: opts.developerInstructions }
              : {}),
            approvalPolicy: 'never',
            sandbox: toAppSandbox(opts.sandbox),
          });
      const threadRecord = objectValue(thread.thread);
      const threadId = stringValue(threadRecord?.id) ?? opts.threadId;
      if (!threadId) throw new Error('Codex app-server returned no thread id');

      active.threadId = threadId;
      this.runs.set(threadId, active);
      active.run.queue.push({
        type: 'system',
        threadId,
        cwd: opts.cwd,
        ...(stringValue(thread.model) ? { model: stringValue(thread.model) } : {}),
      });
      if (active.stopped) return this.finishRun(active, 'interrupted');

      const input = [
        { type: 'text', text: opts.prompt, text_elements: [] },
        ...(opts.images ?? []).map((path) => ({ type: 'localImage', path })),
      ];
      log.info('app-server', 'turn-start', {
        hasThread: Boolean(opts.threadId),
        images: opts.images?.length ?? 0,
      });
      const effort = opts.reasoningEffort ?? this.reasoningEffort;
      const turn = await this.request('turn/start', {
        threadId,
        cwd: opts.cwd,
        ...(opts.model ? { model: opts.model } : {}),
        ...(effort ? { effort } : {}),
        approvalPolicy: 'never',
        input,
      });
      active.turnId = stringValue(objectValue(turn.turn)?.id);
      if (active.stopped) {
        if (active.turnId) {
          await this.request('turn/interrupt', { threadId, turnId: active.turnId }).catch(
            () => undefined,
          );
        }
        return this.finishRun(active, 'interrupted');
      }
    } catch (error) {
      this.failRun(active, error instanceof Error ? error.message : String(error));
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        socket.terminate();
        finish(new Error(`Codex app-server connection timed out: ${this.url}`));
      }, 15_000);

      this.socket = socket;
      socket.on('open', () => {
        void this.request('initialize', {
          clientInfo: { name: 'lark-channel-bridge', title: 'Lark Channel Bridge', version: '0.7.1' },
        }).then(() => {
          socket.send(JSON.stringify({ method: 'initialized', params: {} }));
          finish();
        }, finish);
      });
      socket.on('message', (raw) => this.handleMessage(raw.toString()));
      socket.on('error', (error) => {
        if (!settled) finish(error);
        else log.warn('app-server', 'socket-error', { message: error.message });
      });
      socket.on('close', () => {
        const error = new Error('Codex app-server socket closed');
        if (this.socket !== socket) {
          this.rejectPending(error, socket);
          return;
        }
        this.socket = undefined;
        if (!settled) finish(new Error('Codex app-server socket closed during connect'));
        this.rejectPending(error, socket);
        for (const active of this.runs.values()) {
          this.failRun(active, 'Codex app-server disconnected');
        }
        this.runs.clear();
      });
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private request(method: string, params: JsonObject): Promise<JsonObject> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Codex app-server is not connected'));
    }
    const id = ++this.requestId;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { socket, timer, resolve, reject });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  private handleMessage(raw: string): void {
    let message: JsonObject;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) return;
      message = parsed;
    } catch {
      return;
    }

    const id = numberValue(message.id);
    if (id !== undefined && typeof message.method !== 'string') {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = objectValue(message.error);
      if (error) {
        pending.reject(new Error(stringValue(error.message) ?? 'Codex app-server request failed'));
      } else {
        pending.resolve(objectValue(message.result) ?? {});
      }
      return;
    }

    const method = stringValue(message.method);
    if (!method) return;
    if (id !== undefined) {
      this.socket?.send(
        JSON.stringify({
          id,
          error: { code: -32601, message: `Bridge does not handle server request ${method}` },
        }),
      );
      return;
    }
    this.handleNotification(method, objectValue(message.params) ?? {});
  }

  private handleNotification(method: string, params: JsonObject): void {
    const threadId = stringValue(params.threadId) ?? stringValue(objectValue(params.thread)?.id);
    const active = threadId ? this.runs.get(threadId) : undefined;
    if (!active || active.run.closed) return;
    const turn = objectValue(params.turn);
    const turnId = stringValue(params.turnId) ?? stringValue(turn?.id);
    if (turnId && active.turnId && turnId !== active.turnId) return;

    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = stringValue(params.delta);
        const itemId = stringValue(params.itemId);
        if (delta) {
          if (itemId) active.run.agentMessages.add(itemId);
          const phase =
            (itemId ? active.run.agentMessagePhases.get(itemId) : undefined) ??
            stringValue(params.phase);
          if (phase === 'final_answer') return;
          active.run.queue.push({ type: 'text', delta });
        }
        return;
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const delta = stringValue(params.delta);
        const itemId = stringValue(params.itemId);
        if (itemId) active.run.reasoningItems.add(itemId);
        if (delta) active.run.queue.push({ type: 'thinking', delta });
        return;
      }
      case 'item/plan/delta':
      case 'item/commandExecution/outputDelta': {
        const id = stringValue(params.itemId);
        const delta = stringValue(params.delta);
        if (id && delta) {
          active.run.tools.set(id, `${active.run.tools.get(id) ?? ''}${delta}`);
          active.run.queue.push({ type: 'tool_output', id, delta });
        }
        return;
      }
      case 'item/mcpToolCall/progress': {
        const id = stringValue(params.itemId);
        const message = stringValue(params.message);
        if (id && message) {
          const delta = `${message}\n`;
          active.run.tools.set(id, `${active.run.tools.get(id) ?? ''}${delta}`);
          active.run.queue.push({ type: 'tool_output', id, delta });
        }
        return;
      }
      case 'item/started': {
        const item = objectValue(params.item);
        if (item && isAgentMessageItem(item)) {
          const id = stringValue(item.id);
          const phase = stringValue(item.phase);
          if (id && phase) active.run.agentMessagePhases.set(id, phase);
          return;
        }
        if (!item) return;
        const event = toolUseForItem(item);
        if (!event) return;
        active.run.tools.set(event.id, '');
        active.run.queue.push(event);
        return;
      }
      case 'item/completed': {
        const item = objectValue(params.item);
        if (!item) return;
        if (isAgentMessageItem(item)) {
          const id = stringValue(item.id);
          const text = stringValue(item.text);
          if (text && item.phase === 'final_answer') {
            active.run.queue.push({ type: 'final_text', content: text });
          } else if (text && (!id || !active.run.agentMessages.has(id))) {
            active.run.queue.push({ type: 'text', delta: text });
          }
          if (id) active.run.agentMessagePhases.delete(id);
          return;
        }
        if (item.type === 'reasoning') {
          const id = stringValue(item.id);
          if (!id || !active.run.reasoningItems.has(id)) {
            const text = [...stringArray(item.summary), ...stringArray(item.content)].join('\n\n');
            if (text) active.run.queue.push({ type: 'thinking', delta: text });
          }
          if (id) active.run.reasoningItems.delete(id);
          return;
        }
        const event = toolResultForItem(item, active.run.tools);
        if (event) {
          active.run.queue.push(event);
          active.run.tools.delete(event.id);
        }
        if (item.type === 'imageGeneration') {
          const source = generatedImageSource(item);
          if (source) active.run.queue.push({ type: 'generated_image', source });
        }
        return;
      }
      case 'thread/tokenUsage/updated': {
        const usage = objectValue(params.tokenUsage)?.last;
        if (!isObject(usage)) return;
        active.run.queue.push({
          type: 'usage',
          inputTokens: numberValue(usage.inputTokens),
          outputTokens: numberValue(usage.outputTokens),
          cachedInputTokens: numberValue(usage.cachedInputTokens),
          reasoningOutputTokens: numberValue(usage.reasoningOutputTokens),
        });
        return;
      }
      case 'turn/completed': {
        const status = stringValue(turn?.status);
        if (status === 'failed') {
          const error = objectValue(turn?.error);
          this.failRun(active, stringValue(error?.message) ?? 'Codex app-server turn failed');
        } else {
          this.finishRun(active, status === 'interrupted' ? 'interrupted' : 'normal');
        }
        return;
      }
      case 'error': {
        const error = objectValue(params.error);
        if (params.willRetry === true) return;
        this.failRun(active, stringValue(error?.message) ?? 'Codex app-server turn failed');
        return;
      }
      default:
        return;
    }
  }

  private finishRun(active: RunState, reason: 'normal' | 'interrupted' = 'normal'): void {
    if (active.run.closed) return;
    active.run.closed = true;
    if (active.threadId && this.runs.get(active.threadId) === active) this.runs.delete(active.threadId);
    active.run.queue.push({
      type: 'done',
      threadId: active.threadId,
      terminationReason: reason,
    });
    active.run.queue.close();
    active.run.resolveDone();
  }

  private failRun(active: RunState, message: string): void {
    if (active.run.closed) return;
    active.run.closed = true;
    if (active.threadId && this.runs.get(active.threadId) === active) this.runs.delete(active.threadId);
    active.run.queue.push({ type: 'error', message, terminationReason: 'failed' });
    active.run.queue.close();
    active.run.resolveDone();
  }

  private rejectPending(error: Error, socket?: WebSocket): void {
    for (const [id, pending] of this.pending) {
      if (socket && pending.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly values: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;

  push(value: AgentEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<AgentEvent>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function toAppSandbox(mode: SandboxMode | undefined): string {
  return mode ?? 'danger-full-access';
}

function isCommandItem(item: JsonObject): boolean {
  return item.type === 'commandExecution' || item.type === 'command_execution';
}

function isAgentMessageItem(item: JsonObject): boolean {
  return item.type === 'agentMessage' || item.type === 'agent_message';
}

function toolUseForItem(item: JsonObject): Extract<AgentEvent, { type: 'tool_use' }> | undefined {
  const id = stringValue(item.id);
  const type = stringValue(item.type);
  if (!id || !type) return undefined;
  switch (type) {
    case 'commandExecution':
    case 'command_execution':
      return { type: 'tool_use', id, name: 'command_execution', input: { command: item.command } };
    case 'fileChange':
      return { type: 'tool_use', id, name: 'apply_patch', input: { files: fileChangeFiles(item.changes) } };
    case 'mcpToolCall':
      return {
        type: 'tool_use',
        id,
        name: [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join('.') || 'mcp',
        input: item.arguments,
      };
    case 'dynamicToolCall':
      return {
        type: 'tool_use',
        id,
        name: [stringValue(item.namespace), stringValue(item.tool)].filter(Boolean).join('.') || 'tool',
        input: item.arguments,
      };
    case 'collabAgentToolCall':
      return {
        type: 'tool_use',
        id,
        name: stringValue(item.tool) ?? 'agent',
        input: pick(item, ['prompt', 'model', 'reasoningEffort', 'receiverThreadIds']),
      };
    case 'webSearch':
      return { type: 'tool_use', id, name: 'web_search', input: pick(item, ['query', 'action']) };
    case 'imageView':
      return { type: 'tool_use', id, name: 'view_image', input: { path: item.path } };
    case 'imageGeneration':
      return {
        type: 'tool_use',
        id,
        name: 'image_generation',
        input: { prompt: item.revisedPrompt },
      };
    case 'plan':
      return { type: 'tool_use', id, name: 'update_plan', input: { plan: item.text } };
    case 'sleep':
      return { type: 'tool_use', id, name: 'wait', input: { durationMs: item.durationMs } };
    case 'subAgentActivity':
      return { type: 'tool_use', id, name: 'subagent', input: pick(item, ['kind', 'agentPath']) };
    case 'functionCallOutput':
      return {
        type: 'tool_use',
        id,
        name: [stringValue(item.namespace), stringValue(item.name)].filter(Boolean).join('.') || 'tool',
        input: {},
      };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return { type: 'tool_use', id, name: type, input: { review: item.review } };
    case 'contextCompaction':
      return { type: 'tool_use', id, name: 'context_compaction', input: {} };
    default:
      return undefined;
  }
}

function toolResultForItem(
  item: JsonObject,
  streamed: ReadonlyMap<string, string>,
): Extract<AgentEvent, { type: 'tool_result' }> | undefined {
  const id = stringValue(item.id);
  const type = stringValue(item.type);
  if (!id || !type || !toolUseForItem(item)) return undefined;
  const status = stringValue(item.status);
  const error = objectValue(item.error);
  let output: unknown;
  switch (type) {
    case 'commandExecution':
    case 'command_execution':
      output = item.aggregatedOutput ?? item.output ?? streamed.get(id) ?? '';
      break;
    case 'fileChange':
      output = summarizeFileChanges(item.changes);
      break;
    case 'mcpToolCall':
      output = objectValue(item.result)?.content ?? item.result ?? error?.message ?? '';
      break;
    case 'dynamicToolCall':
      output = item.contentItems;
      break;
    case 'collabAgentToolCall':
      output = pick(item, ['status', 'agentsStates']);
      break;
    case 'webSearch':
      output = item.results ?? item.action ?? 'completed';
      break;
    case 'imageGeneration':
      output = status === 'failed'
        ? displayValue(item.failure) || '图片生成失败'
        : '🖼️ 图片已生成，正在发送到飞书…';
      break;
    case 'plan':
      output = item.text;
      break;
    case 'functionCallOutput':
      output = item.output;
      break;
    default:
      output = pick(item, [
        'status',
        'path',
        'durationMs',
        'kind',
        'agentPath',
        'review',
      ]);
  }
  const exitCode = numberValue(item.exitCode ?? item.exit_code);
  return {
    type: 'tool_result',
    id,
    output: displayValue(output),
    isError:
      Boolean(error) ||
      item.success === false ||
      (exitCode !== undefined ? exitCode !== 0 : status === 'failed' || status === 'error'),
  };
}

function fileChangeFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const path = stringValue(objectValue(entry)?.path);
    return path ? [path] : [];
  });
}

function summarizeFileChanges(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return '✅ 文件修改已完成';
  const lines = value.flatMap((entry) => {
    const change = objectValue(entry);
    const path = stringValue(change?.path);
    if (!path) return [];
    const kind = (stringValue(change?.kind) ?? '').toLowerCase();
    const icon = kind.includes('add') || kind.includes('create')
      ? '➕'
      : kind.includes('delete') || kind.includes('remove')
        ? '🗑️'
        : '✏️';
    const diff = stringValue(change?.diff) ?? '';
    const added = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
    const removed = diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
    const stats = added || removed ? ` · +${added} / −${removed}` : '';
    return [`- ${icon} \`${path.replace(/`/g, '\\`')}\`${stats}`];
  });
  return lines.length ? `📝 文件变更\n\n${lines.join('\n')}` : '✅ 文件修改已完成';
}

function generatedImageSource(item: JsonObject): string | undefined {
  const status = stringValue(item.status);
  if (item.success === false || item.failure || status === 'failed' || status === 'error') return undefined;
  const savedPath = stringValue(item.savedPath);
  if (savedPath) return savedPath;
  const result = stringValue(item.result);
  return result && /^(?:https?:\/\/|data:image\/)/.test(result) ? result : undefined;
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join('\n');
  if (isObject(value)) {
    const text = stringValue(value.text) ?? stringValue(value.message);
    if (text) return text;
  }
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

function pick(value: JsonObject, keys: readonly string[]): JsonObject {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

function objectValue(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
