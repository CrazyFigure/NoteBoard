// NoteBoard Markdown 编辑器能力实现（编辑器侧，可依赖 TipTap/CodeMirror 内核 API）
// 由 TipTapEditor 挂载时注册到 core 注册表；visual/source 两种内核在能力内部
// 按当前 viewMode 动态分派，模式切换无需重建能力对象。
// core 层只持有 editorTypes 声明的接口。

import type {
  CodeOpsCapabilities,
  EditorCapabilities,
  FlushReason,
  SearchCapabilities,
  TextSearchOptions,
} from '../../core/editor/editorTypes';
import type { CapturedContent } from '../../core/editor/editorTypes';
import {
  executeSearch,
  executeFindNext,
  executeFindPrev,
  executeReplace,
  executeReplaceAll,
  focusActiveEditor,
  getSelectedText,
  type EditorTarget,
} from '../search/searchController';
import { serializeMarkdown } from './serialize';
import {
  handleExpandJson,
  handleMinifyJson,
  handleValidateJson,
  handleFormatXml,
} from '../editor-code/jsonOps';
import { handleTransformCase } from '../toolbar/textOps';
import { getMdTipTapEditor, getMdSourceView } from './editorInstances';
import { useWindowStore } from '../../stores/windowStore';
import { useDocumentStore } from '../../stores/documentStore';
import { getDocumentRevision } from '../../core/editor/editorRegistry';
import { getSessionGeneration } from '../../features/session/documentSession';
// 🔴 R03：flush 镜像写入经统一提交屏障
// 🔴 J2：visual 模式先物化暂存快照（输入热路径只暂存不可变引用，flush 时序列化）
import { submitCapturedContent } from '../session/documentSession';
import { flushPendingVisualSnapshot, flushPendingSourceSnapshot, hasPendingSnapshot } from './visualSnapshot';

/** 读取文档当前视图模式（无 tab 信息时默认 visual） */
function currentMode(docKey: string): 'visual' | 'source' {
  return useWindowStore.getState().getTab(docKey)?.viewMode ?? 'visual';
}

/** 当前内核目标（CodeMirror 源码视图或 TipTap 编辑器） */
function currentTarget(docKey: string): EditorTarget {
  if (currentMode(docKey) === 'source') {
    const view = getMdSourceView(docKey);
    return view ? { type: 'codemirror', view } : null;
  }
  const editor = getMdTipTapEditor(docKey);
  return editor ? { type: 'tiptap', editor } : null;
}

/**
 * 构造 Markdown 编辑器能力对象。
 * @param docKey 文档键
 * @param instanceId 实例代际（TipTapEditor 每次挂载生成）
 */
export function createMarkdownEditorCapabilities(
  docKey: string,
  instanceId: string,
): EditorCapabilities {
  // 🔴 N04：捕获能力创建（编辑器挂载）时的会话代际——flush 迟到返回时
  //    同路径会话已换代（关闭重开）则提交被丢弃
  const sessionGeneration = getSessionGeneration(docKey);
  // 搜索能力：按当前模式动态选择内核目标，行为与改造前完全一致
  const search: SearchCapabilities = {
    search: (options: TextSearchOptions) => executeSearch(currentTarget(docKey), options),
    findNext: (options: TextSearchOptions) => executeFindNext(currentTarget(docKey), options),
    findPrev: (options: TextSearchOptions) => executeFindPrev(currentTarget(docKey), options),
    replace: (options: TextSearchOptions) => executeReplace(currentTarget(docKey), options),
    replaceAll: (options: TextSearchOptions) => executeReplaceAll(currentTarget(docKey), options),
  };

  // 代码操作能力：仅源码模式提供（与旧快捷键行为一致——可视化模式无 JSON/XML 操作入口）
  const codeOps: CodeOpsCapabilities = {
    expandJson: (options) => {
      const target = currentTarget(docKey);
      if (target?.type === 'codemirror') handleExpandJson(target.view, { ...options, lang: 'markdown' });
    },
    minifyJson: (scope) => {
      const target = currentTarget(docKey);
      if (target?.type === 'codemirror') handleMinifyJson(target.view, { scope, lang: 'markdown' });
    },
    validateJson: (scope) => {
      const target = currentTarget(docKey);
      if (target?.type === 'codemirror') handleValidateJson(target.view, { scope, lang: 'markdown' });
    },
    transformCase: (mode) => {
      const target = currentTarget(docKey);
      if (target?.type === 'codemirror') handleTransformCase(target.view, mode);
    },
    formatXml: (scope) => {
      const target = currentTarget(docKey);
      if (target?.type === 'codemirror') handleFormatXml(target.view, { scope, lang: 'markdown' });
    },
  };

  return {
    docKey,
    instanceId,
    getRevision: () => getDocumentRevision(docKey),
    flush: async (_reason: FlushReason): Promise<CapturedContent | null> => {
      // 🔴 R02：visual 每键已即时记录历史（合并序列化按复审回退）；
      //    源码模式：CM6 doc 为不可变结构，toString 即权威快照
      if (currentMode(docKey) === 'source') {
        // 🔴 J2：先物化 source 暂存快照（热路径只暂存 Text 引用）
        const materialized = flushPendingSourceSnapshot(docKey);
        if (materialized !== null) {
          submitCapturedContent(docKey, { instanceId, revision: getDocumentRevision(docKey), content: materialized }, sessionGeneration);
          return { docKey, instanceId, revision: getDocumentRevision(docKey), content: materialized };
        }
        const view = getMdSourceView(docKey);
        if (!view) return null;
        const content = view.state.doc.toString();
        // 🔴 N04：提交携带会话代际（旧会话迟到 flush 丢弃）
        submitCapturedContent(docKey, { instanceId, revision: getDocumentRevision(docKey), content }, sessionGeneration);
        return { docKey, instanceId, revision: getDocumentRevision(docKey), content };
      }
      // 可视化模式：🔴 J2 先物化暂存快照（序列化暂存 doc 引用——组内合并的末端），
      //    无暂存时序列化当前编辑器（旧语义）；异常时返回 null 保留镜像
      const materialized = flushPendingVisualSnapshot(docKey);
      if (materialized !== null) {
        submitCapturedContent(docKey, { instanceId, revision: getDocumentRevision(docKey), content: materialized }, sessionGeneration);
        return { docKey, instanceId, revision: getDocumentRevision(docKey), content: materialized };
      }
      const editor = getMdTipTapEditor(docKey);
      if (!editor) return null;
      try {
        const content = serializeMarkdown(editor);
        submitCapturedContent(docKey, { instanceId, revision: getDocumentRevision(docKey), content }, sessionGeneration);
        return { docKey, instanceId, revision: getDocumentRevision(docKey), content };
      } catch {
        return null;
      }
    },
    focus: () => focusActiveEditor(currentTarget(docKey)),
    getSelectedText: () => getSelectedText(currentTarget(docKey)),
    // 🔴 N01：可迁移类型的真实视图捕获——`?? null` 的缺省不再让迁移载荷
    //    假装带上了 Markdown 视图（选区/滚动随迁移传递，目标侧经 saveViewState 恢复）
    captureViewState: () => {
      if (currentMode(docKey) === 'source') {
        const view = getMdSourceView(docKey);
        if (!view) return undefined;
        const sel = view.state.selection.main;
        return {
          // Markdown 源码模式仍由 TipTapEditor 协调器恢复，必须使用 markdown 判别类型；
          // 伪装成 code 会被 restoreMarkdownViewState 拒绝并回到文档开头。
          kind: 'markdown' as const,
          selection: { anchor: sel.anchor, head: sel.head },
          scrollTop: view.scrollDOM?.scrollTop ?? 0,
          mode: 'source' as const,
        };
      }
      const editor = getMdTipTapEditor(docKey);
      if (!editor) return undefined;
      return {
        kind: 'markdown' as const,
        selection: { anchor: editor.state.selection.anchor, head: editor.state.selection.head },
        // TipTap 的 contenteditable 不自身滚动，滚动发生在 EditorContent 容器
        scrollTop: (editor.view.dom.parentElement as HTMLElement | null)?.scrollTop ?? 0,
        mode: 'visual' as const,
      };
    },
    // 🔴 S12 接入 Markdown 回收：内容经统一 flush 屏障物化（J2 暂存快照）进 store，
    //    统一历史在 documentHistory（按 docKey，重挂载不清）；选区/滚动经
    //    captureViewState 捕获、挂载时恢复。IME 组合中不回收（视图状态不可靠恢复）。
    canSuspend: () => {
      if (currentMode(docKey) === 'source') {
        const view = getMdSourceView(docKey);
        return view ? !view.composing : true;
      }
      const editor = getMdTipTapEditor(docKey);
      // 可视化内核未挂载（source 初始模式）时无实例状态需要保护
      return editor ? !editor.view.composing : true;
    },
    // 🔴 R4-01/D03：热切换保活判定——是否存在未物化/未同步的权威输入：
    //    J2 暂存（source/visual pending）或镜像与文档记录不一致（未确认脏内容）。
    //    无未确认输入的保留实例不执行全文 flush（往返切换零序列化成本）。
    hasUnconfirmedInput: () => {
      if (hasPendingSnapshot(docKey)) return true;
      const doc = useDocumentStore.getState().getDocument(docKey);
      if (!doc) return false;
      // 镜像缺失（未知正文）视为未确认——必须走完整屏障
      if (doc.content === null) return true;
      if (currentMode(docKey) === 'source') {
        const view = getMdSourceView(docKey);
        if (!view) return false;
        return view.state.doc.toString() !== doc.content;
      }
      const editor = getMdTipTapEditor(docKey);
      if (!editor) return false;
      // visual 内核正文以镜像为准（每键经 flushDocument 提交已确认）；暂存 pending
      // 已在上面的 hasPendingSnapshot 覆盖，无暂存即已同步
      return false;
    },
    search,
    codeOps,
  };
}

/** 供 TipTapEditor 内部直接取用（模块内共享同一 target 逻辑） */
export { currentMode as currentMarkdownMode };
