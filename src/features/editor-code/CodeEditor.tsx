// NoteBoard CodeMirror 6 编辑器组件
// 裸 CM6（new EditorView / EditorState.create），挂载到 DOM
// 详见 docs/09-开发路线图.md 4.1

import { useEffect, useRef } from 'react';
import {
  EditorView,
  keymap,
  highlightWhitespace,
  lineNumbers,
  highlightActiveLineGutter,
} from '@codemirror/view';
import { EditorState, Prec, Transaction } from '@codemirror/state';
import { undoDepth as cmUndoDepth } from '@codemirror/commands';
import {
  createBaseExtensions,
  languageCompartment,
  themeCompartment,
  wrapCompartment,
  lineNumberCompartment,
  typographyCompartment,
  whitespaceCompartment,
  lineEndingCompartment,
  showLineEndingsExtension,
} from './setup';
import { loadLanguageExtension } from './languages';
import { getLinterForLanguage } from './lint';
import {
  handleExpandJson,
  handleMinifyJson,
  handleValidateJson,
} from './jsonOps';
import type { LanguageId } from '../../core/ipc/types';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { normalizeEol } from '../editor-md/serialize';
import * as ipc from '../../core/ipc/commands';
import {
  initializeDocumentHistory,
  recordDocumentChange,
  redoDocumentHistory,
  registerDocumentHistoryAdapter,
  undoDocumentHistory,
} from '../history/documentHistory';

// ── 编辑器实例管理 ──

/** 当前窗口的 CM6 实例（每窗口只有一个编辑器实例） */
let editorView: EditorView | null = null;

/** 导出编辑器实例（供状态栏等外部模块使用） */
export function getEditorView(): EditorView | null {
  return editorView;
}

// ── React 组件 ──

interface CodeEditorProps {
  docKey: string;
}

export function CodeEditor({ docKey }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const doc = useDocumentStore((s) => s.documents.get(docKey));
  const setContent = useDocumentStore((s) => s.setContent);
  const setTabDirty = useWindowStore((s) => s.setTabDirty);
  const editorSettings = useSettingsStore((s) => s.settings.editor);
  const typography = useSettingsStore((s) => s.settings.typography);

  // 监听编辑器设置变化并热重配（空格、换行符、行号、软换行等）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        whitespaceCompartment.reconfigure(
          editorSettings.showWhitespace ? highlightWhitespace() : [],
        ),
        lineEndingCompartment.reconfigure(
          editorSettings.showLineEndings ? showLineEndingsExtension : [],
        ),
        lineNumberCompartment.reconfigure(
          editorSettings.showLineNumbers !== false
            ? [lineNumbers(), highlightActiveLineGutter()]
            : [],
        ),
        wrapCompartment.reconfigure(
          editorSettings.softWrap ? EditorView.lineWrapping : [],
        ),
      ],
    });
  }, [
    editorSettings.showWhitespace,
    editorSettings.showLineEndings,
    editorSettings.showLineNumbers,
    editorSettings.softWrap,
  ]);

  // 监听排版字体与字号变化并热重配 CM6，并刷新字符度量
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const typographyExt = EditorView.theme({
      '&': {
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
        height: '100%',
        caretColor: 'var(--cm-cursor)',
      },
      '.cm-scroller': {
        lineHeight: 'var(--mono-line-height, 1.5)',
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
      },
      '.cm-content, .cm-line': {
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
        caretColor: 'var(--cm-cursor)',
      },
      '.cm-content': {
        padding: '16px 24px',
        caretColor: 'var(--cm-cursor)',
      },
    });
    view.dispatch({
      effects: typographyCompartment.reconfigure(typographyExt),
    });
    // 强制触发字符度量重排，确保光标与字符宽度即时贴合新字体
    view.requestMeasure();
  }, [
    typography.monoFontFamily,
    typography.monoFontFamilyZh,
    typography.monoFontSize,
    typography.monoLineHeight,
  ]);

  useEffect(() => {
    const currentDoc = useDocumentStore.getState().getDocument(docKey);
    if (!containerRef.current || !currentDoc) return;
    const container = containerRef.current;
    const lang = currentDoc.language;
    const initialEditorSettings = useSettingsStore.getState().settings.editor;
    initializeDocumentHistory(docKey, currentDoc.content ?? '', 'code');

    // 内容变更监听 → 更新 store（防抖 500ms）及自动保存（800ms，仅在 auto 策略时）
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;

      const newContent = update.state.doc.toString();
      const key = docKey;
      const targetDoc = useDocumentStore.getState().getDocument(key);
      // 规范化换行符后即时计算脏态
      const isDirty = normalizeEol(newContent) !== normalizeEol(targetDoc?.baselineContent);
      setTabDirty(key, isDirty);
      useDocumentStore.getState().setDirty(key, isDirty);

      // 借助 CodeMirror 原生深度只判断输入分组边界，真正历史统一记录到文件时间线
      recordDocumentChange(key, newContent, {
        mode: 'code',
        startsNewGroup: cmUndoDepth(update.state) > cmUndoDepth(update.startState),
        beforeSelection: {
          anchor: update.startState.selection.main.anchor,
          head: update.startState.selection.main.head,
        },
        selection: {
          anchor: update.state.selection.main.anchor,
          head: update.state.selection.main.head,
        },
      });

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        setContent(key, newContent);
      }, 500);

      // 若处于 auto 自动保存策略，800ms 防抖写入磁盘
      if (targetDoc?.savePolicy === 'auto') {
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(async () => {
          const cur = useDocumentStore.getState().getDocument(key);
          if (cur?.savePolicy !== 'auto') return;
          if (cur.externalStatus === 'modified' || cur.externalStatus === 'deleted') return;
          if (normalizeEol(newContent) === normalizeEol(cur.baselineContent)) return;
          try {
            const result = await ipc.writeDocument(key, newContent, cur.encoding, cur.eol);
            if (result.ok) {
              // 以本次实际写入的快照更新保存基线；若写盘期间又有输入，仍保持脏态
              useDocumentStore.getState().updateBaseline(key, newContent, result.mtime, result.size);
              const stillDirty = useDocumentStore.getState().getDocument(key)?.isDirty ?? false;
              useWindowStore.getState().setTabDirty(key, stillDirty);
              await ipc.setDocumentDirty(key, stillDirty);
            }
          } catch (e) {
            console.error('代码/文本文件自动保存失败:', e);
          }
        }, 800);
      }
    });

    // JSON 与代码操作快捷键（展开、压缩、校验）
    const jsonOperationsKeymap = keymap.of([
      // 展开 / 格式化：Shift+Alt+F (VS Code 标准) 或 Mod-Alt-l (JetBrains 标准) 或 Mod-Alt-f
      {
        key: 'Shift-Alt-f',
        run: (v) => handleExpandJson(v, lang as LanguageId),
      },
      {
        key: 'Alt-Shift-f',
        run: (v) => handleExpandJson(v, lang as LanguageId),
      },
      {
        key: 'Mod-Alt-l',
        run: (v) => handleExpandJson(v, lang as LanguageId),
      },
      {
        key: 'Mod-Alt-f',
        run: (v) => handleExpandJson(v, lang as LanguageId),
      },
      // 压缩：Shift+Alt+M 或 Mod-Alt-m
      {
        key: 'Shift-Alt-m',
        run: (v) => handleMinifyJson(v),
      },
      {
        key: 'Alt-Shift-m',
        run: (v) => handleMinifyJson(v),
      },
      {
        key: 'Mod-Alt-m',
        run: (v) => handleMinifyJson(v),
      },
      // 校验：Shift+Alt+V 或 Mod-Alt-v 或 Mod-Alt-j
      {
        key: 'Shift-Alt-v',
        run: (v) => handleValidateJson(v),
      },
      {
        key: 'Alt-Shift-v',
        run: (v) => handleValidateJson(v),
      },
      {
        key: 'Mod-Alt-v',
        run: (v) => handleValidateJson(v),
      },
      {
        key: 'Mod-Alt-j',
        run: (v) => handleValidateJson(v),
      },
    ]);

    // 最高优先级接管撤销/重做，防止落入当前 CodeMirror 实例的局部历史
    const unifiedHistoryKeymap = Prec.highest(keymap.of([
      {
        key: 'Mod-z',
        run: () => {
          undoDocumentHistory(docKey);
          return true;
        },
      },
      {
        key: 'Mod-y',
        mac: 'Mod-Shift-z',
        run: () => {
          redoDocumentHistory(docKey);
          return true;
        },
      },
      {
        linux: 'Ctrl-Shift-z',
        run: () => {
          redoDocumentHistory(docKey);
          return true;
        },
      },
    ]));

    // 代码与纯文本排版（由 --mono-* CSS 变量驱动，并绑定主题光标）
    const typographyExt = EditorView.theme({
      '&': {
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
        height: '100%',
        caretColor: 'var(--cm-cursor)',
      },
      '.cm-scroller': {
        lineHeight: 'var(--mono-line-height, 1.5)',
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
      },
      '.cm-content, .cm-line': {
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
        caretColor: 'var(--cm-cursor)',
      },
      '.cm-content': {
        // 移除 margin: 0 auto 与 maxWidth，避免破坏 CodeMirror 虚拟选区坐标
        padding: '16px 24px',
        caretColor: 'var(--cm-cursor)',
      },
    });

    // 创建编辑器状态与实例（createBaseExtensions 已包含 typographyCompartment 与 languageCompartment）
    const state = EditorState.create({
      doc: currentDoc.content ?? '',
      extensions: [
        unifiedHistoryKeymap,
        ...createBaseExtensions(initialEditorSettings),
        updateListener,
        jsonOperationsKeymap,
      ],
    });

    const view = new EditorView({
      state,
      parent: container,
    });

    editorView = view;
    viewRef.current = view;

    // 将统一历史节点应用到当前代码编辑器；程序化替换明确不进入原生历史
    const unregisterHistoryAdapter = registerDocumentHistoryAdapter(docKey, {
      applyEntry: (entry, navigation) => {
        const documentLength = view.state.doc.length;
        const preferredSelection = navigation.selectionMode === 'code'
          ? navigation.selection
          : undefined;
        // 跨模式历史没有可直接复用的选区坐标时，定位到前后快照首个差异字符
        const fallbackPosition = Math.min(navigation.changeOffset, entry.content.length);
        const anchor = Math.max(0, Math.min(preferredSelection?.anchor ?? fallbackPosition, entry.content.length));
        const head = Math.max(0, Math.min(preferredSelection?.head ?? anchor, entry.content.length));
        view.dispatch({
          changes: view.state.doc.toString() === entry.content
            ? undefined
            : { from: 0, to: documentLength, insert: entry.content },
          selection: { anchor, head },
          annotations: Transaction.addToHistory.of(false),
          scrollIntoView: true,
        });
        // 历史导航后把输入焦点交还编辑器；不移动操作系统鼠标指针
        view.focus();
      },
    });

    // 注入当前排版配置
    view.dispatch({
      effects: typographyCompartment.reconfigure(typographyExt),
    });

    // 动态异步加载语言语法高亮与 Linter 扩展
    loadLanguageExtension(lang as LanguageId).then((ext) => {
      const lintExt = getLinterForLanguage(lang as LanguageId);
      view.dispatch({
        effects: languageCompartment.reconfigure([
          ext,
          ...(lintExt ? [lintExt] : []),
        ]),
      });
    });

    // 监听 Ctrl + 鼠标滚轮 实时缩放代码字号
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1 : -1;
      const curTypography = useSettingsStore.getState().settings.typography;
      const currentSize = curTypography.monoFontSize;
      const newSize = Math.max(10, Math.min(32, currentSize + delta));
      if (newSize !== currentSize) {
        useSettingsStore.getState().setTypography({ monoFontSize: newSize });
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      // 卸载前同步刷新权威内容，避免快速切换标签时 500ms 防抖尚未落入 store 而丢字
      const latestContent = view.state.doc.toString();
      useDocumentStore.getState().setContent(docKey, latestContent);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      unregisterHistoryAdapter();
      container.removeEventListener('wheel', handleWheel);
      view.destroy();
      editorView = null;
      viewRef.current = null;
    };
  }, [docKey, setContent, setTabDirty]);

  if (!doc) return null;

  return (
    // 外层 Flex 容器负责居中与背景色，避免内部 .cm-content 居中导致坐标偏移
    <div
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: 'var(--editor-bg)',
        display: 'flex',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        // 点击外层空白区域时自动聚焦编辑器
        if (e.target === e.currentTarget && viewRef.current) {
          viewRef.current.focus();
        }
      }}
    >
      {/* 代码/纯文本编辑器内部容器（宽度受 --mono-max-width 约束） */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          maxWidth: 'var(--mono-max-width, 100%)',
          height: '100%',
        }}
      />
    </div>
  );
}
