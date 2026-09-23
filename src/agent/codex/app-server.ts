import WebSocket from 'ws';
import { log } from '../../core/logger';
import type { SandboxMode } from '../../config/profile-schema';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../types';

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
}

const DEFAULT_REASONING_EFFORT = 'xhigh';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

type AppServerRunOptions = AgentRunOptions & { developerInstructions?: string };

/** JSON-RPC client for one local Codex app-server WebSocket endpoint. */
export class CodexAppServer {
  private readonly url: string;
  private readonly reasoningEffort: string;
  private readonly requestTimeoutMs: number;
  private socket: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly runs = new Map<string, RunState>();

  constructor(
    url: string,
    reasoningEffort = DEFAULT_REASONING_EFFORT,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.url = url;
    this.reasoningEffort = reasoningEffort;
    this.requestTimeoutMs = requestTimeoutMs;
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
      const turn = await this.request('turn/start', {
        threadId,
        cwd: opts.cwd,
        ...(opts.model ? { model: opts.model } : {}),
        effort: this.reasoningEffort,
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
        if (delta) active.run.queue.push({ type: 'thinking', delta });
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
        if (!item || !isCommandItem(item)) return;
        const id = stringValue(item.id);
        if (!id) return;
        active.run.tools.set(id, '');
        active.run.queue.push({
          type: 'tool_use',
          id,
          name: 'command_execution',
          input: { command: stringValue(item.command) ?? '' },
        });
        return;
      }
      case 'item/commandExecution/outputDelta': {
        const id = stringValue(params.itemId);
        const delta = stringValue(params.delta);
        if (id && delta) active.run.tools.set(id, `${active.run.tools.get(id) ?? ''}${delta}`);
        return;
      }
      case 'item/completed': {
        const item = objectValue(params.item);
        if (!item) return;
        if (isCommandItem(item)) {
          const id = stringValue(item.id);
          if (!id) return;
          const exitCode = numberValue(item.exitCode ?? item.exit_code);
          const status = stringValue(item.status);
          active.run.queue.push({
            type: 'tool_result',
            id,
            output:
              stringValue(item.aggregatedOutput ?? item.output) ?? active.run.tools.get(id) ?? '',
            isError: exitCode !== undefined ? exitCode !== 0 : status === 'failed' || status === 'error',
          });
          active.run.tools.delete(id);
          return;
        }
        if (isAgentMessageItem(item)) {
          const id = stringValue(item.id);
          const text = stringValue(item.text);
          if (text && item.phase === 'final_answer') {
            active.run.queue.push({ type: 'final_text', content: text });
          } else if (text && (!id || !active.run.agentMessages.has(id))) {
            active.run.queue.push({ type: 'text', delta: text });
          }
          if (id) active.run.agentMessagePhases.delete(id);
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
