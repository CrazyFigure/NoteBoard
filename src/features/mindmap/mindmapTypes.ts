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
  // 概要（大括号）：挂在父节点上覆盖一段连续子节点；跨父时挂在共同祖先上覆盖同层后代
  summaries?: MindSummary[];
  // 外框：挂在父节点上圈住一段连续子节点及其子树；跨父时挂在共同祖先上圈住同层后代
  boundaries?: MindBoundary[];
  // 联系线：从本节点指向任意其他节点
  relations?: MindRelation[];
  children: MindNode[];
}

/**
 * 子节点范围：用首尾子节点 id 表示（而非下标），
 * 子节点增删、排序后范围仍跟随原节点；首尾节点被移走时自动收缩或失效
 */
export interface MindNodeRange {
  id: string;
  startId: string;
  endId: string;
}

/** 概要：大括号 + 概要文字 */
export interface MindSummary extends MindNodeRange {
  text: string;
}

/** 外框：虚线圆角框 + 可选标题 */
export interface MindBoundary extends MindNodeRange {
  title?: string;
}

/** 联系线：带箭头的虚线曲线，可选文字说明 */
export interface MindRelation {
  id: string;
  targetId: string;
  title?: string;
  // 曲线弯曲量（沿两端连线法向的偏移，px）；旧版数据使用，controls 优先
  bend?: number;
  // 两个控制点，分别相对起点 / 终点节点中心的偏移（px）；未设置时自动计算
  controls?: [MindPoint, MindPoint];
}

/** 二维偏移 / 坐标 */
export interface MindPoint {
  x: number;
  y: number;
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
  // 官方文件使用 notes；兼容 NoteBoard 旧版导出的 note 字段。
  notes?: { plain?: { content: string }; html?: { content: string } };
  branch?: string;
  // XMind 标记徽章（优先级、旗帜等）
  markers?: Array<{ markerId: string }>;
  // XMind 挂载图片
  image?: { src: string; width?: number; height?: number };
  children?: {
    attached?: XMindTopic[];
    // 概要主题（与 summaries[].topicId 对应）
    summary?: XMindTopic[];
  };
  // 外框：range 为 "(起,止)" 子主题下标，或 "master" 表示主题自身
  boundaries?: Array<{ id: string; range: string; title?: string }>;
  // 概要：range 同上，topicId 指向 children.summary 中的概要主题
  summaries?: Array<{ id: string; range: string; topicId: string }>;
  style?: Record<string, unknown>;
}

/** XMind 画布级联系线 */
export interface XMindRelationship {
  id: string;
  end1Id: string;
  end2Id: string;
  title?: string;
}

export interface XMindSheet {
  id: string;
  title: string;
  rootTopic: XMindTopic;
  relationships?: XMindRelationship[];
}

export type XMindContentJson = XMindSheet[];
