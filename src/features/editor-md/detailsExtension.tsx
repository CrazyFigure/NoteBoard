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

import { useEffect, useRef, useState } from 'react';
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';
import { contentReactNodeViewRenderer } from './contentNodeView';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { ChevronRight } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { useSettingsStore } from '../../stores/settingsStore';
import { isSelectionInside, useCollapsibleState } from './collapsibleState';
import { DetailsBlockCore, DEFAULT_DETAILS_SUMMARY, renderDetailsHead } from './detailsCore';

// 保留既有导出入口，界面和调用方继续使用同一份核心规则。
export { DEFAULT_DETAILS_SUMMARY, matchDetailsBlock } from './detailsCore';

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
      // 收起标记：拖选经过时由 collapsedBlockSelection 把选区对齐到整块
      data-nb-collapsed={expanded ? undefined : ''}
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
export const DetailsBlock = DetailsBlockCore.extend({

  addNodeView() {
    return contentReactNodeViewRenderer(DetailsComponent);
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => exitDetailsFromEmptyParagraph(editor.state, (tr) => editor.view.dispatch(tr)),
    };
  }
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

/** 源码模式下以 body 为正文的折叠块标准写法（不含首尾空行） */
export function detailsSourceBlock(body: string): string {
  return `${renderDetailsHead(false, DEFAULT_DETAILS_SUMMARY)}\n\n${body}\n\n</details>`;
}

/** 源码模式插入的标准写法片段 */
export const DETAILS_SOURCE_SNIPPET = `\n${detailsSourceBlock('折叠内容')}\n\n`;
