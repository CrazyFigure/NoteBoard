// NoteBoard 段落 / 标题的对齐与缩进
// Markdown 没有对齐与缩进语法，沿用 GitHub README 常见的「HTML div 块 + 空行包裹 Markdown」写法：
//
//   <div align="center" style="margin-left: 2em">
//
//   段落或标题（任意行内 Markdown）
//
//   </div>
//
// - align：center / right；左对齐是默认值，不写属性。GitHub 识别 align，可正常居中 / 右对齐；
// - style：缩进层级 × 2em，过滤 style 的平台（GitHub）退化为不缩进，内容不丢失；
// - 两者都是默认值时不包裹，文件与普通段落完全一致。
// 规范化约束：每个 div 只包裹一个段落或标题，且属性顺序、写法固定，保证「解析→序列化」逐字一致；
// 其余手写变体（多块正文、align="left"、其它属性）不识别，继续由 RawHtmlBlock 原样保留，绝不静默改写。

import { Extension, type Editor, type JSONContent, type MarkdownRendererHelpers, type MarkdownToken, type RenderContext } from '@tiptap/core';
import Paragraph from '@tiptap/extension-paragraph';
import Heading from '@tiptap/extension-heading';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createIndexedBlockStart } from './markdownBlockStart';
import { emitRawSegment } from './rawMarkdownSegments';
import { DIV_CLOSE_TAG, readDivBody } from './divBlockSyntax';

export type BlockAlign = 'left' | 'center' | 'right';

/** 最大缩进层级（每级 2em，手机窄屏上 6 级仍留有正文宽度） */
export const MAX_BLOCK_INDENT = 6;
// 每级缩进宽度（em），与导出写法 `margin-left: Nem` 一致
const INDENT_STEP_EM = 2;
// 可承载对齐与缩进的块类型
const FORMATTABLE_TYPES = new Set(['paragraph', 'heading']);
// 位于这些节点内的块不提供对齐与缩进：列表项改用层级缩进，表格单元格只能写行内内容
const UNFORMATTABLE_ANCESTORS = new Set(['listItem', 'taskItem', 'tableCell', 'tableHeader']);
// 空段落写作 `&nbsp;`（官方段落扩展的空段落标记），否则 div 正文为空、对齐信息无处承载
const EMPTY_PARAGRAPH_MARKDOWN = '&nbsp;';

// 开始标签：align、style 各自可选但至少出现一个，随后与标准写法逐字比对
const OPEN_TAG_PATTERN = /^<div(?: align="(center|right)")?(?: style="margin-left: (\d+)em")?>$/;
const START_PATTERN = /(?:^|\n)<div (?:align="(?:center|right)"|style="margin-left: \d+em")/;

/** 规范化对齐属性：非法值与左对齐都视为默认（null） */
function normalizeAlign(value: unknown): 'center' | 'right' | null {
  return value === 'center' || value === 'right' ? value : null;
}

/** 规范化缩进层级：取整并限制在 0 ~ MAX_BLOCK_INDENT */
function normalizeIndent(value: unknown): number {
  const level = Math.floor(Number(value));
  return Number.isFinite(level) ? Math.min(Math.max(level, 0), MAX_BLOCK_INDENT) : 0;
}

/** 生成开始标签（标准写法）；对齐与缩进都是默认值时返回空串，表示无需包裹 */
export function renderBlockFormatOpenTag(align: unknown, indent: unknown): string {
  const alignValue = normalizeAlign(align);
  const level = normalizeIndent(indent);
  if (!alignValue && level === 0) return '';
  const alignAttr = alignValue ? ` align="${alignValue}"` : '';
  const styleAttr = level > 0 ? ` style="margin-left: ${level * INDENT_STEP_EM}em"` : '';
  return `<div${alignAttr}${styleAttr}>`;
}

/** 标准写法格式块的分析结果 */
interface BlockFormatMatch {
  raw: string;
  align: 'center' | 'right' | null;
  indent: number;
  body: string;
}

/**
 * 识别源码开头的标准写法格式块；不符合标准写法时返回 null（交由 RawHtmlBlock 原样保留）。
 * 导出供测试使用。
 */
export function matchBlockFormat(src: string): BlockFormatMatch | null {
  const firstBreak = src.indexOf('\n');
  const head = firstBreak < 0 ? src : src.slice(0, firstBreak);
  const open = OPEN_TAG_PATTERN.exec(head);
  if (!open) return null;
  const align = normalizeAlign(open[1]);
  const em = open[2] === undefined ? 0 : Number(open[2]);
  // 缩进必须是整数层级，且开始标签与标准写法逐字一致（如 `margin-left: 3em` 视为手写 HTML）
  const indent = em / INDENT_STEP_EM;
  if (!Number.isInteger(indent) || indent > MAX_BLOCK_INDENT || head !== renderBlockFormatOpenTag(align, indent)) return null;

  const lines = src.split('\n');
  const parsed = readDivBody(lines, 0);
  if (!parsed || parsed.body.trim() === '') return null;
  const { body, closeIndex } = parsed;
  // 结束标签后必须是空行或文末，否则 CommonMark 会把后续文字并入同一 HTML 块
  if (closeIndex + 1 < lines.length && lines[closeIndex + 1].trim() !== '') return null;

  const raw = lines.slice(0, closeIndex + 1).join('\n') + (closeIndex + 1 < lines.length ? '\n' : '');
  return { raw, align, indent, body };
}

/** 正文是否恰好是一个可承载格式的段落或标题（只含单张图片的段落会被解析成图片块，不算） */
function singleFormattableBlock(tokens: MarkdownToken[]): MarkdownToken | null {
  const blocks = tokens.filter((token) => token.type !== 'space');
  if (blocks.length !== 1) return null;
  const [block] = blocks;
  // 位于列表内时 marked 以"非顶层"状态解析，段落会成为块级 text token，原地改为段落
  if (block.type === 'text' && Array.isArray(block.tokens)) block.type = 'paragraph';
  if (block.type === 'heading') return block;
  if (block.type !== 'paragraph') return null;
  const inline = (block.tokens ?? []) as MarkdownToken[];
  return inline.length === 1 && inline[0].type === 'image' ? null : block;
}

/** 节点属性中的对齐 / 缩进定义（段落与标题共用） */
function blockFormatAttributes() {
  return {
    textAlign: {
      default: null,
      // 只从本编辑器自身输出的 data 属性还原，网页粘贴的 text-align 不带入 Markdown
      parseHTML: (element: HTMLElement) => normalizeAlign(element.getAttribute('data-text-align')),
      renderHTML: (attributes: Record<string, unknown>) => {
        const align = normalizeAlign(attributes.textAlign);
        return align ? { 'data-text-align': align, style: `text-align: ${align}` } : {};
      },
    },
    indent: {
      default: 0,
      parseHTML: (element: HTMLElement) => normalizeIndent(element.getAttribute('data-indent')),
      renderHTML: (attributes: Record<string, unknown>) => {
        const level = normalizeIndent(attributes.indent);
        return level > 0 ? { 'data-indent': String(level), style: `margin-left: ${level * INDENT_STEP_EM}em` } : {};
      },
    },
  };
}

/** 用标准写法包裹已渲染的块；表格单元格内无法写块级 HTML，保持原样 */
function wrapBlockFormat(
  node: JSONContent,
  rendered: string,
  context: RenderContext | undefined,
): string {
  const open = renderBlockFormatOpenTag(node.attrs?.textAlign, node.attrs?.indent);
  if (!open || ['tableCell', 'tableHeader'].includes(String(context?.parentType))) return rendered;
  // 空标题本就不输出；空段落写作 &nbsp;，保证往返后对齐信息仍在
  if (rendered === '' && node.type !== 'paragraph') return rendered;
  const body = rendered === '' ? EMPTY_PARAGRAPH_MARKDOWN : rendered;
  // 首尾标签走原样片段，避免全文后处理误改
  return `${emitRawSegment(open)}\n\n${body}\n\n${emitRawSegment(DIV_CLOSE_TAG)}`;
}

type RenderMarkdown = (node: JSONContent, helpers: MarkdownRendererHelpers, context: RenderContext) => string;

/** 段落：增加对齐 / 缩进属性，序列化时按需包裹 */
export const FormattedParagraph = Paragraph.extend({
  addAttributes() {
    return { ...this.parent?.(), ...blockFormatAttributes() };
  },
  renderMarkdown(node, helpers, context) {
    const parentRender = (this as unknown as { parent?: RenderMarkdown }).parent;
    return wrapBlockFormat(node, parentRender?.(node, helpers, context) ?? '', context);
  },
});

/**
 * 标准写法格式块的解析：对齐与缩进写回其中唯一的段落或标题。
 * marked 后注册的块级 tokenizer 先执行，须注册在 RawHtmlBlockMerge 之后、RawHtmlBlock 之前。
 */
export const BlockFormatSyntax = Extension.create({
  name: 'blockFormat',

  // 块级 tokenizer：优先于 marked 内置 html 块识别标准写法
  markdownTokenizer: {
    name: 'blockFormat',
    level: 'block',
    start: createIndexedBlockStart(START_PATTERN),
    tokenize: (src, _tokens, lexer) => {
      const match = matchBlockFormat(src);
      if (!match) return undefined;
      const block = singleFormattableBlock(lexer.blockTokens(match.body));
      if (!block) return undefined;
      return {
        type: 'blockFormat',
        raw: match.raw,
        text: match.raw,
        align: match.align,
        indent: match.indent,
        tokens: [block],
      };
    },
  },

  parseMarkdown: (token, helpers) => {
    const parseBlocks = helpers.parseBlockChildren ?? helpers.parseChildren;
    const children = parseBlocks(token.tokens || []);
    const [block] = children;
    if (children.length !== 1 || !FORMATTABLE_TYPES.has(String(block.type))) return children;
    return {
      ...block,
      attrs: { ...block.attrs, textAlign: normalizeAlign(token.align), indent: normalizeIndent(token.indent) },
    };
  },
});

/** 标题：与段落相同的对齐 / 缩进属性与序列化包裹 */
export const FormattedHeading = Heading.extend({
  addAttributes() {
    return { ...this.parent?.(), ...blockFormatAttributes() };
  },
  renderMarkdown(node, helpers, context) {
    const parentRender = (this as unknown as { parent?: RenderMarkdown }).parent;
    return wrapBlockFormat(node, parentRender?.(node, helpers, context) ?? '', context);
  },
});

// ── 命令（悬浮菜单、右键菜单共用） ──

/** 选区内可设置对齐 / 缩进的段落与标题位置 */
function formattableBlocks(editor: Editor): Array<{ pos: number; node: ProseMirrorNode }> {
  const { state } = editor;
  const { from, to } = state.selection;
  const blocks: Array<{ pos: number; node: ProseMirrorNode }> = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    // 列表项、表格单元格内的块不提供对齐与缩进，也无需继续深入
    if (UNFORMATTABLE_ANCESTORS.has(node.type.name)) return false;
    if (FORMATTABLE_TYPES.has(node.type.name)) {
      blocks.push({ pos, node });
      return false;
    }
    return true;
  });
  return blocks;
}

/** 光标或选区是否位于列表项内（缩进改为调整列表层级） */
function listItemTypeAtSelection(editor: Editor): 'listItem' | 'taskItem' | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === 'listItem' || name === 'taskItem') return name;
  }
  return null;
}

/** 当前选区能否设置对齐 */
export function canSetBlockAlign(editor: Editor): boolean {
  return editor.isEditable && formattableBlocks(editor).length > 0;
}

/** 选区首个可格式化块的对齐方式（无可格式化块时为左对齐） */
export function activeBlockAlign(editor: Editor): BlockAlign {
  const [first] = formattableBlocks(editor);
  return normalizeAlign(first?.node.attrs.textAlign) ?? 'left';
}

/** 批量修改选区内段落 / 标题的格式属性（一次操作对应一步撤销） */
function updateFormattableBlocks(editor: Editor, update: (node: ProseMirrorNode) => Record<string, unknown> | null): boolean {
  const blocks = formattableBlocks(editor);
  if (!editor.isEditable || blocks.length === 0) return false;
  const tr = editor.state.tr;
  for (const { pos, node } of blocks) {
    const changes = update(node);
    if (changes) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...changes });
  }
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  editor.commands.focus();
  return true;
}

/** 设置选区内段落 / 标题的对齐方式 */
export function setBlockAlign(editor: Editor, align: BlockAlign): boolean {
  const next = normalizeAlign(align);
  return updateFormattableBlocks(editor, (node) =>
    normalizeAlign(node.attrs.textAlign) === next ? null : { textAlign: next },
  );
}

/** 能否增加（delta = 1）/ 减少（delta = -1）缩进 */
export function canChangeBlockIndent(editor: Editor, delta: 1 | -1): boolean {
  if (!editor.isEditable) return false;
  const listItem = listItemTypeAtSelection(editor);
  if (listItem) {
    return delta > 0 ? editor.can().sinkListItem(listItem) : editor.can().liftListItem(listItem);
  }
  return formattableBlocks(editor).some(({ node }) => {
    const level = normalizeIndent(node.attrs.indent);
    return delta > 0 ? level < MAX_BLOCK_INDENT : level > 0;
  });
}

/** 增加 / 减少缩进：列表项调整层级，段落与标题调整缩进级别 */
export function changeBlockIndent(editor: Editor, delta: 1 | -1): boolean {
  const listItem = listItemTypeAtSelection(editor);
  if (listItem) {
    // 结果以层级调整是否成功为准（聚焦失败不影响操作本身）
    const applied = delta > 0 ? editor.commands.sinkListItem(listItem) : editor.commands.liftListItem(listItem);
    if (applied) editor.commands.focus();
    return applied;
  }
  return updateFormattableBlocks(editor, (node) => {
    const current = normalizeIndent(node.attrs.indent);
    const next = normalizeIndent(current + delta);
    return next === current ? null : { indent: next };
  });
}
