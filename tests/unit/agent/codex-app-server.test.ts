import { describe, expect, it, vi } from 'vitest';
import { CodexAppServer } from '../../../src/agent/codex/app-server.js';
import type { AgentRunOptions } from '../../../src/agent/types.js';

type TestRun = {
  threadId?: string;
  turnId?: string;
  stopped: boolean;
  run: {
    closed: boolean;
    queue: { push(value: unknown): void; close(): void };
    resolveDone(): void;
    tools: Map<string, string>;
    agentMessages: Set<string>;
    agentMessagePhases: Map<string, string>;
  };
};

function testRun(
  push = vi.fn(),
  turnId = 'turn-1',
): { active: TestRun; push: ReturnType<typeof vi.fn> } {
  return {
    push,
    active: {
      threadId: 'thread-1',
      turnId,
      stopped: false,
      run: {
        closed: false,
        queue: { push, close: vi.fn() },
        resolveDone: vi.fn(),
        tools: new Map(),
        agentMessages: new Set(),
        agentMessagePhases: new Map(),
      },
    },
  };
}

describe('Codex app-server event mapping', () => {
  it('preserves the completed final_answer after its streamed delta', () => {
    const { active, push } = testRun();
    active.run.agentMessages.add('message-1');
    active.run.agentMessagePhases.set('message-1', 'final_answer');
    const appServer = new CodexAppServer('ws://unused') as unknown as {
      runs: Map<string, TestRun>;
      handleNotification(method: string, params: Record<string, unknown>): void;
    };
    appServer.runs.set('thread-1', active);

    appServer.handleNotification('item/agentMessage/delta', {
      threadId: 'thread-1',
      itemId: 'message-1',
      delta: 'final answer',
    });
    appServer.handleNotification('item/completed', {
      threadId: 'thread-1',
      item: {
        id: 'message-1',
        type: 'agentMessage',
        phase: 'final_answer',
        text: 'final answer',
      },
    });

    expect(push.mock.calls).toEqual([[{ type: 'final_text', content: 'final answer' }]]);
  });

  it('ignores notifications from another turn on the same thread', () => {
    const { active, push } = testRun();
    const appServer = new CodexAppServer('ws://unused') as unknown as {
      runs: Map<string, TestRun>;
      handleNotification(method: string, params: Record<string, unknown>): void;
    };
    appServer.runs.set('thread-1', active);

    appServer.handleNotification('item/reasoning/textDelta', {
      threadId: 'thread-1',
      turnId: 'turn-from-another-client',
      delta: 'not ours',
    });

    expect(push).not.toHaveBeenCalled();
  });

  it('reports a failed turn as an error instead of successful completion', () => {
    const { active, push } = testRun();
    const appServer = new CodexAppServer('ws://unused') as unknown as {
      runs: Map<string, TestRun>;
      handleNotification(method: string, params: Record<string, unknown>): void;
    };
    appServer.runs.set('thread-1', active);

    appServer.handleNotification('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: { message: 'model failed' },
      },
    });

    expect(push).toHaveBeenCalledWith({
      type: 'error',
      message: 'model failed',
      terminationReason: 'failed',
    });
  });

  it('sends bridge instructions separately and passes images as localImage input', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const appServer = new CodexAppServer('ws://unused') as unknown as {
      ensureConnected(): Promise<void>;
      request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
      run(opts: AgentRunOptions & { developerInstructions?: string }): unknown;
    };
    appServer.ensureConnected = vi.fn().mockResolvedValue(undefined);
    appServer.request = vi.fn(async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      return {};
    });

    appServer.run({
      runId: 'run-1',
      cwd: '/workspace',
      prompt: 'line one\nline two',
      images: ['/cache/photo.png'],
      developerInstructions: 'bridge rules',
    });

    await vi.waitFor(() => expect(calls.some((call) => call.method === 'turn/start')).toBe(true));
    expect(calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({
      developerInstructions: 'bridge rules',
    });
    expect(calls.find((call) => call.method === 'turn/start')?.params.input).toEqual([
      { type: 'text', text: 'line one\nline two', text_elements: [] },
      { type: 'localImage', path: '/cache/photo.png' },
    ]);
  });

  it('times out unanswered app-server requests', async () => {
    const Server = CodexAppServer as unknown as new (
      url: string,
      effort: string,
      requestTimeoutMs: number,
    ) => CodexAppServer;
    const appServer = new Server('ws://unused', 'xhigh', 10) as unknown as {
      socket: { readyState: number; send(body: string, callback: (error?: Error) => void): void };
      request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    appServer.socket = {
      readyState: 1,
      send: (_body, callback) => callback(),
    };

    const missingTimeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('request did not time out')), 100);
    });
    await expect(Promise.race([appServer.request('turn/start', {}), missingTimeout])).rejects.toThrow(
      'timed out',
    );
  });
});
