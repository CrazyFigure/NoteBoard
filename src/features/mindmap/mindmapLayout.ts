// NoteBoard 思维导图布局引擎
// 自研紧凑无重叠树布局 (Tidy Tree)，支持向右 / 向左 / 双向平衡 / 向下组织图四种排布，
// 并为不同布局生成对应的平滑连线路径。
// 详见 docs/09-开发路线图.md

import type { MindNode, MindmapLayout, MindmapEdgeStyle } from './mindmapTypes';

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
}

export interface LayoutLink {
  from: LayoutNode;
  to: LayoutNode;
}

export interface MindmapLayoutResult {
  nodes: LayoutNode[];
  links: LayoutLink[];
}

/** 水平布局中父子层级间距 */
export const NODE_H_GAP = 54;
/** 水平布局中同级节点纵向间距 */
export const NODE_V_GAP = 18;
/** 垂直布局中父子层级间距 */
const TREE_LEVEL_GAP = 46;
/** 垂直布局中同级节点横向间距 */
const TREE_SIBLING_GAP = 26;
const BASE_NODE_HEIGHT = 36;
const ROOT_NODE_HEIGHT = 44;

/** 估算节点卡片宽度与高度 */
export function estimateNodeSize(node: MindNode, isRoot: boolean): { width: number; height: number } {
  const textLen = (node.text || '中心主题').length;
  const hasIcon = Boolean(node.icon);
  const hasNote = Boolean(node.note);
  const hasImage = Boolean(node.image);

  let baseWidth = isRoot ? 120 : 90;
  if (hasIcon) baseWidth += 24;
  let width = Math.min(280, Math.max(baseWidth, textLen * 13 + (hasIcon ? 56 : 36)));

  let height = isRoot ? ROOT_NODE_HEIGHT : BASE_NODE_HEIGHT;

  // 备注文字根据实际多行行数精确计算高度与宽度
  if (hasNote) {
    const noteLines = (node.note || '').split('\n');
    const lineCount = Math.max(1, noteLines.length);
    const visibleLines = Math.min(8, lineCount);
    // 每行备注约 16px 行高 + 6px 边距
    const noteHeight = visibleLines * 16 + 6;
    height += noteHeight;

    const maxLineLen = Math.max(...noteLines.map((l) => l.length), 0);
    width = Math.min(320, Math.max(width, Math.min(280, maxLineLen * 11 + 36)));
  }

  // 图片增加高度
  if (hasImage) {
    height += 60;
    width = Math.max(width, 160);
  }

  return { width, height };
}

/** 自底向上度量：沿堆叠轴累加子树尺寸 */
function measureSubTree(node: MindNode, level: number, isVertical: boolean): LayoutNode {
  const isRoot = level === 0;
  const { width, height } = estimateNodeSize(node, isRoot);
  const isExpanded = node.isExpanded !== false;
  const crossSize = isVertical ? width : height;

  const layoutNode: LayoutNode = {
    node,
    x: 0,
    y: 0,
    width,
    height,
    level,
    branchIndex: 0,
    totalSubHeight: crossSize,
    children: [],
  };

  if (!isExpanded || !node.children || node.children.length === 0) {
    return layoutNode;
  }

  const measuredChildren = node.children.map((c) => measureSubTree(c, level + 1, isVertical));
  const siblingGap = isVertical ? TREE_SIBLING_GAP : NODE_V_GAP;
  const totalChildrenExtent =
    measuredChildren.reduce((sum, c) => sum + c.totalSubHeight, 0) +
    (measuredChildren.length - 1) * siblingGap;

  layoutNode.children = measuredChildren;
  layoutNode.totalSubHeight = Math.max(crossSize, totalChildrenExtent);
  return layoutNode;
}

/**
 * 水平方向分配坐标（dir = 1 向右展开；dir = -1 向左展开）
 * 同一分支下的所有子孙共用同一配色序号
 */
function assignHorizontal(
  node: LayoutNode,
  startX: number,
  startY: number,
  dir: 1 | -1,
  branchIndex: number,
  outNodes: LayoutNode[],
  outLinks: LayoutLink[],
) {
  node.branchIndex = branchIndex;
  node.x = dir === 1 ? startX : startX - node.width;
  node.y = startY + (node.totalSubHeight - node.height) / 2;
  outNodes.push(node);

  if (node.children.length === 0) return;

  const childStartX = dir === 1 ? startX + node.width + NODE_H_GAP : startX - node.width - NODE_H_GAP;
  let cursor = startY;
  for (const child of node.children) {
    assignHorizontal(child, childStartX, cursor, dir, branchIndex, outNodes, outLinks);
    outLinks.push({ from: node, to: child });
    cursor += child.totalSubHeight + NODE_V_GAP;
  }
}

/** 垂直方向分配坐标（自顶向下组织图） */
function assignVertical(
  node: LayoutNode,
  startX: number,
  startY: number,
  branchIndex: number,
  outNodes: LayoutNode[],
  outLinks: LayoutLink[],
) {
  node.branchIndex = branchIndex;
  node.y = startY;
  node.x = startX + (node.totalSubHeight - node.width) / 2;
  outNodes.push(node);

  if (node.children.length === 0) return;

  const childStartY = startY + node.height + TREE_LEVEL_GAP;
  let cursor = startX;
  for (const child of node.children) {
    assignVertical(child, cursor, childStartY, branchIndex, outNodes, outLinks);
    outLinks.push({ from: node, to: child });
    cursor += child.totalSubHeight + TREE_SIBLING_GAP;
  }
}

/** 将整体包围盒平移到原点，避免出现负坐标导致初始视口外内容不可见 */
function normalizeToOrigin(nodes: LayoutNode[]) {
  if (nodes.length === 0) return;
  let minX = Infinity;
  let minY = Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
  }
  if (minX === 0 && minY === 0) return;
  for (const n of nodes) {
    n.x -= minX;
    n.y -= minY;
  }
}

/**
 * 计算整棵思维导图的绝对坐标与连接关系
 * @param colorCount 主题配色数量，用于一级分支循环取色
 */
export function computeMindmapLayout(
  root: MindNode,
  layout: MindmapLayout,
  colorCount: number,
): MindmapLayoutResult {
  const isVertical = layout === 'tree';
  const measuredRoot = measureSubTree(root, 0, isVertical);
  const nodes: LayoutNode[] = [];
  const links: LayoutLink[] = [];
  const safeColorCount = Math.max(1, colorCount);

  if (isVertical) {
    // 根节点居中于子层级上方，一级分支按序循环取色
    const childrenExtent =
      measuredRoot.children.reduce((sum, c) => sum + c.totalSubHeight, 0) +
      Math.max(0, measuredRoot.children.length - 1) * TREE_SIBLING_GAP;
    measuredRoot.branchIndex = 0;
    measuredRoot.y = 0;
    measuredRoot.x = (childrenExtent - measuredRoot.width) / 2;
    nodes.push(measuredRoot);

    const childStartY = measuredRoot.height + TREE_LEVEL_GAP;
    let cursor = 0;
    measuredRoot.children.forEach((child, idx) => {
      assignVertical(child, cursor, childStartY, idx % safeColorCount, nodes, links);
      links.push({ from: measuredRoot, to: child });
      cursor += child.totalSubHeight + TREE_SIBLING_GAP;
    });

    normalizeToOrigin(nodes);
    return { nodes, links };
  }

  if (layout === 'balanced') {
    const children = measuredRoot.children;
    const rightGroup: LayoutNode[] = [];
    const leftGroup: LayoutNode[] = [];
    children.forEach((child, idx) => {
      (idx % 2 === 0 ? rightGroup : leftGroup).push(child);
    });

    const groupExtent = (group: LayoutNode[]) =>
      group.length === 0
        ? 0
        : group.reduce((sum, c) => sum + c.totalSubHeight, 0) + (group.length - 1) * NODE_V_GAP;

    const rightExtent = groupExtent(rightGroup);
    const leftExtent = groupExtent(leftGroup);
    const totalExtent = Math.max(rightExtent, leftExtent, measuredRoot.height);

    // 根节点居中，一级分支左右交替分布
    measuredRoot.x = -measuredRoot.width / 2;
    measuredRoot.y = (totalExtent - measuredRoot.height) / 2;
    measuredRoot.branchIndex = 0;
    nodes.push(measuredRoot);

    let cursor = (totalExtent - rightExtent) / 2;
    for (const child of rightGroup) {
      const branchIndex = children.indexOf(child) % safeColorCount;
      assignHorizontal(
        child,
        measuredRoot.width / 2 + NODE_H_GAP,
        cursor,
        1,
        branchIndex,
        nodes,
        links,
      );
      links.push({ from: measuredRoot, to: child });
      cursor += child.totalSubHeight + NODE_V_GAP;
    }

    cursor = (totalExtent - leftExtent) / 2;
    for (const child of leftGroup) {
      const branchIndex = children.indexOf(child) % safeColorCount;
      assignHorizontal(
        child,
        -measuredRoot.width / 2 - NODE_H_GAP,
        cursor,
        -1,
        branchIndex,
        nodes,
        links,
      );
      links.push({ from: measuredRoot, to: child });
      cursor += child.totalSubHeight + NODE_V_GAP;
    }

    normalizeToOrigin(nodes);
    return { nodes, links };
  }

  // right / left：根节点单侧展开
  const dir: 1 | -1 = layout === 'left' ? -1 : 1;
  measuredRoot.branchIndex = 0;
  measuredRoot.x = dir === 1 ? 0 : -measuredRoot.width;
  measuredRoot.y = (measuredRoot.totalSubHeight - measuredRoot.height) / 2;
  nodes.push(measuredRoot);

  // dir === -1 时 startX 表示节点的右边缘，子节点从根节点左边缘再向左延伸一段间距
  const childStartX =
    dir === 1 ? measuredRoot.width + NODE_H_GAP : -measuredRoot.width - NODE_H_GAP;
  let cursor = 0;
  measuredRoot.children.forEach((child, idx) => {
    assignHorizontal(child, childStartX, cursor, dir, idx % safeColorCount, nodes, links);
    links.push({ from: measuredRoot, to: child });
    cursor += child.totalSubHeight + NODE_V_GAP;
  });

  normalizeToOrigin(nodes);
  return { nodes, links };
}

/** 生成单条连接线的 SVG path */
export function buildLinkPath(
  from: LayoutNode,
  to: LayoutNode,
  layout: MindmapLayout,
  edgeStyle: MindmapEdgeStyle = 'curve',
): string {
  if (layout === 'tree') {
    const x1 = from.x + from.width / 2;
    const y1 = from.y + from.height;
    const x2 = to.x + to.width / 2;
    const y2 = to.y;
    if (edgeStyle === 'straight') {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    const cY1 = y1 + (y2 - y1) * 0.55;
    const cY2 = y1 + (y2 - y1) * 0.45;
    return `M ${x1} ${y1} C ${x1} ${cY1}, ${x2} ${cY2}, ${x2} ${y2}`;
  }

  // 水平布局：自动判断父子相对方向（右侧连父节点右边缘，左侧连父节点左边缘）
  let x1: number;
  let x2: number;
  if (to.x >= from.x) {
    x1 = from.x + from.width;
    x2 = to.x;
  } else {
    x1 = from.x;
    x2 = to.x + to.width;
  }
  const y1 = from.y + from.height / 2;
  const y2 = to.y + to.height / 2;

  if (edgeStyle === 'straight') {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }

  const cX1 = x1 + (x2 - x1) * 0.55;
  const cX2 = x1 + (x2 - x1) * 0.45;
  return `M ${x1} ${y1} C ${cX1} ${y1}, ${cX2} ${y2}, ${x2} ${y2}`;
}
