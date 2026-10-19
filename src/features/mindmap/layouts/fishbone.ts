// NoteBoard 思维导图鱼骨图布局
// 鱼头（根节点）在右，脊柱水平向左延伸；一级分支在脊柱上下交替，经斜骨连到脊柱；
// 二级节点沿斜骨逐行排开并以横向肋线接入，三级及以下按缩进列表展开。
// 详见 docs/09-开发路线图.md

import type { LayoutNode, LayoutPlacement } from './layoutTypes';
import {
  INDENT_STEP,
  INDENT_V_GAP,
  horizontalExtent,
  placeIndentedChildren,
  type IndentSink,
} from './indented';
import { straightPath } from './linkPaths';

/** 鱼头与最近一根斜骨区域的间距 */
const FISH_HEAD_GAP = 36;
/** 同侧相邻斜骨区域的间距 */
const FISH_COL_GAP = 28;
/** 斜骨上相邻二级子树的行距 */
const FISH_ROW_GAP = 12;
/** 斜骨两端的留白 */
const FISH_EDGE_PAD = 16;
/** 二级节点与斜骨的水平间距 */
const FISH_RIB_GAP = 14;
/** 斜骨水平跨度与高度之比 */
const FISH_SLOPE = 0.5;
/** 斜骨最小高度 */
const FISH_MIN_BONE = 56;
/** 脊柱尾部延伸长度 */
const FISH_TAIL = 28;

/** 试排二级子树（含其缩进子孙），返回高度与相对左边缘的宽度 */
function measureRibSubtree(child: LayoutNode): { height: number; width: number } {
  const dry: IndentSink = { nodes: [], specs: [] };
  child.x = 0;
  child.y = 0;
  dry.nodes.push(child);
  const bottom = placeIndentedChildren(
    child,
    INDENT_STEP,
    child.height + INDENT_V_GAP,
    1,
    'bottom',
    () => 0,
    dry,
  );
  const { maxX } = horizontalExtent(dry.nodes);
  return { height: Math.max(child.height, bottom), width: maxX };
}

export function layoutFishbone(root: LayoutNode, colorCount: number): LayoutPlacement {
  const sink: IndentSink = { nodes: [], specs: [] };
  // 脊柱位于 y = 0，鱼头左边缘位于 x = 0
  root.branchIndex = 0;
  root.x = 0;
  root.y = -root.height / 2;
  root.freeEdge = 'right';
  root.childSide = 'left';
  sink.nodes.push(root);

  // 上下两侧各自从鱼头向左推进（右边界游标）
  const cursors = { above: -FISH_HEAD_GAP, below: -FISH_HEAD_GAP };
  let leftmost = root.x;

  root.children.forEach((l1, idx) => {
    const side: 'above' | 'below' = idx % 2 === 0 ? 'above' : 'below';
    l1.branchIndex = idx % colorCount;
    l1.freeEdge = 'right';
    l1.childSide = 'right';
    l1.siblingFlow = 'left';

    // 1. 试排所有二级子树，确定斜骨高度
    const rows = l1.children.map((c) => ({ node: c, ...measureRibSubtree(c) }));
    const rowsHeight =
      rows.reduce((sum, r) => sum + r.height, 0) + Math.max(0, rows.length - 1) * FISH_ROW_GAP;
    const h = Math.max(FISH_MIN_BONE, rowsHeight + FISH_EDGE_PAD * 2);
    const dx = h * FISH_SLOPE;

    // 2. 行的纵向位置（相对脊柱）与该处斜骨的水平偏移（相对脊柱交点，<= 0）
    let rowTop = side === 'above' ? -h + FISH_EDGE_PAD : FISH_EDGE_PAD;
    const rowPlans = rows.map((r) => {
      const centerY = rowTop + r.node.height / 2;
      const boneOffset = -dx * (Math.abs(centerY) / h);
      const plan = { ...r, top: rowTop, boneOffset };
      rowTop += r.height + FISH_ROW_GAP;
      return plan;
    });

    // 3. 根据二级子树向右伸出的最大宽度确定斜骨与脊柱的交点
    const rightReach = rowPlans.reduce(
      (max, p) => Math.max(max, p.boneOffset + FISH_RIB_GAP + p.width),
      0,
    );
    const spineX = cursors[side] - rightReach - 8;
    const boneTopX = spineX - dx;
    cursors[side] = boneTopX - l1.width / 2 - FISH_COL_GAP;
    leftmost = Math.min(leftmost, boneTopX - l1.width / 2);

    // 4. 一级节点位于斜骨外端
    l1.x = boneTopX - l1.width / 2;
    l1.y = side === 'above' ? -h - l1.height : h;
    sink.nodes.push(l1);
    sink.specs.push({ kind: 'bone', from: root, to: l1, dx, h, side });

    // 5. 二级子树沿斜骨逐行放置
    for (const plan of rowPlans) {
      const child = plan.node;
      child.branchIndex = l1.branchIndex;
      child.x = spineX + plan.boneOffset + FISH_RIB_GAP;
      child.y = plan.top;
      child.freeEdge = 'right';
      child.childSide = 'bottom';
      child.siblingFlow = 'down';
      sink.nodes.push(child);
      sink.specs.push({ kind: 'rib', from: l1, to: child, spine: root, dx, h });
      placeIndentedChildren(
        child,
        child.x + INDENT_STEP,
        child.y + child.height + INDENT_V_GAP,
        1,
        'bottom',
        () => l1.branchIndex,
        sink,
      );
    }
  });

  const tailX = leftmost;
  return {
    ...sink,
    // 脊柱：从鱼头左边缘贯穿到最左侧斜骨之外
    decorate: () => {
      const spineY = root.y + root.height / 2;
      // 排布时鱼头位于 x = 0，归一化后的 root.x 即整体平移量
      const offset = root.x;
      const endX = root.children.length > 0 ? tailX + offset - FISH_TAIL : root.x - 60;
      return [{ path: straightPath(root.x, spineY, endX, spineY), strokeWidth: 3 }];
    },
  };
}
