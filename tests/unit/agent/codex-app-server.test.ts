import { describe, expect, it, vi } from 'vitest';
import { CodexAppServer } from '../../../src/agent/codex/app-server.js';

describe('Codex app-server event mapping', () => {
  it('preserves the completed final_answer after its streamed delta', () => {
    const push = vi.fn();
    const appServer = new CodexAppServer('ws://unused') as unknown as {
      runs: Map<string, {
        run: {
          closed: boolean;
          queue: { push(value: unknown): void };
          tools: Map<string, string>;
          agentMessages: Set<string>;
          agentMessagePhases: Map<string, string>;
        };
      }>;
      handleNotification(method: string, params: Record<string, unknown>): void;
    };
    appServer.runs.set('thread-1', {
      run: {
        closed: false,
        queue: { push },
          tools: new Map(),
          agentMessages: new Set(['message-1']),
          agentMessagePhases: new Map([['message-1', 'final_answer']]),
      },
    });

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
});
