// 共享文档规则：后台解析与主线程使用同一份定义，禁止引入界面、store 或原生 API。
import { Node, mergeAttributes } from '@tiptap/core';
import { createIndexedBlockStart } from './markdownBlockStart';
import { emitRawSegment } from './rawMarkdownSegments';

/** 新插入折叠块的默认标题 */
export const DEFAULT_DETAILS_SUMMARY = '标题';

// 标准写法首部：`<details>` 或 `<details open>` 独占一行，下一行为单行 <summary>，随后是一个空行
// （空行允许含空白：列表内序列化会给空行补缩进）
export const DETAILS_HEAD_PATTERN = /^<details( open)?>\n<summary>([^\n]*?)<\/summary>\n[ \t]*\n/;

export const DETAILS_START_PATTERN = /(?:^|\n)<details(?: open)?>\n<summary>/;

// 嵌套计数：统计行内出现的开始/结束标签（含非标准写法），保证与正确的 </details> 配对
export const DETAILS_OPEN_TAG = /<details[\s>]/gi;

export const DETAILS_CLOSE_TAG = /<\/details\s*>/gi;

// 代码围栏起止：围栏内的 <details> 文本不参与配对
export const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/** 标题文本转义：只处理会破坏 HTML 结构的字符 */
export function escapeSummary(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 还原标题中的基本实体 */
export function decodeSummary(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 统计一行中某类标签的出现次数 */
export function countMatches(line: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return line.match(pattern)?.length ?? 0;
}

/** 判断某行是否闭合了给定的代码围栏（同字符、长度不短于开启围栏） */
export function closesFence(line: string, fence: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence[0] && match[1].length >= fence.length);
}

/** 标准写法折叠块的分析结果 */
export interface DetailsMatch {
  raw: string;
  open: boolean;
  summary: string;
  body: string;
}

/**
 * 识别源码开头的标准写法折叠块；不符合标准写法时返回 null（交由 RawHtmlBlock 原样保留）。
 * 导出供测试使用。
 */
export function matchDetailsBlock(src: string): DetailsMatch | null {
  const head = DETAILS_HEAD_PATTERN.exec(src);
  if (!head) return null;
  const summaryRaw = head[2];
  // 标题必须是可无损往返的纯文本（含 <b> 等标签或非常规实体时不接管）
  if (escapeSummary(decodeSummary(summaryRaw)) !== summaryRaw) return null;

  const lines = src.split('\n');
  // lines[0] = <details>，lines[1] = <summary>，lines[2] = 空行，正文从第 3 行开始
  let depth = 0;
  let fence: string | null = null;
  let closeIndex = -1;
  for (let index = 3; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const fenceOpen = FENCE_OPEN_PATTERN.exec(line);
    if (fenceOpen) {
      fence = fenceOpen[1];
      continue;
    }
    // 同层的结束标签必须独占一行且无缩进、无多余空白
    if (depth === 0 && line === '</details>') {
      closeIndex = index;
      break;
    }
    depth += countMatches(line, DETAILS_OPEN_TAG) - countMatches(line, DETAILS_CLOSE_TAG);
    // 出现多余的结束标签说明结构不是标准写法
    if (depth < 0) return null;
  }
  if (closeIndex < 0) return null;
  // 结束标签后必须是空行或文末，否则 CommonMark 会把后续文字并入同一 HTML 块
  if (closeIndex + 1 < lines.length && lines[closeIndex + 1].trim() !== '') return null;

  const between = lines.slice(3, closeIndex);
  let body = '';
  if (between.length > 0) {
    // 非空正文与结束标签之间必须恰有一个空行
    if (between.length < 2 || between[between.length - 1].trim() !== '') return null;
    body = between.slice(0, -1).join('\n');
    if (body.trim() === '') return null;
  }

  const raw = lines.slice(0, closeIndex + 1).join('\n') + (closeIndex + 1 < lines.length ? '\n' : '');
  return { raw, open: Boolean(head[1]), summary: decodeSummary(summaryRaw), body };
}

/** 生成标准写法的首部两行 */
export function renderDetailsHead(open: boolean, summary: string): string {
  return `<details${open ? ' open' : ''}>\n<summary>${escapeSummary(summary)}</summary>`;
}

/** DetailsBlock 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const DetailsBlockCore = Node.create({
  name: 'detailsBlock',
  group: 'block',
  content: 'block+',
  selectable: true,
  defining: true,

  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      summary: { default: DEFAULT_DETAILS_SUMMARY, rendered: false },
      // 源码中的 open 属性：只用于原样往返与初始展开，不随界面展开/收起变化
      open: { default: false, rendered: false },
    };
  },

  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [
      {
        tag: 'details',
        getAttrs: (dom) => {
          const element = dom as HTMLElement;
          const summary = element.querySelector(':scope > summary')?.textContent ?? '';
          return { summary: summary.replace(/\s+/g, ' ').trim(), open: element.hasAttribute('open') };
        },
        contentElement: (dom) => (dom as HTMLElement).querySelector(':scope > [data-details-content]') ?? (dom as HTMLElement),
      },
      // 标题已作为属性读取，粘贴外部 HTML 时不再当作正文段落
      { tag: 'details > summary', ignore: true },
    ];
  },

  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ node, HTMLAttributes }) {
    return [
      'details',
      mergeAttributes(HTMLAttributes, node.attrs.open ? { open: '' } : {}),
      ['summary', String(node.attrs.summary ?? '')],
      ['div', { 'data-details-content': '' }, 0],
    ];
  },

  // 块级 tokenizer：优先于 marked 内置 html 块识别标准写法
  markdownTokenizer: {
    name: 'detailsBlock',
    level: 'block',
    start: createIndexedBlockStart(DETAILS_START_PATTERN),
    tokenize: (src, _tokens, lexer) => {
      const match = matchDetailsBlock(src);
      if (!match) return undefined;
      const tokens = match.body ? lexer.blockTokens(match.body) : [];
      // 位于列表内时 marked 以"非顶层"状态解析，段落会成为块级 text token；
      // 正文应按顶层块处理（与 marked 处理引用块一致），原地改为段落以保留稍后填充的行内 token
      for (const token of tokens) {
        if (token.type === 'text' && Array.isArray(token.tokens)) token.type = 'paragraph';
      }
      return {
        type: 'detailsBlock',
        raw: match.raw,
        text: match.body,
        open: match.open,
        summary: match.summary,
        tokens,
      };
    },
  },

  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown: (token, helpers) => {
    const parseBlocks = helpers.parseBlockChildren ?? helpers.parseChildren;
    const children = parseBlocks(token.tokens || []);
    // 节点内容约束为 block+，空正文补一个空段落
    return helpers.createNode(
      'detailsBlock',
      { summary: String(token.summary ?? ''), open: Boolean(token.open) },
      children.length > 0 ? children : [{ type: 'paragraph' }],
    );
  },

  // 序列化为标准写法；首尾标签走原样片段，避免实体还原等全文后处理误改标题中的 &amp;
  renderMarkdown: (node, helpers) => {
    const head = emitRawSegment(renderDetailsHead(Boolean(node.attrs?.open), String(node.attrs?.summary ?? '')));
    const tail = emitRawSegment('</details>');
    const body = node.content ? helpers.renderChildren(node.content, '\n\n') : '';
    return body.trim() === '' ? `${head}\n\n${tail}` : `${head}\n\n${body}\n\n${tail}`;
  }
});
