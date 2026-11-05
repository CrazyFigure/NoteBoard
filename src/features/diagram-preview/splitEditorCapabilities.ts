// NoteBoard 图表类双栏编辑器能力实现（S12）
// DiagramSplitEditor / InfographicSplitEditor 共用：CM 源码视图 + 预览状态（layoutMode/zoom/pan）。
// canSuspend=true：内容经 flush 进 store；视图状态（布局模式/选区/滚动/预览变换）捕获恢复。
// 由组件挂载时注册到 core 注册表；核心层不接触 EditorView。

import type { EditorView } from '@codemirror/view';
import type { EditorCapabilities } from '../../core/editor/editorTypes';
// 🔴 R03：flush 镜像写入经统一提交屏障
import { submitCapturedContent } from '../session/documentSession';
import { createCodeMirrorSearchCapabilities } from '../search/searchController';

/** 双栏编辑器的额外视图状态（布局模式与预览变换） */
export interface SplitEditorExtraState {
  layoutMode: string;
  zoom: number;
  pan: { x: number; y: number };
}

export interface SplitEditorCapabilitiesOptions {
  docKey: string;
  instanceId: string;
  /** 读取当前 CM 源码视图（未挂载返回 null） */
  getEditorView: () => EditorView | null;
  /** 捕获布局模式与预览变换（组件 state 的 ref 镜像读取） */
  captureExtra: () => SplitEditorExtraState;
  /** 搜索前确保源码区可见（纯预览布局下源码区隐藏，搜索命中无法呈现） */
  revealSource?: () => void;
}

/**
 * 构造图表类双栏编辑器能力。
 * flush：CM 文本 → store 镜像（图表源码即可序列化文本）；
 * captureViewState：源码选区/滚动 + 布局模式/预览变换；
 * search：源码区 Ctrl+F 查找替换（与 code 编辑器同一套控制器）。
 */
export function createSplitEditorCapabilities(
  options: SplitEditorCapabilitiesOptions,
): EditorCapabilities {
  const { docKey, instanceId, getEditorView, captureExtra, revealSource } = options;
  return {
    docKey,
    instanceId,
    // 图表源码无独立统一历史/revision 体系（S12 范围判定记录于实施进度）；
    // 内容以 store 镜像为准
    getRevision: () => 0,
    flush: async () => {
      const view = getEditorView();
      if (!view) return null;
      const content = view.state.doc.toString();
      submitCapturedContent(docKey, { instanceId, revision: 0, content });
      return { docKey, instanceId, revision: 0, content };
    },
    // 图表与信息图没有统一历史适配器，重载须直接更新源码内核，让预览随之刷新。
    replaceContent: (content) => {
      const view = getEditorView();
      if (!view) return false;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
      return true;
    },
    focus: () => {
      getEditorView()?.focus();
    },
    getSelectedText: () => {
      const view = getEditorView();
      if (!view) return '';
      const sel = view.state.selection.main;
      return sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to);
    },
    // 🔴 S12：图表双栏编辑器为已验证可回收类型（CM 源码 + 布局/预览状态捕获恢复）
    canSuspend: () => true,
    captureViewState: () => {
      const view = getEditorView();
      const extra = captureExtra();
      return {
        kind: 'split-diagram' as const,
        layoutMode: extra.layoutMode,
        zoom: extra.zoom,
        pan: extra.pan,
        selection: view
          ? { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head }
          : null,
        scrollTop: view?.scrollDOM?.scrollTop ?? 0,
      };
    },
    // 源码文本搜索能力：缺失时搜索栏拿不到能力，Ctrl+F 只能打开空壳栏且永远 0 匹配
    search: createCodeMirrorSearchCapabilities(getEditorView, revealSource),
  };
}
