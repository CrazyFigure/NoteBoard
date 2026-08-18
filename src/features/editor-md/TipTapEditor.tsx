// NoteBoard TipTap Markdown 编辑器
// visual 模式 + source 模式切换 + 自动保存
// 详见 docs/09-开发路线图.md 7.1-7.7, 7.12
//
// 移植自 note-gen，但只取最小扩展集。
// 关键设计：
// 1. 编辑器内核持有内容权威副本，store 里的是防抖后镜像
// 2. onUpdate 500ms → store；800ms → 盘（auto 策略）
// 3. 切模式时保持光标位置与滚动位置

import { useEffect, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';

import { buildExtensions } from './extensions';
import { lowlight } from './lowlight';
import { serializeMarkdown, parseMarkdown, getBaseline, removeBaseline } from './serialize';
import { judgeLargeDoc } from './largeDoc';
import { nbEditorTheme } from '../editor-code/theme';
import { nbSyntaxHighlighting } from '../editor-code/highlightStyle';
import { createBaseExtensions } from '../editor-code/setup';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { useSettingsStore } from '../../stores/settingsStore';
import * as ipc from '../../core/ipc/commands';
import { registerShortcut } from '../../core/shortcuts';
import { EditorBubbleMenu, TableToolbar } from './bubbleMenu';
import { BlockDragHandle } from './blockDragHandle';
import { ExternalChangeBanner } from './ExternalChangeBanner';
import { EditorContextMenu } from './EditorContextMenu';

// 活跃 TipTap 实例表（供保存编排即时读取最新内容）
const activeTipTapEditors = new Map<string, Editor>();

export function getActiveTipTapEditor(key: string): Editor | undefined {
  return activeTipTapEditors.get(key);
}

interface TipTapEditorProps {
  docKey: string;
  onEditorReady?: (editor: Editor | null) => void;
}

export function TipTapEditor({ docKey, onEditorReady }: TipTapEditorProps) {
  const [viewMode, setViewMode] = useState<'visual' | 'source'>('visual');
  const [showLargeBanner, setShowLargeBanner] = useState(false);
  const [largeVerdict, setLargeVerdict] = useState<ReturnType<typeof judgeLargeDoc> | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const sourceViewRef = useRef<EditorView | null>(null);
  const sourceDivRef = useRef<HTMLDivElement>(null);
  const storeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diskTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedDocKeyRef = useRef<string | null>(null);

  const docStore = useDocumentStore();
  const doc = docStore.getDocument(docKey);
  const tabStore = useWindowStore();
  const settings = useSettingsStore((s) => s.settings);

  // 初始化 TipTap 编辑器
  const editor = useEditor({
    extensions: buildExtensions(),
    content: '',
    onUpdate: ({ editor }) => {
      const content = serializeMarkdown(editor);
      tabStore.setTabDirty(docKey, true);

      // 500ms → store（防抖）
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      storeTimerRef.current = setTimeout(() => {
        docStore.setContent(docKey, content);
      }, 500);

      // 800ms → 盘（auto 策略）
      if (diskTimerRef.current) clearTimeout(diskTimerRef.current);
      diskTimerRef.current = setTimeout(async () => {
        await autoSave(docKey, content);
      }, 800);
    },
    editorProps: {
      attributes: {
        class: 'nb-prose',
        style: 'outline: none; max-width: var(--content-max-width); margin: 0 auto; padding: 16px 24px; min-height: 100%; font-size: var(--content-font-size); line-height: var(--content-line-height); font-family: var(--content-font-family); color: var(--editor-text);',
      },
    },
  }, [docKey]);

  // 注册当前活跃 editor 实例给外部（如大纲与保存）
  useEffect(() => {
    if (editor) {
      activeTipTapEditors.set(docKey, editor);
      onEditorReady?.(editor);
    }
    return () => {
      activeTipTapEditors.delete(docKey);
      onEditorReady?.(null);
    };
  }, [editor, docKey, onEditorReady]);

  // 初始化内容 + 大文档判定（仅在 docKey 变更或初次加载时执行，不可随 doc.content 变化重复 parse）
  useEffect(() => {
    if (!editor) return;
    if (initializedDocKeyRef.current === docKey) return;

    const currentDoc = docStore.getDocument(docKey);
    if (!currentDoc) return;
    initializedDocKeyRef.current = docKey;

    const content = currentDoc.content ?? '';

    // 大文档判定
    const verdict = judgeLargeDoc(content, currentDoc.size);
    setLargeVerdict(verdict);

    if (verdict.isLarge) {
      setShowLargeBanner(true);
      // 强制 source 模式
      setViewMode('source');
      tabStore.setTabViewMode(docKey, 'source');
      // 不设置内容到 TipTap（太大会卡）
    } else {
      setShowLargeBanner(false);
      // 正常文档：设置内容到编辑器
      const baseline = getBaseline(docKey);
      if (!baseline.getBaseline()) {
        baseline.setBaseline(content);
      }
      parseMarkdown(editor, content);
    }

    // 设置 viewMode（从 tab 恢复）
    const tab = tabStore.getTab(docKey);
    if (tab?.viewMode) {
      setViewMode(tab.viewMode);
    } else if (!verdict.isLarge) {
      setViewMode(settings.editor.defaultViewMode);
    }
  }, [editor, docKey, docStore, tabStore, settings.editor.defaultViewMode]);

  // Ctrl+/ 模式切换
  useEffect(() => {
    if (!editor) return;
    const unreg = registerShortcut({
      key: 'Ctrl+/',
      action: () => {
        toggleViewMode();
      },
      scope: 'editor',
      description: '切换 Markdown 视图模式',
    });
    return () => unreg();
  }, [editor]);

  // 切换模式
  const toggleViewMode = useCallback(() => {
    if (!editor) return;

    if (viewMode === 'visual') {
      // visual → source
      const md = serializeMarkdown(editor);
      initSourceEditor(md);
      setViewMode('source');
      tabStore.setTabViewMode(docKey, 'source');
    } else {
      // source → visual
      if (sourceViewRef.current) {
        const md = sourceViewRef.current.state.doc.toString();
        parseMarkdown(editor, md);

        // 不变式 I-14 检查：切回 visual 后内容是否与基线一致
        const baseline = getBaseline(docKey);
        const serialized = serializeMarkdown(editor);
        if (baseline.isClean(serialized)) {
          // 不脏
          docStore.setDirty(docKey, false);
          tabStore.setTabDirty(docKey, false);
        }
      }
      setViewMode('visual');
      tabStore.setTabViewMode(docKey, 'visual');
    }
  }, [editor, viewMode, docKey]);

  // 初始化 source 模式编辑器（CM6 + markdown）
  const initSourceEditor = useCallback((content: string) => {
    if (!sourceDivRef.current) return;

    // 销毁旧实例
    if (sourceViewRef.current) {
      sourceViewRef.current.destroy();
    }

    const state = EditorState.create({
      doc: content,
      extensions: [
        ...createBaseExtensions(),
        markdown(),
        nbSyntaxHighlighting,
        nbEditorTheme,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
      ],
    });

    sourceViewRef.current = new EditorView({
      state,
      parent: sourceDivRef.current,
    });
  }, []);

  // 自动保存
  const autoSave = useCallback(async (key: string, content: string) => {
    const docStore = useDocumentStore.getState();
    const doc = docStore.getDocument(key);
    if (!doc) return;

    // 只有 auto 策略才自动保存
    if (doc.savePolicy !== 'auto') return;

    // 外部变更/断开状态不自动保存
    if (doc.externalStatus === 'modified' || doc.externalStatus === 'deleted') return;

    // 比较内容是否与基线不同
    const baseline = getBaseline(key);
    if (baseline.isClean(content)) {
      // 内容与基线一致 → 不需要保存
      docStore.setDirty(key, false);
      tabStore.setTabDirty(key, false);
      return;
    }

    try {
      const result = await ipc.writeDocument(key, content, doc.encoding, doc.eol);
      if (result.ok) {
        docStore.updateBaseline(key, result.mtime, result.size);
        baseline.updateBaseline(content);
        tabStore.setTabDirty(key, false);
        // 同步注册表脏态
        await ipc.setDocumentDirty(key, false);
      }
    } catch (e) {
      console.error('自动保存失败:', e);
    }
  }, [tabStore]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      initializedDocKeyRef.current = null;
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      if (diskTimerRef.current) clearTimeout(diskTimerRef.current);
      if (sourceViewRef.current) {
        sourceViewRef.current.destroy();
        sourceViewRef.current = null;
      }
      removeBaseline(docKey);
    };
  }, [docKey]);

  // 大文档横幅
  if (showLargeBanner && largeVerdict) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div
          style={{
            padding: '12px 16px',
            background: 'var(--warning-50)',
            borderBottom: '1px solid var(--warning-200)',
            fontSize: 13,
            color: 'var(--editor-text)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span>📄</span>
          <span>
            此文件较大（{(largeVerdict.charCount / 1000).toFixed(0)}k 字符），已切换到源码模式。
            {largeVerdict.suggestedMode === 'section' && ' 可使用分段编辑模式。'}
          </span>
          <button
            style={{
              marginLeft: 'auto',
              padding: '4px 12px',
              border: '1px solid var(--editor-border)',
              borderRadius: 3,
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 12,
            }}
            onClick={() => {
              setShowLargeBanner(false);
              if (editor && doc?.content) {
                parseMarkdown(editor, doc.content);
                setViewMode('visual');
              }
            }}
          >
            仍要使用可视化编辑
          </button>
        </div>
        {renderSourceMode()}
      </div>
    );
  }

  // 渲染 source 模式
  function renderSourceMode() {
    return (
      <div
        ref={sourceDivRef}
        style={{
          height: '100%',
          overflow: 'hidden',
          background: 'var(--editor-bg)',
        }}
      />
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'hidden', position: 'relative' }} ref={editorRef}>
      <ExternalChangeBanner docKey={docKey} />
      {viewMode === 'visual' ? (
        <div
          style={{ height: '100%', overflow: 'auto', position: 'relative' }}
          onContextMenu={(e) => {
            if (!editor) return;
            e.preventDefault();
            e.stopPropagation();

            const { empty } = editor.state.selection;
            if (empty) {
              const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
              if (pos) {
                editor.commands.setTextSelection(pos.pos);
              }
            }
            setContextMenu({
              x: e.clientX,
              y: e.clientY,
              hasSelection: !empty,
            });
          }}
        >
          {editor && <EditorBubbleMenu editor={editor} />}
          {editor && <TableToolbar editor={editor} />}
          {editor && <BlockDragHandle editor={editor} />}
          {contextMenu && editor && (
            <EditorContextMenu
              editor={editor}
              position={{ x: contextMenu.x, y: contextMenu.y }}
              hasSelection={contextMenu.hasSelection}
              onClose={() => setContextMenu(null)}
            />
          )}
          <EditorContent editor={editor} style={{ height: '100%' }} />
        </div>
      ) : (
        renderSourceMode()
      )}
    </div>
  );
}
