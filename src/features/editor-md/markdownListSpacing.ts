// NoteBoard 列表项间距（紧凑 / 宽松）
// Markdown 中列表项之间空一行即"宽松列表"：标准渲染器会把各项包进段落，项间距更大。
// 官方序列化总是紧凑输出，宽松列表一进入可视化就被合并空行。这里在解析时记住原文写法，
// 序列化时按记录写回，并在可视化编辑器中以更大的项间距呈现；用户可通过块把手菜单切换。

import { BulletList, OrderedList, TaskList } from '@tiptap/extension-list';
import type {
  JSONContent,
  MarkdownLexerConfiguration,
  MarkdownParseHelpers,
  MarkdownParseResult,
  MarkdownRendererHelpers,
  MarkdownToken,
  MarkdownTokenizer,
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
  return { ...node, attrs: { ...node.attrs, spacing } };
}

/** 按项间距连接各项：宽松列表项之间空一行 */
function renderListItems(node: JSONContent, helpers: MarkdownRendererHelpers): string {
  if (!node.content) return '';
  return helpers.renderChildren(node.content, node.attrs?.spacing === 'loose' ? '\n\n' : '\n');
}

type ParentParse = (token: MarkdownToken, helpers: MarkdownParseHelpers) => MarkdownParseResult;

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
