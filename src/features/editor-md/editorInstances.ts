// NoteBoard Markdown 编辑器实例表（editor-md 边界内共享状态）
// 🔴 定位（docs/启动性能与低内存根治计划.md §D）：
//    保存/暂存/搜索等通用链路一律走 core/editor 注册表的 EditorCapabilities，
//    不再从编辑器组件文件导入 getter。本表仅服务 editor-md 边界内部
//    （MarkdownToolbar、模式切换等）对内核实例的访问，S05 懒加载时与
//    TipTapEditor 同 chunk，不把内核实例类型泄漏到 core 层。
// 运行时只持有实例引用，无内核运行时 import（类型为 import type）。

import type { Editor } from '@tiptap/core';
import type { EditorView } from '@codemirror/view';

/** 活跃 TipTap（可视化模式）实例表：docKey → editor */
const mdTipTapEditors = new Map<string, Editor>();

/** 活跃 Markdown 源码模式 CM6 实例表：docKey → view */
const mdSourceViews = new Map<string, EditorView>();

/** 注册/更新可视化模式实例（返回注销函数；重复注销幂等） */
export function registerMdTipTapEditor(docKey: string, editor: Editor): () => void {
  mdTipTapEditors.set(docKey, editor);
  return () => {
    mdTipTapEditors.delete(docKey);
  };
}

/** 注册/更新源码模式实例（返回注销函数；重复注销幂等） */
export function registerMdSourceView(docKey: string, view: EditorView): () => void {
  mdSourceViews.set(docKey, view);
  return () => {
    mdSourceViews.delete(docKey);
  };
}

/** 注销可视化模式实例（幂等） */
export function unregisterMdTipTapEditor(docKey: string): void {
  mdTipTapEditors.delete(docKey);
}

/** 注销源码模式实例（幂等） */
export function unregisterMdSourceView(docKey: string): void {
  mdSourceViews.delete(docKey);
}

/** 查询可视化模式实例（未挂载返回 undefined） */
export function getMdTipTapEditor(docKey: string): Editor | undefined {
  return mdTipTapEditors.get(docKey);
}

/** 查询源码模式实例（未挂载返回 undefined） */
export function getMdSourceView(docKey: string): EditorView | undefined {
  return mdSourceViews.get(docKey);
}
