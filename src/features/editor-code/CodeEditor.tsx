// NoteBoard CodeMirror 6 编辑器组件
// 裸 CM6（new EditorView / EditorState.create），挂载到 DOM
// 详见 docs/09-开发路线图.md 4.1

import { useEffect, useRef } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import {
  createBaseExtensions,
  languageCompartment,
  themeCompartment,
  wrapCompartment,
  lineNumberCompartment,
  typographyCompartment,
} from './setup';
import { loadLanguageExtension } from './languages';
import { getLinterForLanguage } from './lint';
import { getFormatter } from './format';
import type { LanguageId } from '../../core/ipc/types';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';

// ── 编辑器实例管理 ──

/** 当前窗口的 CM6 实例（每窗口只有一个编辑器实例） */
let editorView: EditorView | null = null;

/** 导出编辑器实例（供状态栏等外部模块使用） */
export function getEditorView(): EditorView | null {
  return editorView;
}

// ── 用于动态追加扩展的 Compartment ──

const dynamicCompartment = new Compartment();

// ── React 组件 ──

interface CodeEditorProps {
  docKey: string;
}

export function CodeEditor({ docKey }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const doc = useDocumentStore((s) => s.documents.get(docKey));
  const setContent = useDocumentStore((s) => s.setContent);
  const setTabDirty = useWindowStore((s) => s.setTabDirty);

  useEffect(() => {
    if (!containerRef.current || !doc) return;

    // 创建编辑器
    const state = EditorState.create({
      doc: doc.content ?? '',
      extensions: [
        ...createBaseExtensions(),
        dynamicCompartment.of([]),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    editorView = view;

    const isPlaintext = doc.language === 'plaintext';
    const typographyExt = EditorView.theme({
      '&': {
        fontFamily: isPlaintext ? 'var(--content-font-family)' : 'var(--mono-font-family)',
        fontSize: isPlaintext ? 'var(--content-font-size)' : 'var(--mono-font-size)',
      },
      '.cm-scroller': {
        lineHeight: 'var(--content-line-height)',
      },
      '.cm-content': {
        maxWidth: 'var(--content-max-width)',
        margin: '0 auto',
        padding: '16px 24px',
      },
    });

    // 动态加载语言与排版
    const lang = doc.language;
    loadLanguageExtension(lang as LanguageId).then((ext) => {
      const lintExt = getLinterForLanguage(lang as LanguageId);
      view.dispatch({
        effects: [
          typographyCompartment.reconfigure(typographyExt),
          dynamicCompartment.reconfigure([
            ext,
            ...(lintExt ? [lintExt] : []),
          ]),
        ],
      });
    });

    // 内容变更监听 → 更新 store（防抖 500ms）
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;

      const newContent = update.state.doc.toString();
      const key = docKey;

      // 防抖更新 store（500ms）
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        setContent(key, newContent);
        const updatedDoc = useDocumentStore.getState().documents.get(key);
        setTabDirty(key, updatedDoc?.isDirty ?? true);
      }, 500);
    });

    // 格式化快捷键 Shift+Alt+F
    const formatKeymap = keymap.of([
      {
        key: 'Shift-Alt-f',
        run: (v) => {
          const formatter = getFormatter(lang as LanguageId);
          if (!formatter) return false;
          try {
            const source = v.state.doc.toString();
            const formatted = formatter(source);
            v.dispatch({
              changes: { from: 0, to: source.length, insert: formatted },
            });
            return true;
          } catch {
            return false;
          }
        },
      },
    ]);

    // 追加 updateListener 和 formatKeymap
    view.dispatch({
      effects: dynamicCompartment.reconfigure([updateListener, formatKeymap]),
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      view.destroy();
      editorView = null;
    };
  }, [docKey, doc, setContent, setTabDirty]);

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
