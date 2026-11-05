// 编辑器模块入口与资源生命周期分离：表内只存动态 import 工厂，不在模块求值时加载编辑器。
import type { EditorLoaderKind, LazyEditorComponent } from './editorLoaders';

/** 动态 import 工厂表：调用时才加载对应编辑器 chunk */
export const loaderFactories: Record<EditorLoaderKind, () => Promise<{ default: LazyEditorComponent }>> = {
  // 只加载轻量宿主，文档渲染库由独立插件包提供。
  preview: () => import('../plugins/PluginPreview').then((m) => ({ default: m.PluginPreview as unknown as LazyEditorComponent })),
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
  html: () =>
    import('../html-preview/HtmlSplitEditor').then(
      (m) => ({ default: m.HtmlSplitEditor as unknown as LazyEditorComponent }),
    ),
  textdiff: () =>
    import('../textdiff/TextDiffView').then(
      (m) => ({ default: m.TextDiffView as unknown as LazyEditorComponent }),
    ),
};
