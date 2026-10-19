// NoteBoard 思维导图与大纲数据契约
// 统一节点树结构 + XMind Zen / 2020+ 数据契约定义
// 详见 docs/09-开发路线图.md

import type { MindTextMark } from './mindmapRichText';

/** 节点标题对齐方式 */
export type MindmapTextAlign = 'left' | 'center';

/** 节点图片显示方式：原始比例 / 宽度填充（固定高度裁切） */
export type MindmapImageFit = 'original' | 'fill';

export interface MindNode {
  id: string;
  text: string;
  // 节点前置图标（如 Emoji 或标记）
  icon?: string;
  // 节点文字备注
  note?: string;
  // 节点挂载图片（Data URL Base64 或网络/本地路径）
  image?: string;
  isExpanded?: boolean;
  color?: string;
  // 手动拉伸后的节点宽度（px）；未设置时按设置中的最大宽度自适应
  width?: number;
  // 标题富文本格式区间（加粗 / 斜体 / 颜色 / 高亮等）
  marks?: MindTextMark[];
  // 标题对齐方式；未设置时跟随设置
  textAlign?: MindmapTextAlign;
  // 图片显示方式；未设置时跟随设置
  imageFit?: MindmapImageFit;
  children: MindNode[];
}

/**
 * 思维导图布局：
 * 向右逻辑图 / 向左逻辑图 / 双向平衡图 / 向下组织图 / 向上组织图 /
 * 右侧树状图 / 左侧树状图 / 时间轴 / 鱼骨图
 */
export type MindmapLayout =
  | 'right'
  | 'left'
  | 'balanced'
  | 'tree'
  | 'tree-up'
  | 'indent-right'
  | 'indent-left'
  | 'timeline'
  | 'fishbone';

/** 连线样式：平滑贝塞尔曲线 / 直线 / 折线 */
export type MindmapEdgeStyle = 'curve' | 'straight' | 'elbow';

export interface MindmapDocumentData {
  version: number;
  root: MindNode;
  theme?: string;
  layout?: MindmapLayout;
  // 连线样式；未设置时跟随配色主题
  edgeStyle?: MindmapEdgeStyle;
}

/** XMind content.json 数据结构 */
export interface XMindTopic {
  id: string;
  title: string;
  note?: { plain: { content: string } };
  // XMind 标记徽章（优先级、旗帜等）
  markers?: Array<{ markerId: string }>;
  // XMind 挂载图片
  image?: { src: string; width?: number; height?: number };
  children?: {
    attached?: XMindTopic[];
  };
  style?: Record<string, unknown>;
}

export interface XMindSheet {
  id: string;
  title: string;
  rootTopic: XMindTopic;
}

export type XMindContentJson = XMindSheet[];
