import { deepMaskEmails } from './mask-email';
import type { Block, RunState, ToolEntry } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const MAX_VISIBLE_TOOLS = 12;

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
}

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  if (options.timeline) {
    return cardEnvelope(state, [
      timelinePanel(state),
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

function timelinePanel(state: RunState): object {
  const status = state.terminal === 'running' ? '进行中' :
    state.terminal === 'done' ? '已完成' :
      state.terminal === 'error' ? '出错' : '已结束';
  const elapsed = state.elapsedMs === undefined ? '' : ` · ${formatElapsed(state.elapsedMs)}`;
  const entries = state.blocks.flatMap((block) => {
    if (block.kind === 'tool') return [timelineTool(block.tool)];
    const content = block.content.trim();
    return content ? [truncate(content, 1400)] : [];
  });
  if (state.terminal === 'error' && state.errorMsg) entries.push(`⚠️ ${state.errorMsg}`);
  if (state.terminal === 'interrupted') entries.push('⏹ 已中断');
  if (state.terminal === 'idle_timeout') entries.push('⏱ 无响应，已终止');
  const recent: string[] = [];
  let length = 0;
  for (const entry of entries.slice(-24).reverse()) {
    if (length + entry.length > 14000) break;
    recent.unshift(entry);
    length += entry.length;
  }
  const omitted = entries.length - recent.length;
  const content = [
    ...(omitted ? [`_较早的 ${omitted} 项过程已省略_`] : []),
    ...recent,
  ].join('\n\n') || '_正在处理…_';
  return {
    tag: 'collapsible_panel',
    expanded: state.terminal === 'running',
    header: panelHeader(`🧠 **工作过程 · ${status}${elapsed}**`),
    border: { color: state.terminal === 'error' ? 'red' : 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '12px 12px 12px 12px',
    elements: [markdown(content)],
  };
}

function timelineTool(tool: ToolEntry): string {
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
  const output = tool.output?.trim();
  if (!output || (!terminal && tool.name !== 'apply_patch' && tool.status !== 'error')) return styledHeader;
  const preview = truncate(output, 700);
  if (terminal) {
    return `${styledHeader}\n\`\`\`text\n${preview.replace(/\`\`\`/g, '\`\`\\\`')}\n\`\`\`${output.length > 700 ? '\n_输出较长，已省略后续内容_' : ''}`;
  }
  return `${styledHeader}\n${preview}${output.length > 700 ? '\n_输出较长，已省略后续内容_' : ''}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
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
