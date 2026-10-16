// NoteBoard 可视化模式粘贴格式检测
// 粘贴纯文本时照常按纯文本插入，同时记下粘贴范围与原始文本；
// 提示组件（PasteFormatPrompt）据此检测其中的 Markdown / HTML 语法，询问是否转换为格式。
// 粘贴范围在下一次修改文档（含撤销、转换本身）或主动关闭时清除，提示随之消失。

import type { Editor } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { DOMParser as ProseMirrorDOMParser, Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { parseMarkdownToJson } from './serialize';

/** 最近一次纯文本粘贴的范围与原始文本 */
export interface PastedTextRange {
  from: number;
  to: number;
  text: string;
}

export const pasteFormatKey = new PluginKey<PastedTextRange | null>('nbPasteFormat');

// 超长文本不做检测：解析整段 Markdown 的开销与收益不成比例
const MAX_DETECT_LENGTH = 200_000;
// 纯文本粘贴生成的切片只含这些节点；出现其它节点说明剪贴板 HTML 已被解析成富文本
const PLAIN_SLICE_NODES = new Set(['paragraph', 'text', 'hardBreak']);

/** 切片是否已带格式（富文本粘贴的结果无需再转换）；光标处继承的 mark 不算 */
function sliceHasFormatting(slice: Slice, inheritedMarks: ReadonlySet<string>): boolean {
  let formatted = false;
  slice.content.descendants((node) => {
    if (formatted) return false;
    if (!PLAIN_SLICE_NODES.has(node.type.name)) formatted = true;
    else if (node.marks.some((mark) => !inheritedMarks.has(mark.type.name))) formatted = true;
    return !formatted;
  });
  return formatted;
}

/** 粘贴范围跟踪插件：模块级工厂创建，闭包不持有 editor（与 VisualKernel 的 P0-2 约束一致） */
function createPasteFormatPlugin(): Plugin<PastedTextRange | null> {
  // handlePaste 与随后的粘贴事务在同一同步调用中依次发生，用闭包传递原始文本
  let pendingText: string | null = null;

  return new Plugin<PastedTextRange | null>({
    key: pasteFormatKey,
    state: {
      init: () => null,
      apply(tr, value, oldState) {
        const text = pendingText;
        pendingText = null;
        if (tr.getMeta(pasteFormatKey) === 'dismiss') return null;
        if (tr.getMeta('uiEvent') === 'paste') {
          if (!text) return null;
          const from = tr.mapping.map(oldState.selection.from, -1);
          const to = tr.selection.to;
          return to > from ? { from, to, text } : null;
        }
        if (!value || !tr.docChanged) return value;
        // 粘贴后其它插件追加的事务（链接识别、末尾空段落等）只映射范围；其余修改一律视为"下一次修改"
        if (!tr.getMeta('appendedTransaction')) return null;
        const from = tr.mapping.map(value.from, 1);
        const to = tr.mapping.map(value.to, -1);
        return to > from ? { ...value, from, to } : null;
      },
    },
    props: {
      // 只记录、不拦截：返回 false 交给默认粘贴流程
      handlePaste(view, event, slice) {
        pendingText = null;
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (!text.trim() || text.length > MAX_DETECT_LENGTH) return false;
        // 编辑器内部复制（带 data-pm-slice）保留原结构粘贴，不提示
        if (event.clipboardData?.getData('text/html').includes('data-pm-slice')) return false;
        const { $from } = view.state.selection;
        // 代码块、行内代码中的文本本就应按字面保留
        if ($from.parent.type.spec.code) return false;
        const inheritedMarks = new Set($from.marks().map((mark) => mark.type.name));
        if (inheritedMarks.has('code')) return false;
        if (sliceHasFormatting(slice, inheritedMarks)) return false;
        pendingText = text;
        return false;
      },
    },
  });
}

export const PasteFormatDetect = Extension.create({
  name: 'pasteFormatDetect',
  addProseMirrorPlugins() {
    return [createPasteFormatPlugin()];
  },
});

/** 当前记录的粘贴范围 */
export function getPastedTextRange(state: EditorState): PastedTextRange | null {
  return pasteFormatKey.getState(state) ?? null;
}

/** 检测结果：可转换的语法类型 */
export type PastedFormatKind = 'markdown' | 'html' | 'mixed';

/**
 * 转换方式：
 * - markdown：按 Markdown 解析（夹在其中的 HTML 按 GitHub 规则成为 HTML 块）；
 * - richText：整段是 HTML 源码时，像从网页复制那样解析为标题、链接等正文格式；
 * - htmlBlock：整段 HTML 源码保留为一个 HTML 块。
 */
export type PasteConvertMode = 'markdown' | 'richText' | 'htmlBlock';

export interface PastedFormat {
  kind: PastedFormatKind;
  /** 可用的转换方式，首项为主操作 */
  modes: PasteConvertMode[];
}

interface JsonNodeLike {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: JsonNodeLike[];
}

const HTML_NODE_TYPES = new Set(['rawHtmlBlock', 'rawHtmlInline']);
const PLAIN_JSON_NODES = new Set(['doc', 'paragraph', 'text', 'hardBreak']);

/** 自动识别的裸链接（文本即地址）不算格式：粘贴网址时不提示 */
function isAutolink(node: JsonNodeLike, mark: { type?: string; attrs?: Record<string, unknown> }): boolean {
  if (mark.type !== 'link') return false;
  const href = String(mark.attrs?.href ?? '');
  const text = node.text ?? '';
  return href === text || href === `mailto:${text}` || href === `http://${text}` || href === `https://${text}`;
}

/** 分析解析结果中是否含有纯文本之外的格式；无格式返回 null */
export function analyzeParsedFormat(root: JsonNodeLike): PastedFormatKind | null {
  let hasMarkdown = false;
  let hasHtml = false;
  const visit = (node: JsonNodeLike) => {
    const type = node.type ?? '';
    if (HTML_NODE_TYPES.has(type)) hasHtml = true;
    else if (!PLAIN_JSON_NODES.has(type)) hasMarkdown = true;
    else if (node.marks?.some((mark) => !isAutolink(node, mark))) hasMarkdown = true;
    node.content?.forEach(visit);
  };
  visit(root);
  if (hasMarkdown && hasHtml) return 'mixed';
  if (hasHtml) return 'html';
  return hasMarkdown ? 'markdown' : null;
}

// 以标签（或注释、DOCTYPE）开头并以标签结尾的文本视为 HTML 源码
const HTML_SOURCE_START = /^\s*<(?:!doctype\b|!--|[a-z][\w:-]*(?=[\s/>]))/i;
const HTML_SOURCE_END = />\s*$/;
// 标签与注释（属性值可跨行）
const HTML_TAG_OR_COMMENT = /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi;
// 行首的 Markdown 块语法（缩进超过 3 格的行在 HTML 源码中只是排版缩进，不算）
const MARKDOWN_BLOCK_LINE = /^ {0,3}(?:#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>\s|```|~~~)/;

/**
 * 是否为整段 HTML 源码（如网页源码、开发者工具中复制的节点）。
 * 这类文本按 Markdown 解析会被空行截断、被缩进误判为代码块而支离破碎，需单独处理；
 * 标签之外的文字里出现 Markdown 块语法时（如 `<div>` 中夹 Markdown），仍按 Markdown 处理。
 */
export function isHtmlSource(text: string): boolean {
  if (!HTML_SOURCE_START.test(text) || !HTML_SOURCE_END.test(text)) return false;
  const outside = text.replace(HTML_TAG_OR_COMMENT, '\n');
  return !outside.split('\n').some((line) => MARKDOWN_BLOCK_LINE.test(line));
}

/** 解析粘贴文本并检测格式；解析失败或无格式时返回 null */
export function detectPastedFormat(editor: Editor, text: string): PastedFormat | null {
  if (isHtmlSource(text)) return { kind: 'html', modes: ['htmlBlock', 'richText'] };
  try {
    const parsed = parseMarkdownToJson(editor, text) as JsonNodeLike | null;
    if (!parsed?.content?.length) return null;
    const kind = analyzeParsedFormat(parsed);
    return kind ? { kind, modes: ['markdown'] } : null;
  } catch {
    return null;
  }
}

/** 整段 HTML 源码作为一个 HTML 块：去掉空白行（空行会截断 Markdown 的 HTML 块）与首尾空白 */
export function toSingleHtmlBlockSource(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .join('\n')
    .trim();
}

/**
 * 按转换方式生成替换粘贴范围的切片。
 * editor 只用于取 Markdown 解析器；文档结构以传入的 state 为准。
 */
export function createConvertSlice(editor: Editor, state: EditorState, range: PastedTextRange, mode: PasteConvertMode): Slice | null {
  try {
    if (mode === 'markdown') {
      const parsed = parseMarkdownToJson(editor, range.text) as JsonNodeLike | null;
      if (!parsed?.content?.length) return null;
      const fragment = Fragment.fromJSON(state.schema, parsed.content);
      // 首尾是普通段落时开放，与光标所在行合并（行内格式就地转换）；
      // 标题、列表等块保持闭合独立成块——开放会把它们的文字并入所在段落，`## 标题` 就只剩下「标题」
      const isParagraph = (node: ProseMirrorNode | null) => node?.type.name === 'paragraph';
      return new Slice(fragment, isParagraph(fragment.firstChild) ? 1 : 0, isParagraph(fragment.lastChild) ? 1 : 0);
    }
    if (mode === 'htmlBlock') {
      const raw = toSingleHtmlBlockSource(range.text);
      const type = state.schema.nodes.rawHtmlBlock;
      if (!raw || !type) return null;
      return new Slice(Fragment.from(type.create({ raw })), 0, 0);
    }
    // 与从网页复制富文本一致：在惰性文档中解析（脚本不执行、图片不加载），再按编辑器 schema 取内容
    const body = new window.DOMParser().parseFromString(range.text, 'text/html').body;
    const slice = ProseMirrorDOMParser.fromSchema(state.schema).parseSlice(body, {
      context: state.doc.resolve(Math.min(range.from, state.doc.content.size)),
    });
    return slice.content.size > 0 ? slice : null;
  } catch {
    return null;
  }
}

/**
 * 把粘贴范围替换为转换后的切片（独立历史步骤，撤销可回到纯文本粘贴结果）。
 * 与粘贴一致按 replaceRange 替换：在空段落中粘贴时整段替换为标题、列表等块结构。
 */
export function createConvertTransaction(state: EditorState, range: PastedTextRange, slice: Slice): Transaction | null {
  if (range.to > state.doc.content.size) return null;
  try {
    const tr = state.tr.replaceRange(range.from, range.to, slice);
    // 光标放到转换结果末尾
    const end = tr.mapping.map(range.to, 1);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1));
    // 强制成为独立历史组：即使紧接粘贴操作，撤销也只撤回转换
    return closeHistory(tr).scrollIntoView();
  } catch {
    return null;
  }
}

/** 在编辑器中执行转换；范围失效或内容不合法时返回 false */
export function convertPastedRange(editor: Editor, range: PastedTextRange, mode: PasteConvertMode): boolean {
  const slice = createConvertSlice(editor, editor.state, range, mode);
  const tr = slice && createConvertTransaction(editor.state, range, slice);
  if (!tr) return false;
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/**
 * 按主转换方式转换后文档是否不变：粗体、行内代码等由编辑器自带的粘贴规则即时转换，
 * 这类粘贴转换后不会有任何变化，无需提示。
 */
export function isRangeAlreadyFormatted(editor: Editor, state: EditorState, range: PastedTextRange, mode: PasteConvertMode): boolean {
  // 直接试算一次转换（只构造事务、不派发）
  const slice = createConvertSlice(editor, state, range, mode);
  const tr = slice && createConvertTransaction(state, range, slice);
  return Boolean(tr && tr.doc.eq(state.doc));
}

/** 清除粘贴范围的事务（不修改文档、不入历史） */
export function createDismissTransaction(state: EditorState): Transaction {
  return state.tr.setMeta(pasteFormatKey, 'dismiss').setMeta('addToHistory', false);
}

/** 关闭提示：清除记录的粘贴范围 */
export function dismissPastedRange(editor: Editor): void {
  if (!getPastedTextRange(editor.state)) return;
  editor.view.dispatch(createDismissTransaction(editor.state));
}
