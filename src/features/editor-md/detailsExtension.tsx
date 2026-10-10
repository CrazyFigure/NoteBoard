// NoteBoard 折叠块（<details>）扩展
// Markdown 本身没有折叠语法，GitHub / GitLab / VS Code / Typora / Obsidian 通用的写法是 HTML <details>：
//
//   <details>
//   <summary>标题</summary>
//
//   正文（任意 Markdown）
//
//   </details>
//
// 规范化约束：只接管上述标准写法（标题为纯文本，正文前后各一个空行），保证"解析→序列化"逐字一致；
// 其余手写变体（标题含标签、无空行、缩进等）不识别，继续由 RawHtmlBlock 原样保留，绝不静默改写。
// 展开/收起只是显示状态，不写回文件；源码中的 `<details open>` 原样保留，并使该块初始展开。

import { Node, mergeAttributes } from '@tiptap/core';
import { useEffect, useRef, useState } from 'react';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { ChevronRight } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { useSettingsStore } from '../../stores/settingsStore';
import { emitRawSegment } from './rawMarkdownSegments';
import { isSelectionInside, useCollapsibleState } from './collapsibleState';

/** 新插入折叠块的默认标题 */
export const DEFAULT_DETAILS_SUMMARY = '标题';

// 标准写法首部：`<details>` 或 `<details open>` 独占一行，下一行为单行 <summary>，随后是一个空行
// （空行允许含空白：列表内序列化会给空行补缩进）
const DETAILS_HEAD_PATTERN = /^<details( open)?>\n<summary>([^\n]*?)<\/summary>\n[ \t]*\n/;
const DETAILS_START_PATTERN = /(?:^|\n)<details(?: open)?>\n<summary>/;
// 嵌套计数：统计行内出现的开始/结束标签（含非标准写法），保证与正确的 </details> 配对
const DETAILS_OPEN_TAG = /<details[\s>]/gi;
const DETAILS_CLOSE_TAG = /<\/details\s*>/gi;
// 代码围栏起止：围栏内的 <details> 文本不参与配对
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/** 标题文本转义：只处理会破坏 HTML 结构的字符 */
function escapeSummary(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 还原标题中的基本实体 */
function decodeSummary(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 统计一行中某类标签的出现次数 */
function countMatches(line: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return line.match(pattern)?.length ?? 0;
}

/** 判断某行是否闭合了给定的代码围栏（同字符、长度不短于开启围栏） */
function closesFence(line: string, fence: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence[0] && match[1].length >= fence.length);
}

/** 标准写法折叠块的分析结果 */
interface DetailsMatch {
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
function renderDetailsHead(open: boolean, summary: string): string {
  return `<details${open ? ' open' : ''}>\n<summary>${escapeSummary(summary)}</summary>`;
}

// 新插入的折叠块挂载时聚焦标题输入框（模块级一次性标记，由插入命令设置，短时间内有效）
const SUMMARY_FOCUS_WINDOW_MS = 1000;
let pendingSummaryFocusAt = 0;

/** 标记稍后挂载、且包含光标的折叠块需要聚焦标题 */
export function requestDetailsSummaryFocus(): void {
  pendingSummaryFocusAt = Date.now();
}

function DetailsComponent({ node, editor, getPos, updateAttributes, selected }: NodeViewProps) {
  const defaultExpanded = useSettingsStore((s) => s.settings.editor.detailsDefaultExpanded ?? false);
  const [expanded, setExpanded] = useCollapsibleState(editor, getPos, node, defaultExpanded, Boolean(node.attrs.open));
  const summary = String(node.attrs.summary ?? '');
  // 标题草稿：输入法组合期间不写回文档，避免拼音字母进入撤销历史
  const [draft, setDraft] = useState(summary);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 文档侧标题变化（撤销、协同外部修改）时同步草稿
  useEffect(() => {
    if (!composingRef.current) setDraft(summary);
  }, [summary]);

  // 新插入的折叠块：聚焦标题并全选默认文字，便于直接输入
  useEffect(() => {
    if (Date.now() - pendingSummaryFocusAt > SUMMARY_FOCUS_WINDOW_MS) return;
    // 只有刚插入（光标位于其正文内）的那个折叠块消费该标记
    if (!isSelectionInside(editor, getPos, node)) return;
    pendingSummaryFocusAt = 0;
    const input = inputRef.current;
    if (!input || !editor.isEditable) return;
    input.focus();
    input.select();
    // 仅在挂载时检查一次
  }, []);

  const commitSummary = (value: string) => {
    if (value !== summary) updateAttributes({ summary: value });
  };

  // 标题输入框交还焦点给编辑器：先让输入框失焦，移动端聚焦守卫据此识别为"刚失焦后取回"而放行，键盘不收起
  const returnFocusToEditor = () => {
    inputRef.current?.blur();
    editor.view.focus();
  };

  // 回车：展开并把光标移到正文开头
  const focusBody = () => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    setExpanded(true);
    const { state, view } = editor;
    const selection = TextSelection.near(state.doc.resolve(pos + 1), 1);
    view.dispatch(state.tr.setSelection(selection).scrollIntoView());
    returnFocusToEditor();
  };

  return (
    <NodeViewWrapper
      className={`nb-details${expanded ? ' is-open' : ''}${selected ? ' is-selected' : ''}`}
      data-details=""
    >
      <div
        className="nb-details-summary"
        contentEditable={false}
        // 点击标题栏空白处切换展开状态（与原生 <details> 一致）
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) event.preventDefault();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) setExpanded(!expanded);
        }}
      >
        <Tooltip content={expanded ? '收起' : '展开'} side="top" sideOffset={4}>
          <button
            type="button"
            className={`nb-collapse-toggle${expanded ? ' is-expanded' : ''}`}
            aria-expanded={expanded}
            aria-label={expanded ? '收起折叠块' : '展开折叠块'}
            // 阻止按下时编辑器失焦或移动选区
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronRight size={15} className="nb-collapse-chevron" />
          </button>
        </Tooltip>
        <input
          ref={inputRef}
          type="text"
          className="nb-details-title"
          value={draft}
          placeholder="折叠块标题"
          spellCheck={false}
          // 只有插入新折叠块时会程序化聚焦标题，移动端聚焦守卫需放行（用户此时就是要输入标题）
          data-nb-allow-autofocus=""
          readOnly={!editor.isEditable}
          onChange={(event) => {
            setDraft(event.target.value);
            if (!composingRef.current) commitSummary(event.target.value);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            commitSummary(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              focusBody();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              returnFocusToEditor();
            }
          }}
        />
      </div>
      {/* 正文挂载点：收起时仅隐藏，保持 ProseMirror 内容 DOM 常驻 */}
      <NodeViewContent className="nb-details-content" />
    </NodeViewWrapper>
  );
}

/** 折叠块节点 */
export const DetailsBlock = Node.create({
  name: 'detailsBlock',
  group: 'block',
  content: 'block+',
  selectable: true,
  defining: true,

  addAttributes() {
    return {
      summary: { default: DEFAULT_DETAILS_SUMMARY, rendered: false },
      // 源码中的 open 属性：只用于原样往返与初始展开，不随界面展开/收起变化
      open: { default: false, rendered: false },
    };
  },

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
    start: (src: string) => {
      const match = DETAILS_START_PATTERN.exec(src);
      if (!match) return -1;
      return match.index + (match[0].startsWith('\n') ? 1 : 0);
    },
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
  },

  addNodeView() {
    return ReactNodeViewRenderer(DetailsComponent);
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => exitDetailsFromEmptyParagraph(editor.state, (tr) => editor.view.dispatch(tr)),
    };
  },
});

/**
 * 正文末尾的空段落中按回车：删除该空段落并跳出到折叠块后方
 * （触屏没有方向键，折叠块位于文末时否则无法跳出）。导出供测试使用。
 */
export function exitDetailsFromEmptyParagraph(state: EditorState, dispatch: (tr: Transaction) => void): boolean {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth < 2) return false;
  const paragraph = $from.parent;
  if (paragraph.type.name !== 'paragraph' || paragraph.content.size > 0) return false;
  const detailsDepth = $from.depth - 1;
  const details = $from.node(detailsDepth);
  // 只有一个段落时保持默认行为（在正文内换行），避免一按回车就把空折叠块的正文删光
  if (details.type.name !== 'detailsBlock' || details.childCount < 2) return false;
  if ($from.index(detailsDepth) !== details.childCount - 1) return false;

  const paragraphStart = $from.before();
  const tr = state.tr.delete(paragraphStart, paragraphStart + paragraph.nodeSize);
  const insertPos = tr.mapping.map($from.after(detailsDepth));
  tr.insert(insertPos, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
  dispatch(tr.scrollIntoView());
  return true;
}

/** 插入一个折叠块并聚焦其标题（菜单、斜杠命令、工具栏共用） */
export function insertDetailsContent() {
  requestDetailsSummaryFocus();
  return {
    type: 'detailsBlock',
    attrs: { summary: DEFAULT_DETAILS_SUMMARY },
    content: [{ type: 'paragraph' }],
  };
}

/** 源码模式插入的标准写法片段 */
export const DETAILS_SOURCE_SNIPPET = `\n<details>\n<summary>${DEFAULT_DETAILS_SUMMARY}</summary>\n\n折叠内容\n\n</details>\n\n`;
