// NoteBoard 文档历史记录：按格式选择查看器（全部懒加载）
// 各格式的可视化查看器按阶段接入；未接入或解析失败的格式使用源码级差异兜底

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { VersionViewerProps } from './viewerTypes';

type Viewer = LazyExoticComponent<ComponentType<VersionViewerProps>>;

const TextVersionViewer: Viewer = lazy(() => import('./TextVersionViewer'));
const MarkdownVersionViewer: Viewer = lazy(() => import('./MarkdownVersionViewer'));
const MindmapVersionViewer: Viewer = lazy(() => import('./MindmapVersionViewer'));
const BitableVersionViewer: Viewer = lazy(() => import('./BitableVersionViewer'));
const BoardVersionViewer: Viewer = lazy(() => import('./BoardVersionViewer'));
const DrawioVersionViewer: Viewer = lazy(() => import('./DrawioVersionViewer'));

/** 文档类型 → 查看器 */
export function viewerFor(kind: string): Viewer {
  switch (kind) {
    case 'markdown':
      return MarkdownVersionViewer;
    case 'mindmap':
      return MindmapVersionViewer;
    case 'bitable':
      return BitableVersionViewer;
    case 'board':
      return BoardVersionViewer;
    case 'drawio':
      return DrawioVersionViewer;
    default:
      return TextVersionViewer;
  }
}

/** 源码级查看器（可视化查看器无法解析内容时回退） */
export function sourceViewer(): Viewer {
  return TextVersionViewer;
}
