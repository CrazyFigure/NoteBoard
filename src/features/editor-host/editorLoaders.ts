// NoteBoard 编辑器加载表（S05 懒加载边界，docs/启动性能与低内存根治计划.md §E）
//
// 🔴 依赖红线：
//   1. loader 表只存工厂函数，模块顶层不执行任何 import —— 本文件可安全留在首屏闭包。
//   2. 用 kind + language 选择入口：infographic/mermaid/plantuml 属于 kind=code，
//      不能只按 kind 全送进 CodeEditor。
//   3. 各编辑器的具体组件类型在加载处一次性收窄为统一签名（LazyEditorComponent），
//     props 适配集中在 EditorHost 完成。
//   4. 失败恢复：React.lazy 会缓存 rejection，重试必须以 retryGeneration 重建 lazy
//     包装（EditorHost 内实现），不能只清 Promise。

import { lazy } from 'react';
import type { ComponentType } from 'react';
import type { Tab } from '../../stores/windowStore';

/** 统一的编辑器组件签名（各编辑器真实 props 由 EditorHost 适配构造） */
export type LazyEditorComponent = ComponentType<Record<string, unknown>>;

/** 可懒加载的编辑器入口类型 */
export type EditorLoaderKind =
  | 'code'
  | 'markdown'
  | 'board'
  | 'mindmap'
  | 'drawio'
  | 'bitable'
  | 'image'
  | 'diagram'
  | 'infographic';

/** 按 kind + language 解析编辑器入口；unsupported 由轻量常驻视图处理（不懒加载） */
export function resolveEditorKind(tab: Pick<Tab, 'kind' | 'language'>): EditorLoaderKind | 'unsupported' {
  if (tab.kind === 'code') {
    // 信息图 / Mermaid / PlantUML 是独立图表编辑入口（kind=code + 专属 language）
    if (tab.language === 'infographic') return 'infographic';
    if (tab.language === 'mermaid' || tab.language === 'plantuml') return 'diagram';
    return 'code';
  }
  switch (tab.kind) {
    case 'markdown':
      return 'markdown';
    case 'board':
      return 'board';
    case 'mindmap':
      return 'mindmap';
    case 'drawio':
      return 'drawio';
    case 'bitable':
      return 'bitable';
    case 'image':
      return 'image';
    default:
      return 'unsupported';
  }
}

/** 动态 import 工厂表：调用时才加载对应编辑器 chunk */
const loaderFactories: Record<EditorLoaderKind, () => Promise<{ default: LazyEditorComponent }>> = {
  code: () =>
    import('../editor-code/CodeEditor').then(
      (m) => ({ default: m.CodeEditor as unknown as LazyEditorComponent }),
    ),
  markdown: () =>
    import('../editor-md/TipTapEditor').then(
      (m) => ({ default: m.TipTapEditor as unknown as LazyEditorComponent }),
    ),
  board: () =>
    import('../board/BoardEditor').then(
      (m) => ({ default: m.BoardEditor as unknown as LazyEditorComponent }),
    ),
  mindmap: () =>
    import('../mindmap/MindmapEditor').then(
      (m) => ({ default: m.MindmapEditor as unknown as LazyEditorComponent }),
    ),
  drawio: () =>
    import('../drawio/DrawioEditor').then(
      (m) => ({ default: m.DrawioEditor as unknown as LazyEditorComponent }),
    ),
  bitable: () =>
    import('../bitable/BitableEditor').then(
      (m) => ({ default: m.BitableEditor as unknown as LazyEditorComponent }),
    ),
  image: () =>
    import('../image-viewer/ImageViewer').then(
      (m) => ({ default: m.ImageViewer as unknown as LazyEditorComponent }),
    ),
  diagram: () =>
    import('../diagram-preview/DiagramSplitEditor').then(
      (m) => ({ default: m.DiagramSplitEditor as unknown as LazyEditorComponent }),
    ),
  infographic: () =>
    import('../infographic/InfographicSplitEditor').then(
      (m) => ({ default: m.InfographicSplitEditor as unknown as LazyEditorComponent }),
    ),
};

/**
 * 预取唯一目标入口（不渲染）：
 * 打开路径解析出 kind 后立即调用，与读文件并行，避免"先读完再 import"的新瀑布。
 * 多次调用同一入口时由模块缓存去重；不预取无关编辑器。
 */
export function prefetchEditor(kind: EditorLoaderKind): void {
  // 🔴 R10：预取失败必须捕获（未处理 rejection）；失败不清除模块缓存，
  //    真正渲染时由 EditorHost 的错误边界呈现并支持重试
  loaderFactories[kind]().catch((error) => {
    console.warn(`[editorLoaders] 预取 ${kind} 编辑器失败（渲染时将重试）:`, error);
  });
}

/** 创建该入口的 lazy 组件工厂（供 EditorHost 按 retryGeneration 重建） */
export function createLazyEditor(kind: EditorLoaderKind): LazyEditorComponent {
  // 🔴 每次调用生成新的 lazy 实例：React.lazy 缓存 rejection，
  //    重试必须重建包装，仅清 Promise 或复用已拒绝 lazy 不足以恢复。
  return lazy(loaderFactories[kind]) as unknown as LazyEditorComponent;
}
