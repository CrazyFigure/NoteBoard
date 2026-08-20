// NoteBoard TipTap Markdown 编辑器
// visual 模式 + source 模式切换 + 自动保存
// 详见 docs/09-开发路线图.md 7.1-7.7, 7.12
//
// 关键设计：
// 1. 编辑器内核持有内容权威副本，store 里的是防抖后镜像
// 2. onUpdate 500ms → store；800ms → 盘（auto 策略）
// 3. 切模式时保持光标位置与滚动位置

import { useEffect, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec, Transaction as CodeMirrorTransaction } from '@codemirror/state';
import { undoDepth as codeMirrorUndoDepth } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { undoDepth as prosemirrorUndoDepth } from '@tiptap/pm/history';

import { buildExtensions } from './extensions';
import { lowlight } from './lowlight';
import {
  serializeMarkdown,
  parseMarkdown,
  getBaseline,
  normalizeEol,
  hasMarkdownContentChanged,
} from './serialize';
import { judgeLargeDoc } from './largeDoc';
import { nbEditorTheme } from '../editor-code/theme';
import { nbSyntaxHighlighting } from '../editor-code/highlightStyle';
import { createBaseExtensions, typographyCompartment } from '../editor-code/setup';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { useSettingsStore } from '../../stores/settingsStore';
import * as ipc from '../../core/ipc/commands';
import { registerShortcut } from '../../core/shortcuts';
import { on, off, emit } from '../../core/emitter';
import { MarkdownModeToggle } from './MarkdownModeToggle';
import { EditorBubbleMenu, TableToolbar } from './bubbleMenu';
import { BlockDragHandle } from './blockDragHandle';
import { ExternalChangeBanner } from './ExternalChangeBanner';
import { EditorContextMenu } from './EditorContextMenu';
import { LinkModal } from './LinkModal';
import { handlePastedImageFile } from './imagePaste';
import {
  getCurrentDocumentHistoryContent,
  initializeDocumentHistory,
  markDocumentHistoryModeBoundary,
  recordDocumentChange,
  redoDocumentHistory,
  registerDocumentHistoryAdapter,
  synchronizeCurrentDocumentHistoryContent,
  undoDocumentHistory,
} from '../history/documentHistory';

// 活跃 TipTap 实例表（供保存编排即时读取最新内容）
const activeTipTapEditors = new Map<string, Editor>();
// 活跃 Markdown 源码模式 CM6 实例表
const activeSourceViews = new Map<string, EditorView>();

export function getActiveTipTapEditor(key: string): Editor | undefined {
  return activeTipTapEditors.get(key);
}

export function getActiveSourceView(key: string): EditorView | undefined {
  return activeSourceViews.get(key);
}

interface TipTapEditorProps {
  docKey: string;
  onEditorReady?: (editor: Editor | null) => void;
}

export function TipTapEditor({ docKey, onEditorReady }: TipTapEditorProps) {
  const [viewMode, setViewMode] = useState<'visual' | 'source'>('visual');
  // 始终记录最新模式，供只在真正卸载时执行的清理逻辑读取
  const viewModeRef = useRef<'visual' | 'source'>('visual');
  const [showLargeBanner, setShowLargeBanner] = useState(false);
  const [largeVerdict, setLargeVerdict] = useState<ReturnType<typeof judgeLargeDoc> | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  // 超链接插入与编辑弹窗状态
  const [linkModalState, setLinkModalState] = useState<{
    isOpen: boolean;
    initialText: string;
    initialUrl: string;
    isEditing: boolean;
    from: number;
    to: number;
  } | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  // 持有最新 TipTap 实例，供仅按 docKey 注册的卸载清理读取，避免模式切换触发误清理
  const tipTapEditorRef = useRef<Editor | null>(null);
  const sourceViewRef = useRef<EditorView | null>(null);
  const sourceDivRef = useRef<HTMLDivElement>(null);
  const storeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diskTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedDocKeyRef = useRef<string | null>(null);
  // TipTap 原生历史仅用来识别连续输入是否属于同一分组，快捷键由文档级历史接管
  const visualUndoDepthRef = useRef(0);
  // 初始化锁：在初次加载和程序化设置内容期间阻止 onUpdate 误标为脏
  const isInitializingRef = useRef<boolean>(true);

  const settings = useSettingsStore((s) => s.settings);
  const typography = settings.typography;

  // 模式变化仅刷新引用，不重新注册卸载清理，避免切换模式时误销毁源码历史栈
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  // 监听排版字体与字号变化并热重配源码模式 CM6 实例
  useEffect(() => {
    const view = sourceViewRef.current;
    if (!view) return;
    const typographyExt = EditorView.theme({
      '&': {
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
        height: '100%',
      },
      '.cm-scroller': {
        lineHeight: 'var(--mono-line-height, 1.5)',
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
      },
      '.cm-content, .cm-line': {
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
      },
      '.cm-content': {
        padding: '16px 24px',
      },
    });


    view.dispatch({
      effects: typographyCompartment.reconfigure(typographyExt),
    });
    view.requestMeasure();
  }, [
    typography.monoFontFamily,
    typography.monoFontFamilyZh,
    typography.monoFontSize,
    typography.monoLineHeight,
  ]);

  // 保持对 handleOpenLinkModal 的实时引用，供 LinkClickHandler 扩展在单击超链接时唤起弹窗
  const openLinkModalRef = useRef<() => void>(() => {});

  // 初始化 TipTap 编辑器
  const editor = useEditor({
    extensions: buildExtensions(docKey, {
      onOpenLinkModal: () => {
        openLinkModalRef.current();
      },
    }),
    content: '',
    onUpdate: ({ editor, transaction }) => {
      // 若处于初始化流程或事务未引起文档实际变更，则直接跳过
      if (isInitializingRef.current || !transaction.docChanged) {
        return;
      }

      const content = serializeMarkdown(editor);
      const baseline = getBaseline(docKey).getBaseline() ?? useDocumentStore.getState().getDocument(docKey)?.baselineContent ?? '';
      // 规范化换行符后比对是否真正改变
      const isDirty = normalizeEol(content) !== normalizeEol(baseline);

      useWindowStore.getState().setTabDirty(docKey, isDirty);
      useDocumentStore.getState().setDirty(docKey, isDirty);

      const nativeUndoDepth = prosemirrorUndoDepth(editor.state);
      recordDocumentChange(docKey, content, {
        mode: 'visual',
        startsNewGroup: nativeUndoDepth > visualUndoDepthRef.current,
        // TipTap 事务不公开初始选区；文档首差异位置就是本次修改在旧文档中的稳定落点
        beforeSelection: (() => {
          const position = transaction.before.content.findDiffStart(transaction.doc.content);
          return position == null ? undefined : { anchor: position, head: position };
        })(),
        selection: {
          anchor: editor.state.selection.anchor,
          head: editor.state.selection.head,
        },
      });
      visualUndoDepthRef.current = nativeUndoDepth;

      // 500ms → store（防抖更新内存镜像）
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      storeTimerRef.current = setTimeout(() => {
        useDocumentStore.getState().setContent(docKey, content);
      }, 500);

      // 800ms → 盘（auto 策略，仅在脏且为 auto 策略时自动写入）
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
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file && editor) {
              event.preventDefault();
              handlePastedImageFile(editor, file, docKey);
              return true;
            }
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        for (const file of Array.from(files)) {
          if (file.type.startsWith('image/')) {
            if (editor) {
              event.preventDefault();
              handlePastedImageFile(editor, file, docKey);
              return true;
            }
          }
        }
        return false;
      },
    },
  }, [docKey]);

  // 注册当前活跃 editor 实例给外部（如大纲与保存）
  useEffect(() => {
    if (editor) {
      tipTapEditorRef.current = editor;
      activeTipTapEditors.set(docKey, editor);
      onEditorReady?.(editor);
    }
    return () => {
      activeTipTapEditors.delete(docKey);
      onEditorReady?.(null);
    };
  }, [editor, docKey, onEditorReady]);

  // 自动保存（声明在模式切换前供引用）
  const autoSave = useCallback(async (key: string, content: string) => {
    const dStore = useDocumentStore.getState();
    const targetDoc = dStore.getDocument(key);
    if (!targetDoc) return;

    // 只有 auto 策略才自动保存
    if (targetDoc.savePolicy !== 'auto') return;

    // 外部变更/断开状态不自动保存
    if (targetDoc.externalStatus === 'modified' || targetDoc.externalStatus === 'deleted') return;

    // 比较内容是否与基线不同
    const baseline = getBaseline(key);
    if (baseline.isClean(content)) {
      // 内容与基线一致 → 不需要保存
      dStore.setDirty(key, false);
      useWindowStore.getState().setTabDirty(key, false);
      return;
    }

    try {
      const result = await ipc.writeDocument(key, content, targetDoc.encoding, targetDoc.eol);
      if (result.ok) {
        // 使用本次实际写入的内容更新基线；写盘期间的新输入不能被误标为已保存
        dStore.updateBaseline(key, content, result.mtime, result.size);
        baseline.updateBaseline(content);
        const stillDirty = dStore.getDocument(key)?.isDirty ?? false;
        useWindowStore.getState().setTabDirty(key, stillDirty);
        // 同步注册表脏态
        await ipc.setDocumentDirty(key, stillDirty);
      }
    } catch (e) {
      console.error('自动保存失败:', e);
    }
  }, []);

  // 初始化 source 模式编辑器（CM6 + markdown）
  const initSourceEditor = useCallback((content: string) => {
    if (!sourceDivRef.current) return;

    // 已创建的源码编辑器必须复用；模式同步只更新视图，不得写入文件级或原生历史
    if (sourceViewRef.current) {
      const currentContent = sourceViewRef.current.state.doc.toString();
      if (currentContent !== content) {
        sourceViewRef.current.dispatch({
          changes: {
            from: 0,
            to: sourceViewRef.current.state.doc.length,
            insert: content,
          },
          annotations: CodeMirrorTransaction.addToHistory.of(false),
        });
      }
      activeSourceViews.set(docKey, sourceViewRef.current);
      return;
    }

    // 源码模式输入监听与自动标脏
    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const newContent = update.state.doc.toString();
      const baseline = getBaseline(docKey).getBaseline() ?? useDocumentStore.getState().getDocument(docKey)?.baselineContent ?? '';
      const isDirty = normalizeEol(newContent) !== normalizeEol(baseline);
      useWindowStore.getState().setTabDirty(docKey, isDirty);
      useDocumentStore.getState().setDirty(docKey, isDirty);

      // 源码事务按 CodeMirror 原生分组边界逐步写入同一条文件历史
      recordDocumentChange(docKey, newContent, {
        mode: 'source',
        startsNewGroup: codeMirrorUndoDepth(update.state) > codeMirrorUndoDepth(update.startState),
        beforeSelection: {
          anchor: update.startState.selection.main.anchor,
          head: update.startState.selection.main.head,
        },
        selection: {
          anchor: update.state.selection.main.anchor,
          head: update.state.selection.main.head,
        },
      });

      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      storeTimerRef.current = setTimeout(() => {
        useDocumentStore.getState().setContent(docKey, newContent);
      }, 500);

      if (diskTimerRef.current) clearTimeout(diskTimerRef.current);
      diskTimerRef.current = setTimeout(async () => {
        await autoSave(docKey, newContent);
      }, 800);
    });

    const state = EditorState.create({
      doc: content,
      extensions: [
        // 最高优先级接管源码快捷键，禁止回落到 CodeMirror 的局部历史
        Prec.highest(keymap.of([
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
        ])),
        ...createBaseExtensions(),
        markdown(),
        nbSyntaxHighlighting,
        nbEditorTheme,
        EditorView.lineWrapping,
        updateListener,
      ],
    });

    const view = new EditorView({
      state,
      parent: sourceDivRef.current,
    });

    // 注入源码模式排版配置
    const typographyExt = EditorView.theme({
      '&': {
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
        height: '100%',
      },
      '.cm-scroller': {
        lineHeight: 'var(--mono-line-height, 1.5)',
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
      },
      '.cm-content, .cm-line': {
        fontFamily: 'var(--mono-font-family)',
        fontSize: 'var(--mono-font-size)',
      },
      '.cm-content': {
        padding: '16px 24px',
      },
    });
    view.dispatch({
      effects: typographyCompartment.reconfigure(typographyExt),
    });

    sourceViewRef.current = view;
    activeSourceViews.set(docKey, view);
  }, [docKey, autoSave]);

  // 当前可见模式负责呈现统一历史节点，另一内核会在下次切换时无历史地同步到同一内容
  useEffect(() => {
    if (!editor) return;
    return registerDocumentHistoryAdapter(docKey, {
      applyEntry: (entry, navigation) => {
        if (viewModeRef.current === 'source') {
          if (!sourceViewRef.current) {
            initSourceEditor(entry.content);
          }
          const view = sourceViewRef.current;
          if (!view) return;
          const preferredSelection = navigation.selectionMode === 'source'
            ? navigation.selection
            : undefined;
          // 可视化历史切到源码呈现时，用 Markdown 文本首差异位置作为可靠落点
          const fallbackPosition = Math.min(navigation.changeOffset, entry.content.length);
          const anchor = Math.max(0, Math.min(preferredSelection?.anchor ?? fallbackPosition, entry.content.length));
          const head = Math.max(0, Math.min(preferredSelection?.head ?? anchor, entry.content.length));
          view.dispatch({
            changes: view.state.doc.toString() === entry.content
              ? undefined
              : { from: 0, to: view.state.doc.length, insert: entry.content },
            selection: { anchor, head },
            annotations: CodeMirrorTransaction.addToHistory.of(false),
            scrollIntoView: true,
          });
          view.focus();
          return;
        }

        const previousVisualDocument = editor.state.doc;
        if (hasMarkdownContentChanged(editor, entry.content)) {
          // 统一历史应用属于导航而非新编辑，整篇替换明确排除出 TipTap 原生历史
          parseMarkdown(editor, entry.content);
        }
        synchronizeCurrentDocumentHistoryContent(
          docKey,
          serializeMarkdown(editor),
          'visual',
        );
        const preferredSelection = navigation.selectionMode === 'visual'
          ? navigation.selection
          : undefined;
        // 跨源码历史时，比较解析前后的 ProseMirror 文档，避免把 Markdown 标记字符偏移直接当节点坐标
        const visualChangePosition = previousVisualDocument.content.findDiffStart(editor.state.doc.content);
        const maxPosition = editor.state.doc.content.size;
        const fallbackPosition = visualChangePosition ?? Math.min(navigation.changeOffset, maxPosition);
        const anchor = Math.max(1, Math.min(preferredSelection?.anchor ?? fallbackPosition, maxPosition));
        const head = Math.max(1, Math.min(preferredSelection?.head ?? anchor, maxPosition));
        editor
          .chain()
          .setTextSelection({ from: anchor, to: head })
          .scrollIntoView()
          .focus()
          .run();
      },
    });
  }, [docKey, editor, initSourceEditor]);

  // 初始化内容 + 大文档判定（仅在 docKey 变更或初次加载时执行，不可随 doc.content 变化重复 parse）
  useEffect(() => {
    if (!editor) return;
    if (initializedDocKeyRef.current === docKey) return;

    const currentDoc = useDocumentStore.getState().getDocument(docKey);
    if (!currentDoc) return;
    initializedDocKeyRef.current = docKey;

    const content = currentDoc.content ?? '';

    // 大文档判定
    const verdict = judgeLargeDoc(content, currentDoc.size);
    setLargeVerdict(verdict);
    // 先确定初始模式，文件历史的首节点必须采用当前权威内核实际展示的内容
    const tab = useWindowStore.getState().getTab(docKey);
    const initialMode = tab?.viewMode ?? (verdict.isLarge ? 'source' : settings.editor.defaultViewMode);
    let historyInitialContent = content;

    if (verdict.isLarge) {
      setShowLargeBanner(true);
      // 强制 source 模式
      setViewMode('source');
      useWindowStore.getState().setTabViewMode(docKey, 'source');
      // 不设置内容到 TipTap（太大会卡）
    } else {
      setShowLargeBanner(false);
      // 开启初始化防抖锁
      isInitializingRef.current = true;

      // 正常文档：设置内容到编辑器
      const baseline = getBaseline(docKey);
      try {
        parseMarkdown(editor, content);

        // 若文档当前为未修改状态，确保基线与初始解析序列化结果严格对齐，彻底消除格式化细微差异导致的假脏态
        const initialSerialized = serializeMarkdown(editor);
        // 初始为可视化模式时，以可视化序列化结果建立文件历史首节点
        if (initialMode === 'visual') {
          historyInitialContent = initialSerialized;
        }
        if (!currentDoc.isDirty) {
          baseline.setBaseline(initialSerialized);
          useDocumentStore.getState().setContent(docKey, initialSerialized);
          useDocumentStore.getState().setBaselineContent(docKey, initialSerialized);
          useDocumentStore.getState().setDirty(docKey, false);
          useWindowStore.getState().setTabDirty(docKey, false);
        } else if (!baseline.getBaseline()) {
          baseline.setBaseline(content);
        }
      } finally {
        // 确保初始化锁在解析完成后稳定解除
        setTimeout(() => {
          isInitializingRef.current = false;
        }, 50);
      }
    }

    // 设置 viewMode（从 tab 恢复）
    viewModeRef.current = initialMode;
    setViewMode(initialMode);
    initializeDocumentHistory(docKey, historyInitialContent, initialMode);
    visualUndoDepthRef.current = prosemirrorUndoDepth(editor.state);
    if (initialMode === 'source') {
      // 延迟确保源码容器完成挂载；历史本身已独立于编辑器模式初始化
      setTimeout(() => {
        initSourceEditor(historyInitialContent);
      }, 0);
    }
  }, [editor, docKey, settings.editor.defaultViewMode, initSourceEditor]);

  // 切换可视化 / 源码模式（可指定目标模式 targetMode，只影响当前活动文档）
  const toggleViewMode = useCallback((targetMode?: 'visual' | 'source') => {
    if (!editor) return;

    const nextMode = targetMode ?? (viewMode === 'visual' ? 'source' : 'visual');
    if (nextMode === viewMode) return;

    if (nextMode === 'source') {
      // 可视化 → 源码模式
      const md = getCurrentDocumentHistoryContent(docKey) ?? serializeMarkdown(editor);
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      useDocumentStore.getState().setContent(docKey, md);
      initSourceEditor(md);
      markDocumentHistoryModeBoundary(docKey);
      viewModeRef.current = 'source';
      setViewMode('source');
      useWindowStore.getState().setTabViewMode(docKey, 'source');
      emit('view-mode-changed', { key: docKey, mode: 'source' });
      setTimeout(() => {
        sourceViewRef.current?.focus();
        sourceViewRef.current?.requestMeasure();
      }, 20);
    } else {
      // 源码 → 可视化模式
      const md = sourceViewRef.current
        ? (getCurrentDocumentHistoryContent(docKey) ?? sourceViewRef.current.state.doc.toString())
        : (useDocumentStore.getState().getDocument(docKey)?.content ?? '');
      // 模式同步不产生历史节点；文件级时间线已经逐步记录了源码阶段的真实编辑
      const hasCrossModeChanges = hasMarkdownContentChanged(editor, md);
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      useDocumentStore.getState().setContent(docKey, md);
      if (hasCrossModeChanges) {
        isInitializingRef.current = true;
        try {
          // 只同步目标视图，明确不加入 TipTap 局部历史
          parseMarkdown(editor, md);
        } finally {
          isInitializingRef.current = false;
        }
      }

      // 不变式 I-14 检查：切回 visual 后内容是否与基线一致
      const baseline = getBaseline(docKey);
      const serialized = serializeMarkdown(editor);
      // Markdown 等价格式的规范化只更新当前节点表示，不得伪造成新的编辑步骤
      synchronizeCurrentDocumentHistoryContent(docKey, serialized, 'visual');
      if (baseline.isClean(serialized)) {
        // 内容未变，保持非脏态
        useDocumentStore.getState().setDirty(docKey, false);
        useWindowStore.getState().setTabDirty(docKey, false);
      } else {
        useDocumentStore.getState().setContent(docKey, serialized);
      }
      markDocumentHistoryModeBoundary(docKey);
      viewModeRef.current = 'visual';
      setViewMode('visual');
      useWindowStore.getState().setTabViewMode(docKey, 'visual');
      emit('view-mode-changed', { key: docKey, mode: 'visual' });
      setTimeout(() => {

        editor.commands.focus();
      }, 20);
    }
  }, [editor, viewMode, docKey, initSourceEditor]);

  // 监听来自状态栏或外部的模式切换请求
  useEffect(() => {
    const handleToggle = (payload: { key?: string; mode?: 'visual' | 'source' }) => {
      if (!payload.key || payload.key === docKey) {
        toggleViewMode(payload.mode);
      }
    };
    on('toggle-md-view-mode', handleToggle);
    return () => {
      off('toggle-md-view-mode', handleToggle);
    };
  }, [docKey, toggleViewMode]);

  // 打开超链接插入与编辑模态弹窗
  const handleOpenLinkModal = useCallback(() => {
    if (!editor) return;

    let from = editor.state.selection.from;
    let to = editor.state.selection.to;
    let initialText = '';
    let initialUrl = '';
    let isEditing = false;

    // 1. 若光标处于已有超链接标记内，扩展选区到完整链接范围并回显信息
    if (editor.isActive('link')) {
      isEditing = true;
      editor.commands.extendMarkRange('link');
      from = editor.state.selection.from;
      to = editor.state.selection.to;
      initialText = editor.state.doc.textBetween(from, to);
      initialUrl = editor.getAttributes('link').href || '';
    } else if (!editor.state.selection.empty) {
      // 2. 当前选中了普通文本
      initialText = editor.state.doc.textBetween(from, to);
      initialUrl = '';
    } else {
      // 3. 空选区插入新超链接
      initialText = '';
      initialUrl = '';
    }

    setLinkModalState({
      isOpen: true,
      initialText,
      initialUrl,
      isEditing,
      from,
      to,
    });
  }, [editor]);
  openLinkModalRef.current = handleOpenLinkModal;

  // 确认提交超链接
  const handleConfirmLink = useCallback(
    ({ text, url }: { text: string; url: string }) => {
      if (!editor || !linkModalState) return;

      const { from, to } = linkModalState;
      const targetUrl = url.trim();
      if (!targetUrl) {
        editor.chain().focus().setTextSelection({ from, to }).unsetLink().run();
        setLinkModalState(null);
        return;
      }

      const finalText = text.trim() || targetUrl;
      const originalText = editor.state.doc.textBetween(from, to);

      // 若文本未变且原本非空，仅更新 link 标记属性
      if (originalText === finalText && originalText.length > 0) {
        editor
          .chain()
          .focus()
          .setTextSelection({ from, to })
          .setLink({ href: targetUrl })
          .run();
      } else {
        // 替换文本并挂载超链接标记
        editor
          .chain()
          .focus()
          .setTextSelection({ from, to })
          .insertContent({
            type: 'text',
            text: finalText,
            marks: [
              {
                type: 'link',
                attrs: { href: targetUrl },
              },
            ],
          })
          .run();
      }
      setLinkModalState(null);
    },
    [editor, linkModalState]
  );

  // 移除超链接
  const handleRemoveLink = useCallback(() => {
    if (!editor || !linkModalState) return;
    const { from, to } = linkModalState;
    editor.chain().focus().setTextSelection({ from, to }).unsetLink().run();
    setLinkModalState(null);
  }, [editor, linkModalState]);

  // 注册当前 Markdown 文档专用的 Ctrl+/ 模式切换快捷键
  useEffect(() => {
    const unreg = registerShortcut({
      key: 'Ctrl+/',
      action: () => {
        const activeKey = useWindowStore.getState().activeKey;
        if (activeKey === docKey) {
          toggleViewMode();
        }
      },
      scope: 'global',
      description: '切换 Markdown 可视化 / 源码模式',
    });
    return () => {
      unreg();
    };
  }, [docKey, toggleViewMode]);

  // 注册当前 Markdown 文档专用的 Ctrl+K 插入/编辑超链接快捷键
  useEffect(() => {
    const unreg = registerShortcut({
      key: 'Ctrl+K',
      action: () => {
        const activeKey = useWindowStore.getState().activeKey;
        if (activeKey === docKey && viewMode === 'visual') {
          handleOpenLinkModal();
        }
      },
      scope: 'global',
      description: '插入或编辑超链接',
    });
    return () => {
      unreg();
    };
  }, [docKey, viewMode, handleOpenLinkModal]);

  // 组件卸载时清理（注意：不要删除基线，以便切回 Tab 时仍能保持正确的脏态判定）
  useEffect(() => {
    return () => {
      // 组件卸载前立即刷新当前模式的最新内容，防止快速切换标签页导致防抖镜像落后
      const currentMode = useWindowStore.getState().getTab(docKey)?.viewMode ?? viewModeRef.current;
      const latestContent = currentMode === 'source' && sourceViewRef.current
        ? sourceViewRef.current.state.doc.toString()
        : tipTapEditorRef.current
          ? serializeMarkdown(tipTapEditorRef.current)
          : useDocumentStore.getState().getDocument(docKey)?.content ?? '';
      useDocumentStore.getState().setContent(docKey, latestContent);
      initializedDocKeyRef.current = null;
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      if (diskTimerRef.current) clearTimeout(diskTimerRef.current);
      if (sourceViewRef.current) {
        sourceViewRef.current.destroy();
        sourceViewRef.current = null;
      }
      tipTapEditorRef.current = null;
      activeSourceViews.delete(docKey);
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
              const content = getCurrentDocumentHistoryContent(docKey)
                ?? useDocumentStore.getState().getDocument(docKey)?.content
                ?? '';
              if (editor) {
                parseMarkdown(editor, content);
                markDocumentHistoryModeBoundary(docKey);
                viewModeRef.current = 'visual';
                setViewMode('visual');
                useWindowStore.getState().setTabViewMode(docKey, 'visual');
              }
            }}
          >
            仍要使用可视化编辑
          </button>
        </div>
        <div
          style={{
            flex: 1,
            overflow: 'hidden',
            background: 'var(--editor-bg)',
            display: 'flex',
            justifyContent: 'center',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && sourceViewRef.current) {
              sourceViewRef.current.focus();
            }
          }}
        >
          <div
            ref={sourceDivRef}
            style={{
              width: '100%',
              maxWidth: 'var(--content-max-width)',
              height: '100%',
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'hidden', position: 'relative' }} ref={editorRef}>
      <ExternalChangeBanner docKey={docKey} />
      {/* 可视化模式容器 */}
      <div
        style={{
          height: '100%',
          overflow: 'auto',
          position: 'relative',
          display: viewMode === 'visual' ? 'block' : 'none',
        }}
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
        {editor && <EditorBubbleMenu editor={editor} onOpenLinkModal={handleOpenLinkModal} />}
        {editor && <TableToolbar editor={editor} />}
        {editor && <BlockDragHandle editor={editor} />}
        {contextMenu && editor && (
          <EditorContextMenu
            editor={editor}
            position={{ x: contextMenu.x, y: contextMenu.y }}
            hasSelection={contextMenu.hasSelection}
            onClose={() => setContextMenu(null)}
            onOpenLinkModal={handleOpenLinkModal}
          />
        )}
        {linkModalState && (
          <LinkModal
            isOpen={linkModalState.isOpen}
            initialText={linkModalState.initialText}
            initialUrl={linkModalState.initialUrl}
            isEditing={linkModalState.isEditing}
            onClose={() => setLinkModalState(null)}
            onConfirm={handleConfirmLink}
            onRemove={handleRemoveLink}
          />
        )}
        <EditorContent editor={editor} style={{ height: '100%' }} />
      </div>

      {/* 源码模式容器（常驻 DOM，确保 sourceDivRef.current 始终有效挂载） */}
      <div
        style={{
          height: '100%',
          overflow: 'hidden',
          background: 'var(--editor-bg)',
          display: viewMode === 'source' ? 'flex' : 'none',
          justifyContent: 'center',
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && sourceViewRef.current) {
            sourceViewRef.current.focus();
          }
        }}
      >
        <div
          ref={sourceDivRef}
          style={{
            width: '100%',
            maxWidth: 'var(--content-max-width)',
            height: '100%',
          }}
        />
      </div>

      {/* 底部左侧模式切换器：可视化 / 源码模式，具备热区靠近唤出与 Hover、Active 状态反馈，仅对当前文档生效 */}
      <MarkdownModeToggle viewMode={viewMode} onToggle={toggleViewMode} />
    </div>
  );
}
