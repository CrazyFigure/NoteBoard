// NoteBoard 思维导图布局共享类型
// 各布局算法（逻辑图 / 组织图 / 树状图 / 时间轴 / 鱼骨图）共用的节点与连线结构。
// 详见 docs/09-开发路线图.md

import type { MindNode, MindmapImageFit, MindmapTextAlign } from '../mindmapTypes';
import type { TextLine } from '../mindmapTextMeasure';
import type { MindTextMark } from '../mindmapRichText';

/** 节点四周方位 */
export type NodeSide = 'left' | 'right' | 'top' | 'bottom';

/** 同级节点排列走向：向下 / 向右 / 向左（决定拖放前后位置的判定轴） */
export type SiblingFlow = 'down' | 'right' | 'left';

export interface LayoutNode {
  node: MindNode;
  x: number;
  y: number;
  width: number;
  height: number;
  level: number;
  /** 所属一级分支序号（决定配色） */
  branchIndex: number;
  /** 沿堆叠轴方向的子树总尺寸（水平布局 = 纵向高度；垂直布局 = 横向宽度） */
  totalSubHeight: number;
  children: LayoutNode[];
  /** 换行后的标题各行 */
  titleLines: TextLine[];
  /** 换行后的备注各行（已按最大行数截断） */
  noteLines: string[];
  /** 标题富文本标记（编辑中为草稿标记） */
  marks?: MindTextMark[];
  /** 标题对齐（已合并节点设置与全局设置） */
  textAlign: MindmapTextAlign;
  /** 图片显示框（不含边框） */
  imageBox?: { fit: MindmapImageFit; width: number; height: number };
  /** 拉伸手柄所在的自由边（远离父节点的一侧） */
  freeEdge: 'left' | 'right';
  /** 子节点展开方向（折叠 / 添加按钮所在侧） */
  childSide: NodeSide;
  /** 同级节点排列走向 */
  siblingFlow: SiblingFlow;
}

export interface LayoutLink {
  from: LayoutNode;
  to: LayoutNode;
  /** 已按布局与连线样式生成的 SVG path */
  path: string;
}

/** 非父子连线的装饰线（时间轴主轴、鱼骨脊柱等） */
export interface LayoutDecoration {
  path: string;
  strokeWidth: number;
  /** 是否填充（箭头等闭合图形） */
  filled?: boolean;
}

export interface MindmapLayoutResult {
  nodes: LayoutNode[];
  links: LayoutLink[];
  decorations: LayoutDecoration[];
}

/**
 * 连线描述：布局算法只记录连接方式，路径在坐标归一化之后统一生成
 */
export type LinkSpec =
  | { kind: 'horizontal'; from: LayoutNode; to: LayoutNode }
  | { kind: 'vertical'; from: LayoutNode; to: LayoutNode; dir: 1 | -1 }
  /** 缩进树：dir 为子节点相对父锚点的水平方向，anchorSide 为父节点出线的边 */
  | { kind: 'indent'; from: LayoutNode; to: LayoutNode; dir: 1 | -1; anchorSide: 'top' | 'bottom' }
  /** 时间轴主轴段：从前一个轴上节点的右边缘连到当前节点左边缘 */
  | { kind: 'axis'; from: LayoutNode; to: LayoutNode; prev: LayoutNode }
  /** 鱼骨斜骨：从脊柱连到一级分支 */
  | { kind: 'bone'; from: LayoutNode; to: LayoutNode; dx: number; h: number; side: 'above' | 'below' }
  /** 鱼骨肋线：从斜骨上的点横向接入二级节点 */
  | {
      kind: 'rib';
      from: LayoutNode;
      to: LayoutNode;
      spine: LayoutNode;
      dx: number;
      h: number;
    };

/** 单个布局算法的产出：节点已定位（未归一化），连线与装饰线延后生成 */
export interface LayoutPlacement {
  nodes: LayoutNode[];
  specs: LinkSpec[];
  /** 归一化之后生成装饰线 */
  decorate?: () => LayoutDecoration[];
}
