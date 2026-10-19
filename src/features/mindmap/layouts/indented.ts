// NoteBoard 思维导图缩进树状布局（右侧树状图 / 左侧树状图）
// 子节点位于父节点下方并按固定缩进逐行排列，类似文件目录；
// 时间轴与鱼骨图的二级以下节点也复用这里的缩进排列。
// 详见 docs/09-开发路线图.md

import type { LayoutNode, LayoutPlacement, LinkSpec } from './layoutTypes';

/** 每一级的水平缩进 */
export const INDENT_STEP = 36;
/** 父节点出线锚点距其侧边的距离 */
export const INDENT_ANCHOR = 16;
/** 缩进列表中相邻行的纵向间距 */
export const INDENT_V_GAP = 10;

/** 缩进排列的输出收集器 */
export interface IndentSink {
  nodes: LayoutNode[];
  specs: LinkSpec[];
}

/**
 * 把 parent 的子节点按缩进列表排在其下方（或指定起点）
 * @param alignX 子节点对齐边：dir = 1 时为左边缘，dir = -1 时为右边缘
 * @param startY 第一个子节点的顶部
 * @param dir 1 向右缩进；-1 向左缩进
 * @param anchorSide 父节点从哪条边出线
 * @param branchOf 子节点配色序号（按子节点序号计算）
 * @returns 最后一个子孙节点的底部坐标；无子节点时返回 startY
 */
export function placeIndentedChildren(
  parent: LayoutNode,
  alignX: number,
  startY: number,
  dir: 1 | -1,
  anchorSide: 'top' | 'bottom',
  branchOf: (index: number) => number,
  sink: IndentSink,
): number {
  let cursor = startY;
  let bottom = startY;
  parent.children.forEach((child, idx) => {
    child.branchIndex = branchOf(idx);
    child.x = dir === 1 ? alignX : alignX - child.width;
    child.y = cursor;
    child.freeEdge = dir === 1 ? 'right' : 'left';
    child.childSide = 'bottom';
    child.siblingFlow = 'down';
    sink.nodes.push(child);
    sink.specs.push({ kind: 'indent', from: parent, to: child, dir, anchorSide });

    // 孙节点相对子节点再缩进一级
    const grandAlign = dir === 1 ? child.x + INDENT_STEP : child.x + child.width - INDENT_STEP;
    const subBottom = placeIndentedChildren(
      child,
      grandAlign,
      child.y + child.height + INDENT_V_GAP,
      dir,
      'bottom',
      () => child.branchIndex,
      sink,
    );
    bottom = Math.max(child.y + child.height, subBottom);
    cursor = bottom + INDENT_V_GAP;
  });
  return bottom;
}

/** 统计一组节点的水平包围范围 */
export function horizontalExtent(nodes: LayoutNode[]): { minX: number; maxX: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x + n.width);
  }
  return { minX, maxX };
}

/**
 * 右侧 / 左侧树状图
 * @param dir 1 = 右侧树状图（向右缩进）；-1 = 左侧树状图（向左缩进）
 */
export function layoutIndented(root: LayoutNode, dir: 1 | -1, colorCount: number): LayoutPlacement {
  const sink: IndentSink = { nodes: [], specs: [] };
  root.branchIndex = 0;
  root.x = dir === 1 ? 0 : -root.width;
  root.y = 0;
  root.freeEdge = dir === 1 ? 'right' : 'left';
  root.childSide = 'bottom';
  sink.nodes.push(root);

  const alignX = dir === 1 ? root.x + INDENT_STEP : root.x + root.width - INDENT_STEP;
  placeIndentedChildren(
    root,
    alignX,
    root.height + INDENT_V_GAP + 6,
    dir,
    'bottom',
    (idx) => idx % colorCount,
    sink,
  );
  return sink;
}
