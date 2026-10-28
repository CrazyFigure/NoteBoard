// NoteBoard Markdown 编辑器实例表（editor-md 边界内共享状态）
// 🔴 定位（docs/启动性能与低内存根治计划.md §D）：
//    保存/暂存/搜索等通用链路一律走 core/editor 注册表的 EditorCapabilities，
//    不再从编辑器组件文件导入 getter。本表仅服务 editor-md 边界内部
//    （MarkdownToolbar、模式切换等）对内核实例的访问，S05 懒加载时与
//    TipTapEditor 同 chunk，不把内核实例类型泄漏到 core 层。
// 运行时只持有实例引用，无内核运行时 import（类型为 import type）。

import type { Editor } from '@tiptap/core';
import type { EditorView, ViewUpdate } from '@codemirror/view';

/** 活跃 TipTap（可视化模式）实例表：docKey → editor */
const mdTipTapEditors = new Map<string, Editor>();

/** 活跃 Markdown 源码模式 CM6 实例表：docKey → view */
const mdSourceViews = new Map<string, EditorView>();

/** 源码实例表变化的订阅者（大纲据此在源码视图创建/销毁后重新绑定） */
const sourceViewRegistryListeners = new Set<() => void>();

/** 源码视图更新的订阅者：view → 回调集合（由源码编辑器的 updateListener 转发） */
const sourceViewUpdateListeners = new WeakMap<EditorView, Set<(update: ViewUpdate) => void>>();

function notifySourceViewRegistry(): void {
  for (const listener of sourceViewRegistryListeners) listener();
}

/** 注册/更新可视化模式实例（返回注销函数；重复注销幂等） */
export function registerMdTipTapEditor(docKey: string, editor: Editor): () => void {
  mdTipTapEditors.set(docKey, editor);
  return () => {
    mdTipTapEditors.delete(docKey);
  };
}

/** 注册/更新源码模式实例（返回注销函数；重复注销幂等） */
export function registerMdSourceView(docKey: string, view: EditorView): () => void {
  if (mdSourceViews.get(docKey) !== view) {
    mdSourceViews.set(docKey, view);
    notifySourceViewRegistry();
  }
  return () => {
    unregisterMdSourceView(docKey);
  };
}

/** 注销可视化模式实例（幂等） */
export function unregisterMdTipTapEditor(docKey: string): void {
  mdTipTapEditors.delete(docKey);
}

/** 注销源码模式实例（幂等） */
export function unregisterMdSourceView(docKey: string): void {
  if (mdSourceViews.delete(docKey)) notifySourceViewRegistry();
}

/** 订阅源码实例表变化（返回取消订阅函数） */
export function subscribeMdSourceViews(listener: () => void): () => void {
  sourceViewRegistryListeners.add(listener);
  return () => {
    sourceViewRegistryListeners.delete(listener);
  };
}

/** 订阅某个源码视图的更新（文档、选区、视口变化；返回取消订阅函数） */
export function subscribeMdSourceViewUpdates(view: EditorView, listener: (update: ViewUpdate) => void): () => void {
  let listeners = sourceViewUpdateListeners.get(view);
  if (!listeners) {
    listeners = new Set();
    sourceViewUpdateListeners.set(view, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 源码编辑器的 updateListener 调用：把视图更新转发给订阅者 */
export function notifyMdSourceViewUpdate(update: ViewUpdate): void {
  const listeners = sourceViewUpdateListeners.get(update.view);
  if (!listeners) return;
  for (const listener of listeners) listener(update);
}

/** 查询可视化模式实例（未挂载返回 undefined） */
export function getMdTipTapEditor(docKey: string): Editor | undefined {
  return mdTipTapEditors.get(docKey);
}

/** 查询源码模式实例（未挂载返回 undefined） */
export function getMdSourceView(docKey: string): EditorView | undefined {
  return mdSourceViews.get(docKey);
}
