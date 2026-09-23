import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import {
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { normalizeCard } from '../../helpers/card-normalize.js';

describe('run card renderer snapshots', () => {
  it('renders initial running state', () => {
    expectCard(initialState).toMatchSnapshot();
  });

  it('renders active and completed thinking', () => {
    expectCard(stateFrom([{ type: 'thinking', delta: 'checking options' }])).toMatchSnapshot();
    expectCard(stateFrom([
      { type: 'thinking', delta: 'checking options' },
      { type: 'text', delta: 'final answer' },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders tool running, done, and error states', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/missing.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'ENOENT', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('keeps recent tool details readable and folds completed calls', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-3', output: 'ok', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();

    const card = renderCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'command_execution', input: { command: 'nvidia-smi' } },
      { type: 'tool_result', id: 'tool-1', output: 'GPU idle', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'file content', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
    ]), { agentName: 'Codex' }) as { body: { elements: Array<Record<string, unknown>> } };
    const panels = card.body.elements.filter((element) => element.tag === 'collapsible_panel');
    expect(card.body.elements[0]?.content).toContain('Codex · 处理中');
    expect(panels).toHaveLength(3);
    expect(panels.map((panel) => panel.expanded)).toEqual([false, false, true]);
    expect(JSON.stringify(panels)).toContain('GPU idle');
    expect(JSON.stringify(panels)).not.toContain('text_size');
  });

  it('renders Codex progress in event order inside one foldable timeline', () => {
    const events: AgentEvent[] = [
      { type: 'thinking', delta: '先检查代码。' },
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'src/card.ts' } },
      { type: 'tool_result', id: 'read', output: 'file contents', isError: false },
      { type: 'text', delta: '发现字号过小。' },
      { type: 'tool_use', id: 'test', name: 'command_execution', input: { command: 'vitest run' } },
      { type: 'tool_result', id: 'test', output: '705 tests passed', isError: false },
      { type: 'thinking', delta: '最后确认结果。' },
      { type: 'final_text', content: '这是最终答案。' },
    ];
    const running = renderCard({ ...stateFrom(events), elapsedMs: 42_000 }, {
      agentName: 'Codex', timeline: true,
    }) as { body: { elements: Array<Record<string, unknown>> } };
    const panel = running.body.elements[0] as {
      expanded: boolean;
      header: { title: { content: string } };
      elements: Array<{ content: string }>;
    };
    const content = panel.elements[0]?.content ?? '';
    expect(panel.expanded).toBe(true);
    expect(panel.header.title.content).toBe('Working for 42s');
    expect(panel).not.toHaveProperty('border');
    expect(running.body.elements).toHaveLength(2);
    expect(content.indexOf('先检查代码')).toBeLessThan(content.indexOf('读取文件'));
    expect(content.indexOf('读取文件')).toBeLessThan(content.indexOf('发现字号过小'));
    expect(content.indexOf('发现字号过小')).toBeLessThan(content.indexOf('`vitest run`'));
    expect(content.indexOf('`vitest run`')).toBeLessThan(content.indexOf('最后确认结果'));
    expect(content).toContain('705 tests passed');
    expect(content).not.toContain('这是最终答案');

    const done = renderCard({ ...stateFrom([...events, { type: 'done', terminationReason: 'normal' }]), elapsedMs: 42_000 }, {
      agentName: 'Codex', timeline: true,
    }) as { body: { elements: Array<{ expanded: boolean; content?: string; header?: { title: { content: string } } }> } };
    expect(done.body.elements).toHaveLength(3);
    expect(done.body.elements[0]?.expanded).toBe(false);
    expect(done.body.elements[0]?.header?.title.content).toBe('Worked for 42s');
    expect(done.body.elements[2]?.content).toBe('这是最终答案。');
  });

  it('renders done, error, interrupted, and idle-timeout terminal states', () => {
    expectCard(stateFrom([{ type: 'done', terminationReason: 'normal' }])).toMatchSnapshot();
    expectCard(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }])).toMatchSnapshot();
    expectCard(markInterrupted(stateFrom([{ type: 'text', delta: 'partial' }]))).toMatchSnapshot();
    expectCard(markIdleTimeout(stateFrom([{ type: 'text', delta: 'partial' }]), 15)).toMatchSnapshot();
  });

  it('renders markdown text mode without card-only controls', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'hidden reasoning' },
      { type: 'text', delta: 'Answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'text', delta: 'Done' },
    ]);

    expect(renderText(state)).toMatchSnapshot();
    expect(renderText(markInterrupted(state))).toMatchSnapshot();
    expect(renderText(markIdleTimeout(state, 10))).toMatchSnapshot();
    expect(renderText(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }]))).toMatchSnapshot();
  });

  it('injects signed bridge callback values for managed run controls', () => {
    const card = renderCard(initialState, {
      signCallback: (action) => `token-for-${action}`,
    }) as {
      body?: { elements?: Array<{ tag?: string; behaviors?: Array<{ value?: Record<string, unknown> }> }> };
    };
    const button = card.body?.elements?.find((element) => element.tag === 'button');

    expect(button?.behaviors?.[0]?.value).toEqual({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: 'token-for-stop',
    });
  });

  it('keeps local paths in user-visible cards and text fallbacks', () => {
    const sensitivePath = '/Users/example/private/customer/repo/secret.txt';
    const state = stateFrom([
      { type: 'text', delta: `I read ${sensitivePath}` },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: sensitivePath } },
      { type: 'tool_result', id: 'tool-1', output: `content from ${sensitivePath}`, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const card = JSON.stringify(renderCard(state));
    const text = renderText(state);
    expect(card).toContain(sensitivePath);
    expect(text).toContain(sensitivePath);
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

function expectCard(state: RunState) {
  return expect(normalizeCard(renderCard(state)));
}
