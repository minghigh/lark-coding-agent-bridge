import { deepMaskEmails } from './mask-email';
import type { Block, RunState, ToolEntry } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const MAX_VISIBLE_TOOLS = 12;
const TIMELINE_PAGE_MAX_BYTES = 20_000;
const TIMELINE_CHUNK_MAX_BYTES = 4_000;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  agentName?: string;
  timeline?: boolean;
  answerOnlyText?: string;
}

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  if (options.answerOnlyText !== undefined) return cardEnvelope(state, [markdown(options.answerOnlyText)]);
  if (options.timeline) {
    const hasProcess = state.blocks.some((block) => block.kind === 'tool' || !!block.content.trim());
    const pages = timelinePages(state);
    return cardEnvelope(state, [
      ...(hasProcess || state.terminal === 'running' ? [timelinePanel(state, pages[0] ?? [], 1, pages.length)] : []),
      ...(state.terminal === 'running' ? [stopButton(options)] : []),
    ]);
  }
  const toolCount = state.blocks.filter((block) => block.kind === 'tool').length;
  const status = state.terminal === 'running' ? '处理中' : state.terminal === 'done' ? '已完成' : '已结束';
  const elements: object[] = [
    markdown(`**${options.agentName ?? '任务'} · ${status}**${toolCount ? `  ·  ${toolCount} 次工具调用` : ''}`),
    { tag: 'hr' },
  ];

  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else {
      elements.push(...renderToolGroup(group.tools));
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  }

  if (state.terminal === 'running') {
    elements.push(stopButton(options));
  }

  return cardEnvelope(state, elements);
}

/** Remaining process pages are sent as Feishu cards before the final answer. */
export function renderTimelineOverflowCards(state: RunState): object[] {
  const pages = timelinePages(state);
  return pages.slice(1).map((entries, index) =>
    cardEnvelope(state, [timelinePanel(state, entries, index + 2, pages.length)]));
}

/** Plain-message fallback for a page rejected by Feishu card delivery. */
export function renderTimelinePageText(card: object): string {
  const body = (card as { body?: { elements?: unknown[] } }).body;
  const read = (element: unknown): string[] => {
    if (!element || typeof element !== 'object') return [];
    const item = element as {
      tag?: string;
      content?: string;
      header?: { title?: { content?: string } };
      elements?: unknown[];
    };
    if (item.tag === 'markdown') return item.content ? [item.content] : [];
    return [item.header?.title?.content ?? '', ...(item.elements ?? []).flatMap(read)].filter(Boolean);
  };
  return (body?.elements ?? []).flatMap(read).join('\n\n');
}

function cardEnvelope(state: RunState, elements: object[]): object {
  // Mask raw emails so the Feishu tenant audit accepts streamed cards.
  return deepMaskEmails({
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  });
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'reasoning') continue;
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function timelinePanel(state: RunState, elements: object[], page: number, total: number): object {
  const elapsed = state.elapsedMs === undefined ? '' : ` for ${formatElapsed(state.elapsedMs)}`;
  return {
    tag: 'collapsible_panel',
    expanded: state.terminal === 'running',
    header: panelHeader(`${state.terminal === 'running' ? 'Working' : 'Worked'}${elapsed}${total > 1 ? ` · ${page}/${total}` : ''}`),
    vertical_spacing: '8px',
    padding: '0px',
    elements: elements.length ? elements : [markdown('_正在处理…_')],
  };
}

function timelinePages(state: RunState): object[][] {
  const elements = state.blocks.flatMap((block) => {
    if (block.kind === 'tool') return timelineTool(block.tool);
    return splitByBytes(block.content, TIMELINE_CHUNK_MAX_BYTES)
      .filter((part) => part.trim())
      .map(markdown);
  });
  if (state.terminal === 'error' && state.errorMsg) elements.push(markdown(`⚠️ ${state.errorMsg}`));
  if (state.terminal === 'interrupted') elements.push(markdown('⏹ 已中断'));
  if (state.terminal === 'idle_timeout') elements.push(markdown('⏱ 无响应，已终止'));
  const pages: object[][] = [[]];
  let size = 600;
  for (const element of elements) {
    const bytes = Buffer.byteLength(JSON.stringify(element));
    if (size + bytes > TIMELINE_PAGE_MAX_BYTES && pages.at(-1)!.length) {
      pages.push([]);
      size = 600;
    }
    pages.at(-1)!.push(element);
    size += bytes;
  }
  return pages;
}

function timelineTool(tool: ToolEntry): object[] {
  const icon = tool.status === 'error' ? '❌' : tool.status === 'running' ? '⏳' :
    tool.name === 'command_execution' || tool.name === 'Bash' ? '⌘' :
      tool.name === 'apply_patch' || tool.name === 'Edit' || tool.name === 'Write' ? '✏️' :
        tool.name === 'Read' ? '📖' : '✅';
  const terminal = tool.name === 'command_execution' || tool.name === 'Bash';
  const name = ({ Bash: '终端', Read: '读取文件', Edit: '修改文件', Write: '写入文件',
    Grep: '搜索内容', Glob: '查找文件' } as Record<string, string>)[tool.name];
  const header = toolHeaderText(tool)
    .replace(/^(?:✅|❌|⏳)\s*/, `${icon} `)
    .replace(`**${tool.name}**`, `**${name ?? tool.name}**`);
  const divider = header.indexOf(' — ');
  const styledHeader = terminal && divider >= 0
    ? `${header.slice(0, divider)} · \`${header.slice(divider + 3).replace(/`/g, '\\`')}\``
    : header;
  const input = tool.input && typeof tool.input === 'object'
    ? tool.input as Record<string, unknown> : {};
  const command = typeof input.command === 'string' ? input.command : undefined;
  const inputText = command ?? (Object.keys(input).length ? JSON.stringify(input, null, 2) : '');
  const inputParts = splitByBytes(inputText, TIMELINE_CHUNK_MAX_BYTES)
    .map((part) => `**调用**\n\`\`\`text\n${escapeFence(part)}\n\`\`\``);
  const outputParts = splitByBytes(tool.output ?? '', TIMELINE_CHUNK_MAX_BYTES)
    .map((part) => `**输出**\n\`\`\`text\n${escapeFence(part)}\n\`\`\``);
  const body = [...inputParts, ...outputParts];
  if (body.length === 2 && Buffer.byteLength(body.join('\n\n')) < 6_000) {
    body.splice(0, 2, body.join('\n\n'));
  }
  if (!body.length) body.push(tool.status === 'running' ? '_运行中…_' : '_无输出_');
  return body.map((part, index) => ({
    tag: 'collapsible_panel',
    expanded: tool.status === 'running',
    header: panelHeader(`${styledHeader}${body.length > 1 ? ` · ${index + 1}/${body.length}` : ''}`),
    vertical_spacing: '8px',
    padding: '0px',
    elements: [markdown(part)],
  }));
}

function escapeFence(content: string): string {
  return content.replace(/\`\`\`/g, '\`\`\\\`');
}

function splitByBytes(content: string, maxBytes: number): string[] {
  if (!content) return [];
  const parts: string[] = [];
  let part = '';
  let bytes = 0;
  for (const char of content) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes && part) {
      parts.push(part);
      part = '';
      bytes = 0;
    }
    part += char;
    bytes += charBytes;
  }
  if (part) parts.push(part);
  return parts;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function renderToolGroup(tools: ToolEntry[]): object[] {
  if (tools.length === 0) return [];
  const earlier = tools.slice(0, -MAX_VISIBLE_TOOLS);
  const recent = tools.slice(-MAX_VISIBLE_TOOLS);
  return [
    ...(earlier.length ? [collapsedToolSummary(earlier)] : []),
    ...recent.map((tool) => toolPanel(tool, tool.status !== 'done')),
  ];
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

/**
 * Summarize older calls once the card would otherwise become too large.
 *
 * Keeping older bodies would eventually exceed Feishu's card size limit.
 */
function collapsedToolSummary(tools: ToolEntry[]): object {
  const title = `📂 **较早的 ${tools.length} 次工具调用 · 仅摘要**`;
  const headerList = truncate(tools.map((t) => `- ${toolHeaderText(t)}`).join('\n'), 2500);
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList }],
  };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return markdown(content);
}

function stopButton(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value }],
  };
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
