// NoteBoard 列表原始缩进与项间距（紧凑 / 宽松）
// Markdown 中列表项之间空一行即"宽松列表"：标准渲染器会把各项包进段落，项间距更大。
// 官方序列化总是紧凑输出，宽松列表一进入可视化就被合并空行。这里在解析时记住原文写法，
// 序列化时按记录写回，并在可视化编辑器中以更大的项间距呈现；用户可通过块把手菜单切换。

import { BulletList, OrderedList, TaskList, ORDERED_LIST_MARKER_PATTERN, parseListMarker } from '@tiptap/extension-list';
import type {
  JSONContent,
  MarkdownLexerConfiguration,
  MarkdownParseHelpers,
  MarkdownParseResult,
  MarkdownRendererHelpers,
  MarkdownToken,
  MarkdownTokenizer,
  RenderContext,
} from '@tiptap/core';

export type ListSpacing = 'tight' | 'loose';

/** 可设置项间距的列表节点 */
export const SPACING_LIST_TYPES: readonly string[] = ['bulletList', 'orderedList', 'taskList'];

// 任务列表项起始行：缩进、无序标记、复选框
const TASK_ITEM_MARKER = /^( *)([-+*])\s+\[[ xX]\]\s/;

// 列表项起始行：无序 / 有序标记后跟空白或行尾
const LIST_ITEM_MARKER = /^( *)(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * 从列表原文识别项间距：同级的任意两项之间有空行即为宽松。
 * 只看与首项同缩进的标记行，嵌套列表、项内多段落之间的空行不计入
 * （marked 的 loose 标志会把"项内多段落"也判为宽松，按它写回会凭空多出项间空行）。
 */
export function detectListSpacing(raw: string): ListSpacing {
  // 去掉首尾空行：任务列表 token 的原文可能以前一块遗留的空行开头，不能算作项间空行
  const lines = raw.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '').split('\n');
  const baseIndent = LIST_ITEM_MARKER.exec(lines[0] ?? '')?.[1].length ?? 0;
  for (let index = 1; index < lines.length; index += 1) {
    const marker = LIST_ITEM_MARKER.exec(lines[index]);
    if (marker && marker[1].length === baseIndent && lines[index - 1].trim() === '') return 'loose';
  }
  return 'tight';
}

/** 列表节点的项间距属性：可视化中以 data-spacing 呈现，支持从 HTML 粘贴还原 */
function spacingAttribute() {
  return {
    // 整个列表的原始前导空白只在容器外层补回，嵌套层由父列表项负责。
    sourceLeadingIndent: { default: '', rendered: false },
    spacing: {
      default: 'tight' as ListSpacing,
      parseHTML: (element: HTMLElement): ListSpacing => (element.getAttribute('data-spacing') === 'loose' ? 'loose' : 'tight'),
      renderHTML: (attributes: Record<string, unknown>) =>
        attributes.spacing === 'loose' ? { 'data-spacing': 'loose' } : {},
    },
  };
}

/** 在父扩展解析结果上记录原文项间距 */
function withSourceSpacing(parsed: MarkdownParseResult | undefined, token: MarkdownToken): MarkdownParseResult {
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || !('type' in parsed)) return parsed ?? [];
  const spacing = typeof token.raw === 'string' ? detectListSpacing(token.raw) : 'tight';
  const node = parsed as JSONContent;
  const items = (token.items as MarkdownToken[] | undefined) ?? [];
  // 任务分词器不提供 item.raw，按同级复选框边界从列表原文补回，嵌套任务不会误分组。
  const taskRaws: string[] = [];
  if (node.type === 'taskList' && typeof token.raw === 'string') {
    const lines = token.raw.replace(/^(?:[ \t]*\n)+/, '').split('\n');
    const base = TASK_ITEM_MARKER.exec(lines[0])?.[1].length;
    for (const line of lines) {
      if (TASK_ITEM_MARKER.exec(line)?.[1].length === base) taskRaws.push(line);
      else if (taskRaws.length > 0) taskRaws[taskRaws.length - 1] += `\n${line}`;
    }
  }
  return {
    ...node,
    attrs: { ...node.attrs, spacing, sourceLeadingIndent: /^[ \t]*/.exec(String(token.raw ?? '').replace(/^(?:[ \t]*\n)+/, ''))?.[0] ?? '' },
    content: node.content?.map((item, index) => {
      const source = items[index];
      if (item.type !== 'taskItem' || !source) return withSourceItemIndent(item, source);
      return withSourceItemIndent(item, {
        ...source,
        raw: taskRaws[index] ?? source.raw,
        tokens: [
          { type: 'paragraph', raw: String(source.mainContent ?? source.text ?? '') },
          ...((source.nestedTokens as MarkdownToken[] | undefined) ?? []),
        ],
      });
    }),
  };
}

/**
 * 将原列表项的容器缩进记录为格式属性，保留 2 / 3 / 4 格等已有写法。
 * 按直接子块在原文中的起点记录，代码块内部缩进不计入容器宽度；
 * 首段续行只记录解析时移除的前缀，额外的正文空白仍由文本节点保存。
 */
function withSourceItemIndent(node: JSONContent, token: MarkdownToken | undefined): JSONContent {
  if (!token?.raw || !['listItem', 'taskItem'].includes(node.type ?? '')) return node;
  const lines = token.raw.split('\n');
  const marker = /^([ \t]*)(?:[-+*](?:[ \t]+\[[ xX]\])?|(?:\d+|[a-zA-Z]+)[.)])[ \t]+/.exec(lines[0]);
  if (!marker) return node;
  const base = marker[1].length;
  const width = typeof token.sourceContentIndent === 'number' ? token.sourceContentIndent : marker[0].length - base;
  const parts = (token.tokens ?? []).filter((part) => part.type !== 'space');
  const continuation = (parts[0]?.raw ?? '').replace(/\n+$/, '').split('\n').slice(1).map((_, index) => {
    const indent = /^[ \t]*/.exec(lines[index + 1] ?? '')?.[0] ?? '';
    // 保存实际字符，制表符不能被当成一个空格再写回。
    return indent.slice(base, base + width);
  });
  const indents: Array<string | null> = [null];
  let cursor = 1;
  for (const part of parts.slice(1)) {
    const firstLine = (part.raw ?? '').split('\n').find((line) => line.trim() !== '')?.trimStart();
    // 从上一个子块之后继续扫描，避免多段落列表反复从头查找而退化为平方复杂度。
    let start = cursor;
    while (start < lines.length && lines[start].trimStart() !== firstLine) start += 1;
    if (firstLine === undefined || start >= lines.length) start = -1;
    if (start < 0) {
      // 单独收集的嵌套有序列表不包含在父 item.raw 中，使用其原始起点计算相对缩进。
      const nestedIndent = /^[ \t]*/.exec(part.raw ?? '')?.[0] ?? '';
      indents.push(part.type === 'list' && nestedIndent.length > base ? nestedIndent.slice(base) : null);
      continue;
    }
    const indent = /^[ \t]*/.exec(lines[start])?.[0] ?? '';
    // 缩进代码的额外 4 格属于代码语法；转换为围栏时不能当成列表容器缩进再次添加。
    const codeIndent = part.type === 'code' && part.codeBlockStyle === 'indented' ? 4 : 0;
    indents.push(indent.slice(base, Math.max(base, indent.length - codeIndent)));
    cursor = start + 1;
  }
  return {
    ...node,
    attrs: { ...node.attrs, sourceIndent: indents, sourceContinuationIndents: continuation },
  };
}

/** 按项间距连接各项：宽松列表项之间空一行 */
function renderListItems(node: JSONContent, helpers: MarkdownRendererHelpers, context?: RenderContext): string {
  if (!node.content) return '';
  const rendered = helpers.renderChildren(node.content, node.attrs?.spacing === 'loose' ? '\n\n' : '\n');
  const leading = String(node.attrs?.sourceLeadingIndent ?? '');
  return leading && !['listItem', 'taskItem'].includes(context?.parentType ?? '')
    ? rendered.split('\n').map((line) => leading + line).join('\n') : rendered;
}

type ParentParse = (token: MarkdownToken, helpers: MarkdownParseHelpers) => MarkdownParseResult;

/** 有序列表入口沿用官方支持的数字/字母标记，仅提前排除普通正文，避免逐段拆分全文。 */
const baseOrderedTokenizer = OrderedList.config.markdownTokenizer as MarkdownTokenizer | undefined;

// 沿用数字、字母及罗马数字标记；标记后的空白是列表容器前缀的一部分。
const ORDERED_ITEM = new RegExp(`^([ \\t]*)(${ORDERED_LIST_MARKER_PATTERN})[.)][ \\t]+(.*)$`);
// 无缩进且可中断段落的块不能被当作当前列表项的懒续行。
const LIST_PARAGRAPH_INTERRUPTER = /^(?:#{1,6}(?:\s|$)|[-+*](?:\s|$)|>|`{3,}|~{3,}|\$\$|(?:_[ \t]*){3,}$)/;

/**
 * 按需切行：结果与 `src.split('\n')` 一致，但只切到实际读取的行。
 * 分词器收到的 src 是剩余全文，每个列表都整体拆分会让大文档退化为平方复杂度。
 */
function createLazyLines(src: string): { lines: string[]; has: (index: number) => boolean } {
  const lines: string[] = [];
  let offset = 0;
  const has = (index: number): boolean => {
    while (lines.length <= index && offset <= src.length) {
      const end = src.indexOf('\n', offset);
      const lineEnd = end < 0 ? src.length : end;
      lines.push(src.slice(offset, lineEnd));
      offset = lineEnd + 1;
    }
    return index < lines.length;
  };
  return { lines, has };
}

/**
 * 按列表项边界收集原文，再仅移除容器前缀后解析正文。
 * 保留旧文档的两格子列表；围栏内的 `1.` / `a.` 是代码，不能另拆为列表；
 * 正文不做 trim，防止代码首尾空白被吞掉。嵌套内容由同一块解析器递归处理。
 */
function tokenizeOrderedList(src: string, lexer: MarkdownLexerConfiguration): MarkdownToken | undefined {
  const { lines, has } = createLazyLines(src);
  has(0);
  const first = ORDERED_ITEM.exec(lines[0]);
  if (!first) return undefined;
  const base = first[1].length;
  const items: MarkdownToken[] = [];
  let cursor = 0;
  while (has(cursor)) {
    const marker = ORDERED_ITEM.exec(lines[cursor]);
    if (!marker || marker[1].length !== base) break;
    const start = cursor;
    const prefixWidth = lines[cursor].length - marker[3].length;
    let sawBlank = false;
    let fence: { character: string; length: number } | null = null;
    cursor += 1;
    for (; has(cursor); cursor += 1) {
      const line = lines[cursor];
      const leading = /^[ \t]*/.exec(line)?.[0].length ?? 0;
      const body = line.slice(Math.min(leading, prefixWidth));
      if (fence) {
        const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(body)?.[1];
        if (closing?.[0] === fence.character && closing.length >= fence.length) fence = null;
        continue;
      }
      const next = ORDERED_ITEM.exec(line);
      if (next && next[1].length <= base) break;
      if (line.trim() === '') {
        sawBlank = true;
        continue;
      }
      if (leading <= base && (sawBlank || LIST_PARAGRAPH_INTERRUPTER.test(line.trimStart()))) break;
      // 只在列表容器内识别围栏，反引号围栏的语言不能再含反引号。
      const opening = leading > base ? /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body) : null;
      if (opening && (opening[1][0] === '~' || !opening[2].includes('`'))) {
        fence = { character: opening[1][0], length: opening[1].length };
      }
    }
    const rawLines = lines.slice(start, cursor);
    // 旧文档的容器可能少于编号宽度：同一项各行必须移除相同前缀，不能逐行多减一格而压扁深层列表。
    const bodyIndent = rawLines.slice(1).reduce((width, line) => {
      if (!line.trim()) return width;
      const leading = /^[ \t]*/.exec(line)?.[0].length ?? 0;
      return leading > base ? Math.min(width, leading) : width;
    }, prefixWidth);
    const body = [marker[3], ...rawLines.slice(1).map((line) => {
      const leading = /^[ \t]*/.exec(line)?.[0].length ?? 0;
      return line.slice(Math.min(leading, bodyIndent));
    })].join('\n').replace(/(?:\n[ \t]*)+$/, '');
    const parts = lexer.blockTokens(body);
    // schema 要求首块为段落，空项或以代码等块开头时显式补齐。
    if (!parts[0] || !['paragraph', 'text'].includes(parts[0].type ?? '')) {
      parts.unshift({ type: 'paragraph', raw: '', tokens: [] });
    }
    items.push({ type: 'list_item', raw: rawLines.join('\n'), tokens: parts, sourceContentIndent: bodyIndent - base });
  }
  const marker = parseListMarker(first[2]);
  return { type: 'list', ordered: true, start: marker.start, typeMarker: marker.type, items, raw: lines.slice(0, cursor).join('\n') };
}

export const MarkdownBulletList = BulletList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...spacingAttribute() };
  },
  parseMarkdown(token, helpers) {
    const parentParse = (this as unknown as { parent?: ParentParse }).parent;
    return withSourceSpacing(parentParse?.(token, helpers), token);
  },
  renderMarkdown: renderListItems,
});

export const MarkdownOrderedList = OrderedList.extend({
  markdownTokenizer: baseOrderedTokenizer ? {
    ...baseOrderedTokenizer,
    tokenize(src, tokens, lexer) {
      // 普通正文快速排除，避免为每个段落反复拆分剩余全文。
      if (!/^\s*(?:\d+|[a-zA-Z]+)[.)](?:[ \t]|$)/.test(src)) return undefined;
      return tokenizeOrderedList(src, lexer);
    },
  } : undefined,
  addAttributes() {
    return { ...this.parent?.(), ...spacingAttribute() };
  },
  parseMarkdown(token, helpers) {
    const parentParse = (this as unknown as { parent?: ParentParse }).parent;
    return withSourceSpacing(parentParse?.(token, helpers), token);
  },
  renderMarkdown: renderListItems,
});

const baseTaskTokenizer = TaskList.config.markdownTokenizer as MarkdownTokenizer | undefined;

/**
 * 任务列表分词：官方 tokenizer 遇到项间空行即结束，`- [ ] a\n\n- [ ] b` 会被拆成两个列表
 * （CommonMark 中它是一个宽松列表）。这里在空行后紧跟同缩进、同标记的任务项时继续分词并合并，
 * 合并后的原文含项间空行，由 detectListSpacing 识别为宽松。
 */
function tokenizeTaskList(
  this: unknown,
  src: string,
  tokens: MarkdownToken[],
  lexer: MarkdownLexerConfiguration,
): MarkdownToken | undefined {
  const tokenize = baseTaskTokenizer?.tokenize;
  if (!tokenize) return undefined;
  // 这里只做与官方入口一致的快速排除，制表符缩进等合法输入仍由原 tokenizer 决定。
  if (!/^\s*[-+*]\s+\[[ xX]\]\s+/.test(src)) return undefined;
  const first = tokenize.call(this, src, tokens, lexer) as MarkdownToken | undefined;
  // src 可能以前一块遗留的空行开头，按首个任务项所在行识别标记与缩进
  const firstMarker = TASK_ITEM_MARKER.exec(src.replace(/^(?:[ \t]*\n)+/, ''));
  if (!first || typeof first.raw !== 'string' || !firstMarker) return first;

  let raw = first.raw;
  const items = [...((first.items as MarkdownToken[] | undefined) ?? [])];
  for (;;) {
    const rest = src.slice(raw.length);
    const gap = /^(?:[ \t]*\n)+/.exec(rest);
    if (!gap) break;
    const following = rest.slice(gap[0].length);
    const marker = TASK_ITEM_MARKER.exec(following);
    // 只合并同缩进、同标记的任务项（不同标记在 CommonMark 中属于另一个列表）
    if (!marker || marker[1] !== firstMarker[1] || marker[2] !== firstMarker[2]) break;
    const next = tokenize.call(this, following, tokens, lexer) as MarkdownToken | undefined;
    if (!next || typeof next.raw !== 'string' || !next.raw) break;
    raw += gap[0] + next.raw;
    items.push(...((next.items as MarkdownToken[] | undefined) ?? []));
  }
  return { ...first, raw, items };
}

export const MarkdownTaskList = TaskList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...spacingAttribute() };
  },
  markdownTokenizer: baseTaskTokenizer ? { ...baseTaskTokenizer, tokenize: tokenizeTaskList } : undefined,
  parseMarkdown(token, helpers) {
    const parentParse = (this as unknown as { parent?: ParentParse }).parent;
    return withSourceSpacing(parentParse?.(token, helpers), token);
  },
  renderMarkdown: renderListItems,
});
