// NoteBoard 思维导图节点标题就地编辑器（所见即所得富文本）
// 基于 contentEditable="plaintext-only"：浏览器只负责输入与选区，格式由 marks 模型统一管理。
// 编辑期间 DOM 不受 React 控制（避免每次输入重渲染导致光标跳动），格式变更时按 marks 重建 DOM 并恢复选区。
// 详见 docs/09-开发路线图.md

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import {
  adjustMarksForTextChange,
  applyStylePatch,
  cleanStyle,
  fromStyleArray,
  splitStyledRuns,
  styleToCss,
  type MindTextMark,
  type MindTextStyle,
  type StylePatch,
} from './mindmapRichText';
import type { TextDraft } from './mindmapLayout';

/** 编辑框内的选区信息（供格式悬浮菜单定位与显示状态） */
export interface TitleSelectionInfo {
  from: number;
  to: number;
  rect: { left: number; top: number; bottom: number; width: number };
  draft: TextDraft;
}

export interface MindmapTitleEditorHandle {
  /** 对当前选区应用格式 */
  applyPatch: (patch: StylePatch) => void;
}

interface MindmapTitleEditorProps {
  initialText: string;
  initialMarks?: MindTextMark[];
  /** 挂载后全选（新建节点直接输入即可覆盖） */
  selectAll: boolean;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  color: string;
  textAlign: 'left' | 'center';
  minHeight: number;
  onDraftChange: (draft: TextDraft) => void;
  onEnter: () => void;
  /** Ctrl / Cmd + Enter：确认输入并退出编辑 */
  onConfirm: () => void;
  /** 粘贴图片：上传 / 替换节点图片 */
  onPasteImage: (file: File) => void;
  onTab: () => void;
  onEscape: () => void;
  onBlur: () => void;
  onSelectionChange: (info: TitleSelectionInfo | null) => void;
}

/** 按 marks 重建编辑框 DOM：每个格式片段一个 span，格式写在 data-style 上便于读回 */
function renderRuns(root: HTMLElement, text: string, marks: MindTextMark[] | undefined, baseWeight: number) {
  root.textContent = '';
  for (const run of splitStyledRuns(marks, 0, text.length)) {
    const span = document.createElement('span');
    const style = cleanStyle(run.style);
    if (Object.keys(style).length > 0) span.dataset.style = JSON.stringify(style);
    Object.assign(span.style, styleToCss(style, baseWeight));
    span.textContent = text.slice(run.start, run.end);
    root.appendChild(span);
  }
  // 末尾换行在 pre-wrap 下不产生空行，补一个占位 <br> 让光标能落到新行（读回时忽略）
  if (text.endsWith('\n')) {
    const placeholder = document.createElement('br');
    placeholder.dataset.placeholder = 'true';
    root.appendChild(placeholder);
  }
}

/** 从编辑框 DOM 读回纯文本与格式（\n 为节点内手动换行） */
function readDom(root: HTMLElement): TextDraft {
  let text = '';
  const styles: MindTextStyle[] = [];
  const walk = (node: Node, inherited: MindTextStyle) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node.nodeValue ?? '').replace(/\r\n?/g, '\n');
      text += data;
      for (let i = 0; i < data.length; i += 1) styles.push(inherited);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    // 浏览器自行插入的 <br> 视为换行，渲染时补的占位 <br> 忽略
    if (node.tagName === 'BR') {
      if (node.dataset.placeholder) return;
      text += '\n';
      styles.push(inherited);
      return;
    }
    let style = inherited;
    if (node.dataset.style) {
      try {
        style = { ...inherited, ...(JSON.parse(node.dataset.style) as MindTextStyle) };
      } catch {
        // 忽略损坏的格式标记
      }
    }
    node.childNodes.forEach((child) => walk(child, style));
  };
  root.childNodes.forEach((child) => walk(child, {}));
  const marks = fromStyleArray(styles);
  return { text, marks: marks.length > 0 ? marks : undefined };
}

/** 计算 (container, offset) 在编辑框纯文本中的下标 */
function textOffsetOf(root: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(container, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

/** 按纯文本下标定位 DOM 位置 */
function domPositionAt(root: HTMLElement, index: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = index;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const len = node.nodeValue?.length ?? 0;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
    last = node;
  }
  if (last) return { node: last, offset: last.nodeValue?.length ?? 0 };
  return { node: root, offset: root.childNodes.length };
}

/** 设置选区 */
function selectRange(root: HTMLElement, from: number, to: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const start = domPositionAt(root, from);
  const end = domPositionAt(root, to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

export const MindmapTitleEditor = forwardRef<MindmapTitleEditorHandle, MindmapTitleEditorProps>(
  function MindmapTitleEditor(props, ref) {
    const rootRef = useRef<HTMLDivElement>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const composingRef = useRef(false);

    /** 读取当前选区（不在编辑框内或折叠时返回 null） */
    const readSelection = useCallback((): { from: number; to: number; range: Range } | null => {
      const root = rootRef.current;
      const selection = window.getSelection();
      if (!root || !selection || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
      const from = textOffsetOf(root, range.startContainer, range.startOffset);
      const to = textOffsetOf(root, range.endContainer, range.endOffset);
      return { from: Math.min(from, to), to: Math.max(from, to), range };
    }, []);

    /** 选区变化时通知外部（非折叠选区才显示格式菜单） */
    const emitSelection = useCallback(() => {
      const root = rootRef.current;
      const sel = readSelection();
      if (!root || !sel || sel.from === sel.to) {
        propsRef.current.onSelectionChange(null);
        return;
      }
      const rect = sel.range.getBoundingClientRect();
      // 菜单水平跟随选区，垂直贴着整个编辑框上下沿，避免遮住其他行文字
      const box = root.getBoundingClientRect();
      propsRef.current.onSelectionChange({
        from: sel.from,
        to: sel.to,
        rect: {
          left: rect.left,
          top: Math.min(rect.top, box.top) - 6,
          bottom: Math.max(rect.bottom, box.bottom) + 6,
          width: rect.width,
        },
        draft: readDom(root),
      });
    }, [readSelection]);

    // 挂载：按初始文本与格式建立 DOM，聚焦并设置光标
    useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      renderRuns(root, props.initialText, props.initialMarks, props.fontWeight);
      // 聚焦不滚动祖先容器，避免画布内绝对定位控件跟着位移
      root.focus({ preventScroll: true });
      const length = props.initialText.length;
      selectRange(root, props.selectAll ? 0 : length, length);
      // 仅在挂载时初始化，之后 DOM 由用户输入驱动
    }, []);

    useEffect(() => {
      document.addEventListener('selectionchange', emitSelection);
      return () => {
        document.removeEventListener('selectionchange', emitSelection);
        propsRef.current.onSelectionChange(null);
      };
    }, [emitSelection]);

    /** 对当前选区应用格式：更新 marks 后重建 DOM 并恢复原选区 */
    const applyPatch = useCallback(
      (patch: StylePatch) => {
        const root = rootRef.current;
        const sel = readSelection();
        if (!root || !sel || sel.from === sel.to) return;
        const draft = readDom(root);
        const marks = applyStylePatch(draft.text.length, draft.marks, sel.from, sel.to, patch);
        const next: TextDraft = { text: draft.text, marks: marks.length > 0 ? marks : undefined };
        renderRuns(root, next.text, next.marks, propsRef.current.fontWeight);
        selectRange(root, sel.from, sel.to);
        propsRef.current.onDraftChange(next);
        emitSelection();
      },
      [readSelection, emitSelection],
    );

    useImperativeHandle(ref, () => ({ applyPatch }), [applyPatch]);

    /** 以纯文本替换当前选区：含换行时自行拼接并重建 DOM（浏览器原生插入换行的结构各端不一致） */
    const insertPlainText = useCallback(
      (insert: string) => {
        const root = rootRef.current;
        if (!root || !insert) return;
        if (!insert.includes('\n')) {
          document.execCommand('insertText', false, insert);
          return;
        }
        const sel = readSelection();
        if (!sel) return;
        const draft = readDom(root);
        const text = draft.text.slice(0, sel.from) + insert + draft.text.slice(sel.to);
        const next: TextDraft = { text, marks: adjustMarksForTextChange(draft.text, text, draft.marks) };
        renderRuns(root, next.text, next.marks, propsRef.current.fontWeight);
        const caret = sel.from + insert.length;
        selectRange(root, caret, caret);
        propsRef.current.onDraftChange(next);
      },
      [readSelection],
    );

    const handleInput = () => {
      const root = rootRef.current;
      if (!root) return;
      propsRef.current.onDraftChange(readDom(root));
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      // 输入法组字中的按键用于上屏，不触发快捷操作
      if (e.nativeEvent.isComposing || composingRef.current) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          // Ctrl / Cmd + Enter：确认输入
          propsRef.current.onConfirm();
        } else if (e.shiftKey || e.altKey) {
          // Shift / Alt(Option) + Enter：节点内换行
          insertPlainText('\n');
        } else {
          propsRef.current.onEnter();
        }
      } else if (e.key === 'Tab') {
        e.preventDefault();
        propsRef.current.onTab();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        propsRef.current.onEscape();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        // 常用格式快捷键：Ctrl+B 加粗 / Ctrl+I 斜体 / Ctrl+U 下划线
        const key = e.key.toLowerCase();
        const toggle = key === 'b' ? 'bold' : key === 'i' ? 'italic' : key === 'u' ? 'underline' : null;
        if (toggle) {
          e.preventDefault();
          applyPatch({ type: 'toggle', key: toggle });
        }
      }
    };

    // 粘贴图片：交给外部上传 / 替换节点图片；否则只取纯文本（保留换行）
    const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      const image = Array.from(e.clipboardData.files).find((file) => file.type.startsWith('image/'));
      if (image) {
        propsRef.current.onPasteImage(image);
        return;
      }
      insertPlainText(e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
    };

    return (
      <div
        ref={rootRef}
        className="nb-mindmap-title-editor"
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        role="textbox"
        aria-label="编辑节点标题"
        spellCheck={false}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onDrop={(e) => e.preventDefault()}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          handleInput();
        }}
        onBlur={() => propsRef.current.onBlur()}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: props.minHeight,
          fontSize: props.fontSize,
          fontWeight: props.fontWeight,
          lineHeight: `${props.lineHeight}px`,
          color: props.color,
          textAlign: props.textAlign,
        }}
      />
    );
  },
);
