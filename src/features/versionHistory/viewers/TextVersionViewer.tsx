// NoteBoard 文档历史记录：源码级差异查看（代码 / 纯文本，也是其他格式的兜底）
// 只读 CodeMirror 单栏合并视图：删除的行以红色删除线插在原处，新增内容以绿色底标出。
// 「显示更改」关闭时只显示该版本的正文；结构化 JSON 先格式化再逐行比较，避免整份压成一行。

import { useEffect, useMemo, useRef } from 'react';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { unifiedMergeView, getChunks } from '@codemirror/merge';
import { nbEditorTheme } from '../../editor-code/theme';
import { nbSyntaxHighlighting } from '../../editor-code/highlightStyle';
import { loadLanguageFromPath } from '../../editor-code/languages';
import type { VersionViewerProps } from './viewerTypes';

/** 结构化格式：比较前格式化，按行对齐才有意义 */
const JSON_KINDS = new Set(['board', 'mindmap', 'bitable']);

/** 格式化 JSON（解析失败原样返回） */
export function normalizeForDiff(kind: string, text: string): string {
  if (!JSON_KINDS.has(kind)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * 历史查看专用差异配色（主题变量，随主题切换）。
 * @codemirror/merge 的基础主题带 &light / &dark 前缀（选择器更具体），
 * 这里统一加 &.cm-merge-b.cm-editor 前缀压过默认的下划线与固定色。
 */
const P = '&.cm-merge-b.cm-editor';
const historyDiffTheme: Extension = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--editor-bg)' },
  '.cm-scroller': { fontFamily: 'var(--mono-font-family)', lineHeight: 'var(--mono-line-height)' },
  '.cm-content': { padding: '16px 0 48px' },
  // 新增：整行浅底 + 行内改动加深
  [`${P} .cm-changedLine`]: { backgroundColor: 'color-mix(in srgb, var(--diff-insert-border) 8%, transparent)' },
  [`${P} .cm-changedLine .cm-changedText`]: { background: 'var(--diff-insert-bg)', borderRadius: '2px' },
  [`${P} .cm-insertedLine`]: { textDecoration: 'none' },
  // 删除：插入在原位置的只读块，删除线 + 红色
  [`${P} .cm-deletedChunk`]: {
    backgroundColor: 'color-mix(in srgb, var(--diff-delete-border) 7%, transparent)',
    paddingLeft: '6px',
  },
  [`${P} .cm-deletedChunk .cm-deletedLine`]: { color: 'var(--diff-delete-text)' },
  [`${P} .cm-deletedChunk .cm-deletedText, ${P} .cm-deletedChunk del`]: {
    background: 'var(--diff-delete-bg)',
    textDecoration: 'line-through',
    textDecorationColor: 'var(--diff-delete-border)',
    borderRadius: '2px',
  },
  '.cm-changeGutter': { width: '3px', paddingLeft: '0' },
  [`${P} .cm-changedLineGutter`]: { background: 'var(--diff-insert-border)' },
  [`${P} .cm-deletedLineGutter`]: { background: 'var(--diff-delete-border)' },
});

export default function TextVersionViewer({ path, kind, base, target, showChanges, onChangeInfo, navigatorRef }: VersionViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const indexRef = useRef(-1);
  const mergeCompartment = useMemo(() => new Compartment(), []);
  const languageCompartment = useMemo(() => new Compartment(), []);
  const languageRef = useRef<Extension>([]);
  const original = useMemo(() => (base === null ? null : normalizeForDiff(kind, base)), [kind, base]);
  const current = useMemo(() => normalizeForDiff(kind, target), [kind, target]);
  // 回调可能每次渲染变化，经 ref 读取最新值，避免重建编辑器
  const onChangeInfoRef = useRef(onChangeInfo);
  onChangeInfoRef.current = onChangeInfo;

  const mergeExtension = (on: boolean): Extension =>
    on && original !== null
      ? unifiedMergeView({ original, mergeControls: false, highlightChanges: true, syntaxHighlightDeletions: true, gutter: true })
      : [];

  /** 改动块列表变化后通知外层，并定位到第一处 */
  const reportChunks = (view: EditorView, jumpFirst: boolean) => {
    const chunks = getChunks(view.state)?.chunks ?? [];
    indexRef.current = -1;
    if (jumpFirst && chunks.length > 0) {
      indexRef.current = 0;
      view.dispatch({ effects: EditorView.scrollIntoView(chunks[0].fromB, { y: 'center' }) });
    }
    onChangeInfoRef.current({ count: chunks.length, index: indexRef.current });
  };

  // 创建 / 重建编辑器（版本切换时整体替换状态，避免残留旧的差异装饰）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: current,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        lineNumbers(),
        EditorView.lineWrapping,
        nbEditorTheme,
        nbSyntaxHighlighting,
        historyDiffTheme,
        languageCompartment.of(languageRef.current),
        mergeCompartment.of(mergeExtension(showChanges)),
      ],
    });
    let view = viewRef.current;
    if (view) {
      view.setState(state);
    } else {
      view = new EditorView({ state, parent: host });
      viewRef.current = view;
    }
    reportChunks(view, showChanges);
    // showChanges 由下方单独切换，这里只在内容变化时重建
  }, [current, original]);

  // 显示更改开关：只切换合并扩展
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: mergeCompartment.reconfigure(mergeExtension(showChanges)) });
    reportChunks(view, showChanges);
  }, [showChanges]);

  // 语法高亮按路径异步加载
  useEffect(() => {
    let alive = true;
    if (JSON_KINDS.has(kind)) return;
    loadLanguageFromPath(path)
      .then((ext) => {
        languageRef.current = ext;
        if (alive && viewRef.current) viewRef.current.dispatch({ effects: languageCompartment.reconfigure(ext) });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path, kind, languageCompartment]);

  useEffect(() => () => {
    viewRef.current?.destroy();
    viewRef.current = null;
  }, []);

  // 上一处 / 下一处
  useEffect(() => {
    const move = (delta: number) => {
      const view = viewRef.current;
      if (!view) return;
      const chunks = getChunks(view.state)?.chunks ?? [];
      if (chunks.length === 0) return;
      const next = Math.max(0, Math.min(chunks.length - 1, indexRef.current + delta));
      indexRef.current = next;
      view.dispatch({ effects: EditorView.scrollIntoView(chunks[next].fromB, { y: 'center' }) });
      onChangeInfoRef.current({ count: chunks.length, index: next });
    };
    navigatorRef.current = { next: () => move(1), prev: () => move(-1) };
    return () => {
      navigatorRef.current = null;
    };
  }, [navigatorRef]);

  return <div ref={hostRef} className="nb-vh-text-viewer" style={{ height: '100%', overflow: 'hidden' }} />;
}
