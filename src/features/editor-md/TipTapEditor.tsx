// NoteBoard TipTap Markdown 编辑器（S08：模式协调器）
// visual 模式 + source 模式切换 + 自动保存
// 详见 docs/09-开发路线图.md 7.1-7.7, 7.12
//
// 🔴 S08 拆分设计（docs/启动性能与低内存根治计划.md §P2/S08）：
// 1. 本组件为模式协调器：TipTap 内核移入 VisualKernel 子组件（惰性挂载）——
//    source 初始模式（大文档/用户首选）不创建 TipTap 实例；
//    首次进入 visual 时挂载，此后常驻（display 切换保留撤销栈与选区）。
// 2. 初始化锁为同步程序事务作用域（不再使用 50ms 时间窗忽略真实输入）。
// 3. 编辑器内核持有内容权威副本，store 里的是防抖后镜像。
// 4. onUpdate 500ms → store；800ms → 盘（auto 策略，VisualKernel/源码模式各自实现）。

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Editor } from '@tiptap/core';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec, Transaction as CodeMirrorTransaction } from '@codemirror/state';
import { undoDepth as codeMirrorUndoDepth } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { undoDepth as prosemirrorUndoDepth } from '@tiptap/pm/history';

import {
  serializeMarkdown,
  parseMarkdown,
  getBaseline,
  hasMarkdownContentChanged,
} from './serialize';
import { judgeLargeDoc } from './largeDoc';
import { nbEditorTheme } from '../editor-code/theme';
import { nbSyntaxHighlighting } from '../editor-code/highlightStyle';
import { createBaseExtensions, typographyCompartment } from '../editor-code/setup';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { registerShortcut } from '../../core/shortcuts';
import { on, off, emit } from '../../core/emitter';
import { MarkdownModeToggle } from './MarkdownModeToggle';
import { ExternalChangeBanner } from './ExternalChangeBanner';
import { markdownPlainBracketExtension } from './sourcePlainBracket';
import {
  getCurrentDocumentHistoryContent,
  initializeDocumentHistory,
  markDocumentHistoryModeBoundary,
  redoDocumentHistory,
  registerDocumentHistoryAdapter,
  registerHistoryMaterializeHook,
  synchronizeCurrentDocumentHistoryContent,
  undoDocumentHistory,
} from '../history/documentHistory';

// 🔴 S08：visual 运行时子组件（惰性挂载 TipTap 内核）与共享自动保存
import { VisualKernel } from './VisualKernel';
import { autoSaveDocument } from './markdownAutoSave';
// 🔴 J2：visual 输入热路径的暂存快照（卸载前物化；导航钩子由 VisualKernel 注册）
import {
  flushPendingVisualSnapshot,
  discardPendingVisualSnapshot,
  flushPendingSourceSnapshot,
  hasPendingSourceSnapshot,
  stagePendingSourceSnapshot,
  discardPendingSourceSnapshot,
} from './visualSnapshot';

// 活跃实例表与能力注册统一走独立模块：core 注册表（editorRegistry）服务
// 保存/暂存/搜索等通用链路，editor-md 边界内的实例表（editorInstances）
// 服务 MarkdownToolbar 等边界内部消费。
import {
  registerMdTipTapEditor,
  registerMdSourceView,
  unregisterMdTipTapEditor,
  unregisterMdSourceView,
} from './editorInstances';
import { registerEditorCapabilities, bumpDocumentRevision, getDocumentRevision } from '../../core/editor/editorRegistry';
import { createMarkdownEditorCapabilities } from './editorCapabilities';
// 🔴 S12：回收恢复——挂载时一次性消费捕获的选区/滚动视图状态
import { takeViewState } from '../session/editorSuspension';
// 🔴 N10.2：实例就绪终点标记（requestId 与打开请求对齐）
import { perfMarkEditorInstanceReady } from '../../core/perf/editorReadyMark';

/** 回收恢复的 Markdown 视图状态形态（captureViewState 捕获） */
type RestoredMarkdownViewState = {
  kind: 'markdown';
  selection: { anchor: number; head: number } | null;
  scrollTop: number;
  mode: 'visual' | 'source';
};

/** TipTap 实例代际序号：同一 docKey 重挂载时递增，用于注册表删除保护 */
let nextTipTapInstanceId = 0;

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
  // 🔴 S08：TipTap 内核惰性挂载——首次进入 visual 模式才挂载 VisualKernel，
  //    挂载后常驻（display 切换）；source 初始模式不创建 TipTap 实例
  const [hasVisualKernel, setHasVisualKernel] = useState(false);
  // editor 实例由 VisualKernel onReady 回传（替代原 useEditor 返回值）
  const [editor, setEditorState] = useState<Editor | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  // 持有最新 TipTap 实例，供仅按 docKey 注册的卸载清理读取，避免模式切换触发误清理
  const tipTapEditorRef = useRef<Editor | null>(null);
  const sourceViewRef = useRef<EditorView | null>(null);
  const sourceDivRef = useRef<HTMLDivElement>(null);
  const storeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diskTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedDocKeyRef = useRef<string | null>(null);
  // 🔴 S08：visual 内容填充完成标记（editor 惰性 ready 后按需填充一次）
  const visualSyncedRef = useRef(false);
  // 惰性挂载 visual 时待填充的内容（首次切换 visual 的源码内容）
  const pendingVisualContentRef = useRef<string | null>(null);
  // TipTap 原生历史仅用来识别连续输入是否属于同一分组，快捷键由文档级历史接管
  const visualUndoDepthRef = useRef(0);
  // 初始化锁：在初次加载和程序化设置内容期间以同步作用域阻止 onUpdate 误标为脏
  // 🔴 S08 起不再使用 50ms 时间窗：程序化内容设置（parseMarkdown）期间同步加锁，
  //    调用返回即解锁——界面宣布可输入后的第一笔真实按键立即生效
  const isInitializingRef = useRef<boolean>(true);

  const settings = useSettingsStore((s) => s.settings);
  const typography = settings.typography;

  /**
   * 🔴 S12：恢复回收前捕获的视图状态（选区/滚动；裁剪到合法范围，一次性消费）。
   * visual 内核重挂载在填充 effect 末尾调用；source 内核在 initSourceEditor 后调用。
   */
  const restoreMarkdownViewState = useCallback(() => {
    const restored = takeViewState(docKey) as RestoredMarkdownViewState | null;
    if (!restored || restored.kind !== 'markdown' || !restored.selection) return;
    const { anchor, head } = restored.selection;
    const scrollTop = restored.scrollTop ?? 0;

    if (restored.mode === 'source') {
      const view = sourceViewRef.current;
      if (!view) return;
      const docLength = view.state.doc.length;
      const clampedAnchor = Math.max(0, Math.min(anchor, docLength));
      const clampedHead = Math.max(0, Math.min(head, docLength));
      view.dispatch({ selection: { anchor: clampedAnchor, head: clampedHead } });
      view.scrollDOM.scrollTop = scrollTop;
      return;
    }

    const editor = tipTapEditorRef.current;
    if (!editor) return;
    const maxPosition = editor.state.doc.content.size;
    const clampedAnchor = Math.max(1, Math.min(anchor, maxPosition));
    const clampedHead = Math.max(1, Math.min(head, maxPosition));
    editor
      .chain()
      .setTextSelection({ from: clampedAnchor, to: clampedHead })
      .scrollIntoView()
      .run();
    // TipTap 的 contenteditable 不自身滚动，滚动发生在 EditorContent 容器
    const container = editor.view.dom.parentElement as HTMLElement | null;
    if (container) container.scrollTop = scrollTop;
  }, [docKey]);

  // 🔴 J2：注册 source 快照的历史导航/读取前物化钩子（visual 钩子由 VisualKernel 注册；
  //    undo/redo/getCurrent/模式同步/迁移导出先物化两种暂存——各自无暂存时 no-op）
  useEffect(() => {
    return registerHistoryMaterializeHook(flushPendingSourceSnapshot);
  }, []);

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

  // 🔴 S08：TipTap 内核移入 VisualKernel；本组件经 onReady 回调持有实例
  const handleKernelReady = useCallback((ready: Editor | null) => {
    tipTapEditorRef.current = ready;
    setEditorState(ready);
  }, []);

  // 注册当前 Markdown 会话的能力对象（保存/搜索/工具栏统一入口）
  // 🔴 R3-02：注册独立于 visual TipTap 实例——source 首开（editor=null）也注册。
  //    能力内部按当前模式动态分派（source 用 CM 视图，visual 用 TipTap），
  //    与 createMarkdownEditorCapabilities 的模式分派一致；instanceId 每次挂载递增。
  useEffect(() => {
    const instanceId = `md-${(nextTipTapInstanceId += 1)}`;
    const disposeCapabilities = registerEditorCapabilities(
      createMarkdownEditorCapabilities(docKey, instanceId),
    );
    // 🔴 N10.2：Markdown 实例就绪终点（会话能力注册完成；source/visual 均适用）
    perfMarkEditorInstanceReady(docKey, instanceId);
    return () => {
      disposeCapabilities();
    };
    // viewMode 变化不重建能力（内部动态分派）；visual editor 就绪触发 instanceId 更新
  }, [docKey]);

  // 🔴 R3-02：visual 实例就绪时换代能力（能力创建捕获 instanceId/代际——旧实例
  //    的迟到 flush 由新 instanceId 拒绝）；editor 升级为独立注册-注销循环
  useEffect(() => {
    if (editor) {
      registerMdTipTapEditor(docKey, editor);
      const instanceId = `md-${(nextTipTapInstanceId += 1)}`;
      const disposeCapabilities = registerEditorCapabilities(
        createMarkdownEditorCapabilities(docKey, instanceId),
      );
      // 🔴 N10.2：visual 内核就绪（更精确的可交互终点——实例+能力注册完成）
      perfMarkEditorInstanceReady(docKey, instanceId);
      onEditorReady?.(editor);
      return () => {
        disposeCapabilities();
        unregisterMdTipTapEditor(docKey);
        onEditorReady?.(null);
      };
    }
    return () => {
      onEditorReady?.(null);
    };
  }, [editor, docKey, onEditorReady]);

  // 🔴 S06：字体包从 fallback 切换到真实字形后统一度量刷新（源码模式 CM 实例）
  useEffect(() => {
    const handleFontsSettled = () => {
      sourceViewRef.current?.requestMeasure();
    };
    window.addEventListener('noteboard-fonts-settled', handleFontsSettled);
    return () => {
      window.removeEventListener('noteboard-fonts-settled', handleFontsSettled);
    };
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
      registerMdSourceView(docKey, sourceViewRef.current);
      return;
    }

    // 源码模式输入监听与自动标脏
    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      // 🔴 内容版本递增：源码模式真实修改同样推进 revision
      bumpDocumentRevision(docKey);

      // 🔴 J2：source 热路径只暂存不可变 Text 引用（O(1)）——
      //    每键 toString() 全文工作被消除；序列化按历史组延迟执行
      const startsNewGroup = codeMirrorUndoDepth(update.state) > codeMirrorUndoDepth(update.startState);
      if (startsNewGroup && hasPendingSourceSnapshot(docKey)) {
        // 新组开始：物化上一组末端（跨组保留，不因延迟把多组丢成一组）
        flushPendingSourceSnapshot(docKey);
      }
      const previousPendingExisted = hasPendingSourceSnapshot(docKey);
      stagePendingSourceSnapshot(docKey, {
        text: update.state.doc,
        revision: getDocumentRevision(docKey),
        isNewGroup: startsNewGroup,
        groupStartBefore: startsNewGroup || !previousPendingExisted
          ? {
            anchor: update.startState.selection.main.anchor,
            head: update.startState.selection.main.head,
          }
          : undefined,
        selection: {
          anchor: update.state.selection.main.anchor,
          head: update.state.selection.main.head,
        },
      });

      // 🔴 J2 dirty 快速路径：未物化变化即受保护；物化时精确重算
      useWindowStore.getState().setTabDirty(docKey, true);
      useDocumentStore.getState().setDirty(docKey, true);

      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      storeTimerRef.current = setTimeout(() => {
        flushPendingSourceSnapshot(docKey);
      }, 500);

      if (diskTimerRef.current) clearTimeout(diskTimerRef.current);
      diskTimerRef.current = setTimeout(async () => {
        flushPendingSourceSnapshot(docKey);
        const latest = useDocumentStore.getState().getDocument(docKey)?.content ?? '';
        await autoSaveDocument(docKey, latest);
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
        // 裸 `[文本]` 是普通正文时取消 CodeMirror 的链接下划线与括号框，真实链接保持高亮。
        markdownPlainBracketExtension,
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
    registerMdSourceView(docKey, view);
  }, [docKey]);

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

  // ── S08 文档级初始化（不依赖 TipTap 实例；source 初始模式无需创建内核）──
  // 仅在 docKey 变更或初次加载时执行，不可随 doc.content 变化重复 parse
  useEffect(() => {
    if (initializedDocKeyRef.current === docKey) return;

    const currentDoc = useDocumentStore.getState().getDocument(docKey);
    if (!currentDoc) return;
    initializedDocKeyRef.current = docKey;
    visualSyncedRef.current = false;
    pendingVisualContentRef.current = null;

    const content = currentDoc.content ?? '';

    // 大文档判定
    const verdict = judgeLargeDoc(content, currentDoc.size);
    setLargeVerdict(verdict);
    // 先确定初始模式，文件历史的首节点必须采用当前权威内核实际展示的内容
    const tab = useWindowStore.getState().getTab(docKey);
    const requestedMode = tab?.viewMode ?? (verdict.isLarge ? 'source' : settings.editor.defaultViewMode);
    // 🔴 R4-03/D02：resolvedMode 单次决策——"用户意图（标签/设置）+ 大文档限制"
    //    合并后只应用一次，分支间不得互相覆盖。大文档强制 source（visual 内核
    //    不挂载）；resolvedMode 决定后续全部初始化（内核/历史/基线），不再被
    //    tab 恢复的 initialMode 二次改写。
    const resolvedMode: 'visual' | 'source' = verdict.isLarge ? 'source' : requestedMode;
    const historyInitialContent = content;

    if (verdict.isLarge) {
      setShowLargeBanner(true);
      // 强制 source 模式；大文档不设置内容到 TipTap（太大会卡）→ visual 内核保持未挂载
      setViewMode('source');
      viewModeRef.current = 'source';
      useWindowStore.getState().setTabViewMode(docKey, 'source');
      setHasVisualKernel(false);
    } else {
      setShowLargeBanner(false);
      // source 初始模式：TipTap 内核惰性挂载（S08 判定：源码首屏不创建隐藏实例）
      setHasVisualKernel(resolvedMode === 'visual');
      // 初始为可视化模式时：内容将在内核 ready 后以序列化结果对齐历史首节点
      //（初始 visual 下 historyInitialContent 由填充 effect 的序列化结果同步）
      if (resolvedMode === 'visual') {
        pendingVisualContentRef.current = content;
      } else {
        // 初始 source：基线对齐（脏文档无基线时以原始内容为基线）
        const baseline = getBaseline(docKey);
        if (!currentDoc.isDirty) {
          baseline.setBaseline(content);
          useDocumentStore.getState().setBaselineContent(docKey, content);
        } else if (!baseline.getBaseline()) {
          baseline.setBaseline(content);
        }
      }
    }

    // 🔴 R4-03：resolvedMode 统一应用（大文档分支已按同一值设置，这里幂等；
    //    历史与 source 内核按 resolvedMode 初始化——不再被 initialMode 覆盖）
    viewModeRef.current = resolvedMode;
    setViewMode(resolvedMode);
    initializeDocumentHistory(docKey, historyInitialContent, resolvedMode);
    if (resolvedMode === 'source') {
      // 延迟确保源码容器完成挂载；历史本身已独立于编辑器模式初始化
      setTimeout(() => {
        initSourceEditor(historyInitialContent);
        // 🔴 S12：source 内核重挂载（回收后）——恢复捕获的选区/滚动视图状态
        restoreMarkdownViewState();
      }, 0);
    }
  }, [docKey, settings.editor.defaultViewMode, initSourceEditor]);

  // ── S08 visual 内核内容填充（初始化或首次从 source 切入 visual 时执行一次）──
  useEffect(() => {
    if (!editor) return;
    if (initializedDocKeyRef.current !== docKey) return;
    if (viewModeRef.current !== 'visual') return;
    if (visualSyncedRef.current) return;

    const currentDoc = useDocumentStore.getState().getDocument(docKey);
    if (!currentDoc) return;
    // pendingVisualContentRef 只在初始化（visual 首开）或用户显式切换时设置，
    // 大文档初始为 source 不会进入本分支；用户点"仍要可视化"后按其意图填充
    visualSyncedRef.current = true;
    const content = pendingVisualContentRef.current ?? currentDoc.content ?? '';
    pendingVisualContentRef.current = null;

    // 🔴 程序化内容设置：同步作用域初始化锁（显示即输入——无 50ms 忽略窗口）
    isInitializingRef.current = true;
    try {
      const baseline = getBaseline(docKey);
      parseMarkdown(editor, content);

      // 与初始解析序列化结果严格对齐，消除格式化差异导致的假脏态；
      // visual 表示下历史首节点采用序列化结果
      const initialSerialized = serializeMarkdown(editor);
      synchronizeCurrentDocumentHistoryContent(docKey, initialSerialized, 'visual');
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
      // 同步作用域结束即解锁：真实输入立即生效
      isInitializingRef.current = false;
    }
    visualUndoDepthRef.current = prosemirrorUndoDepth(editor.state);
    // 🔴 S12：visual 内核重挂载（回收后）——恢复捕获的选区/滚动视图状态
    restoreMarkdownViewState();
  }, [editor, docKey, restoreMarkdownViewState]);

  // 切换可视化 / 源码模式（可指定目标模式 targetMode，只影响当前活动文档）
  const toggleViewMode = useCallback((targetMode?: 'visual' | 'source') => {
    const nextMode = targetMode ?? (viewMode === 'visual' ? 'source' : 'visual');
    if (nextMode === viewMode) return;

    if (nextMode === 'source') {
      // 可视化 → 源码模式
      const md = editor
        ? (getCurrentDocumentHistoryContent(docKey) ?? serializeMarkdown(editor))
        : (getCurrentDocumentHistoryContent(docKey) ?? useDocumentStore.getState().getDocument(docKey)?.content ?? '');
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
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      useDocumentStore.getState().setContent(docKey, md);

      if (!editor) {
        // 🔴 S08：内核尚未创建（source 初始模式）——惰性挂载 VisualKernel，
        //    内容填充由「visual 填充 effect」在内核 ready 后执行
        pendingVisualContentRef.current = md;
        setHasVisualKernel(true);
        markDocumentHistoryModeBoundary(docKey);
        viewModeRef.current = 'visual';
        setViewMode('visual');
        useWindowStore.getState().setTabViewMode(docKey, 'visual');
        emit('view-mode-changed', { key: docKey, mode: 'visual' });
        return;
      }

      const hasCrossModeChanges = hasMarkdownContentChanged(editor, md);
      if (hasCrossModeChanges) {
        // 🔴 同步作用域初始化锁：程序化同步不产生用户输入语义
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

  // 组件卸载时清理（注意：不要删除基线，以便切回 Tab 时仍能保持正确的脏态判定）
  useEffect(() => {
    return () => {
      // 组件卸载前立即刷新当前模式的最新内容，防止快速切换标签页导致防抖镜像落后
      // 🔴 J2：先物化 visual/source 暂存快照（同步序列化——组末端与镜像一次对齐）
      const materializedVisual = flushPendingVisualSnapshot(docKey);
      const materializedSource = flushPendingSourceSnapshot(docKey);
      const currentMode = useWindowStore.getState().getTab(docKey)?.viewMode ?? viewModeRef.current;
      const latestContent = currentMode === 'source' && sourceViewRef.current
        ? materializedSource
          ?? sourceViewRef.current.state.doc.toString()
        : materializedVisual
          ?? (tipTapEditorRef.current
            ? serializeMarkdown(tipTapEditorRef.current)
            : useDocumentStore.getState().getDocument(docKey)?.content ?? '');
      if (materializedVisual === null && materializedSource === null) {
        useDocumentStore.getState().setContent(docKey, latestContent);
      }
      initializedDocKeyRef.current = null;
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      if (diskTimerRef.current) clearTimeout(diskTimerRef.current);
      if (sourceViewRef.current) {
        sourceViewRef.current.destroy();
        sourceViewRef.current = null;
      }
      tipTapEditorRef.current = null;
      unregisterMdSourceView(docKey);
      // 兜底：清理任何残留暂存（如物化降级路径失败）
      discardPendingVisualSnapshot(docKey);
      discardPendingSourceSnapshot(docKey);
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
              // 用户显式确认大文件仍用可视化：内核惰性挂载时记录待填充内容
              if (!editor) {
                pendingVisualContentRef.current = content;
                setHasVisualKernel(true);
              } else {
                isInitializingRef.current = true;
                try {
                  parseMarkdown(editor, content);
                } finally {
                  isInitializingRef.current = false;
                }
              }
              markDocumentHistoryModeBoundary(docKey);
              viewModeRef.current = 'visual';
              setViewMode('visual');
              useWindowStore.getState().setTabViewMode(docKey, 'visual');
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
      {/* 🔴 S08：visual 运行时（惰性挂载；TipTap 内核随本组件创建/销毁） */}
      {hasVisualKernel && (
        <VisualKernel
          docKey={docKey}
          visible={viewMode === 'visual'}
          onReady={handleKernelReady}
          isInitializingRef={isInitializingRef}
          visualUndoDepthRef={visualUndoDepthRef}
          storeTimerRef={storeTimerRef}
          diskTimerRef={diskTimerRef}
        />
      )}

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
