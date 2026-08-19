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
import { EditorState } from '@codemirror/state';
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

  useEffect(() => {
    const currentDoc = useDocumentStore.getState().getDocument(docKey);
    if (!containerRef.current || !currentDoc) return;
    const container = containerRef.current;
    const lang = currentDoc.language;
    const initialEditorSettings = useSettingsStore.getState().settings.editor;

    // 内容变更监听 → 更新 store（防抖 500ms）
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;

      const newContent = update.state.doc.toString();
      const key = docKey;
      const targetDoc = useDocumentStore.getState().getDocument(key);
      // 规范化换行符后即时计算脏态
      const isDirty = normalizeEol(newContent) !== normalizeEol(targetDoc?.baselineContent);
      setTabDirty(key, isDirty);
      useDocumentStore.getState().setDirty(key, isDirty);

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        setContent(key, newContent);
      }, 500);
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

    // 代码与纯文本排版（由 --mono-* CSS 变量驱动）
    const typographyExt = EditorView.theme({
      '&': {
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
      },
      '.cm-scroller': {
        lineHeight: 'var(--mono-line-height, 1.5)',
      },
      '.cm-content': {
        maxWidth: 'var(--content-max-width)',
        margin: '0 auto',
        padding: '16px 24px',
      },
    });

    // 创建编辑器状态与实例（createBaseExtensions 已包含 typographyCompartment 与 languageCompartment）
    const state = EditorState.create({
      doc: currentDoc.content ?? '',
      extensions: [
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
      if (debounceTimer) clearTimeout(debounceTimer);
      container.removeEventListener('wheel', handleWheel);
      view.destroy();
      editorView = null;
      viewRef.current = null;
    };
  }, [docKey, setContent, setTabDirty]);

  if (!doc) return null;

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: 'var(--editor-bg)',
      }}
    />
  );
}
