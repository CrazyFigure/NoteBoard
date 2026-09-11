// NoteBoard 思维导图展示主题（布局 / 配色 / 连线样式）
// 配色以「一级分支循环取色」为核心，节点卡片背景由分支色按比例混入表面色，
// 从而在浅色 / 深色全局主题下都能保持良好对比度。
// 详见 docs/09-开发路线图.md

import type { MindmapEdgeStyle, MindmapLayout } from './mindmapTypes';

export interface MindmapTheme {
  id: string;
  name: string;
  /** 一级分支与连线循环使用的配色 */
  branchColors: string[];
  /** 根节点背景 */
  rootBackground: string;
  /** 根节点文字颜色 */
  rootText: string;
  /** 根节点投影 */
  rootShadow: string;
  /** 连线样式 */
  edgeStyle: MindmapEdgeStyle;
  /** 连线不透明度 */
  edgeOpacity: number;
  /** 非根节点卡片背景混入分支色的百分比 (0 = 纯表面色) */
  nodeTint: number;
}

export const MINDMAP_THEMES: MindmapTheme[] = [
  {
    id: 'classic',
    name: '经典蓝',
    branchColors: ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'],
    rootBackground: 'var(--editor-accent, #3b82f6)',
    rootText: '#ffffff',
    rootShadow: '0 6px 16px rgba(59, 130, 246, 0.35)',
    edgeStyle: 'curve',
    edgeOpacity: 0.8,
    nodeTint: 0,
  },
  {
    id: 'ocean',
    name: '深海',
    branchColors: ['#0284c7', '#06b6d4', '#14b8a6', '#2563eb', '#0ea5e9', '#0891b2'],
    rootBackground: 'linear-gradient(135deg, #0ea5e9, #0369a1)',
    rootText: '#ffffff',
    rootShadow: '0 6px 16px rgba(2, 132, 199, 0.4)',
    edgeStyle: 'curve',
    edgeOpacity: 0.9,
    nodeTint: 9,
  },
  {
    id: 'sunset',
    name: '暖阳',
    branchColors: ['#ea580c', '#ef4444', '#ec4899', '#f59e0b', '#e11d48', '#fb923c'],
    rootBackground: 'linear-gradient(135deg, #f97316, #db2777)',
    rootText: '#ffffff',
    rootShadow: '0 6px 16px rgba(234, 88, 12, 0.4)',
    edgeStyle: 'curve',
    edgeOpacity: 0.9,
    nodeTint: 9,
  },
  {
    id: 'forest',
    name: '森林',
    branchColors: ['#16a34a', '#65a30d', '#0d9488', '#22c55e', '#84cc16', '#14b8a6'],
    rootBackground: 'linear-gradient(135deg, #22c55e, #15803d)',
    rootText: '#ffffff',
    rootShadow: '0 6px 16px rgba(22, 163, 74, 0.4)',
    edgeStyle: 'curve',
    edgeOpacity: 0.9,
    nodeTint: 9,
  },
  {
    id: 'violet',
    name: '幻紫',
    branchColors: ['#7c3aed', '#a855f7', '#d946ef', '#6366f1', '#c026d3', '#8b5cf6'],
    rootBackground: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
    rootText: '#ffffff',
    rootShadow: '0 6px 16px rgba(124, 58, 237, 0.42)',
    edgeStyle: 'curve',
    edgeOpacity: 0.9,
    nodeTint: 10,
  },
  {
    id: 'candy',
    name: '马卡龙',
    branchColors: ['#f472b6', '#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#fb923c'],
    rootBackground: 'linear-gradient(135deg, #a78bfa, #60a5fa)',
    rootText: '#ffffff',
    rootShadow: '0 6px 16px rgba(139, 92, 246, 0.38)',
    edgeStyle: 'curve',
    edgeOpacity: 0.95,
    nodeTint: 14,
  },
  {
    id: 'mono',
    name: '墨线',
    branchColors: ['#475569', '#64748b', '#334155', '#94a3b8', '#1e293b', '#7c8ba1'],
    rootBackground: 'linear-gradient(135deg, #334155, #0f172a)',
    rootText: '#ffffff',
    rootShadow: '0 6px 16px rgba(15, 23, 42, 0.4)',
    edgeStyle: 'straight',
    edgeOpacity: 0.75,
    nodeTint: 0,
  },
];

export const DEFAULT_MINDMAP_THEME_ID = MINDMAP_THEMES[0].id;

/** 按 id 取主题，未命中时回退首个主题 */
export function getMindmapTheme(id?: string): MindmapTheme {
  return MINDMAP_THEMES.find((t) => t.id === id) ?? MINDMAP_THEMES[0];
}

export interface MindmapLayoutMeta {
  id: MindmapLayout;
  name: string;
  description: string;
}

export const MINDMAP_LAYOUTS: MindmapLayoutMeta[] = [
  { id: 'right', name: '向右逻辑图', description: '所有子节点统一向右展开' },
  { id: 'left', name: '向左逻辑图', description: '所有子节点统一向左展开' },
  { id: 'balanced', name: '双向平衡图', description: '一级分支左右交替分布，更紧凑' },
  { id: 'tree', name: '向下组织图', description: '自顶向下的层级组织结构' },
];

export const DEFAULT_MINDMAP_LAYOUT: MindmapLayout = 'right';

/** 按 id 取布局描述，未命中时回退首个布局 */
export function getMindmapLayoutMeta(id: MindmapLayout): MindmapLayoutMeta {
  return MINDMAP_LAYOUTS.find((l) => l.id === id) ?? MINDMAP_LAYOUTS[0];
}
