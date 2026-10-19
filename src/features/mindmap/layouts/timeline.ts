// NoteBoard 思维导图时间轴布局
// 根节点在最左，一级节点沿水平主轴从左到右依次排开；
// 各一级节点的子树以缩进列表形式在主轴上方、下方交替展开。
// 详见 docs/09-开发路线图.md

import type { LayoutNode, LayoutPlacement } from './layoutTypes';
import { INDENT_STEP, horizontalExtent, placeIndentedChildren, type IndentSink } from './indented';
import { straightPath } from './linkPaths';

/** 主轴上相邻节点的间距 */
const TIMELINE_GAP = 44;
/** 一级节点与其子树之间的纵向间距 */
const TIMELINE_BRANCH_GAP = 22;
/** 主轴末端延伸长度（含箭头） */
const TIMELINE_TAIL = 30;

export function layoutTimeline(root: LayoutNode, colorCount: number): LayoutPlacement {
  const sink: IndentSink = { nodes: [], specs: [] };
  // 主轴位于 y = 0，根节点垂直居中于主轴
  root.branchIndex = 0;
  root.x = 0;
  root.y = -root.height / 2;
  root.freeEdge = 'right';
  root.childSide = 'right';
  sink.nodes.push(root);

  let cursorX = root.width + TIMELINE_GAP;
  let prev = root;

  root.children.forEach((l1, idx) => {
    const above = idx % 2 === 0;
    l1.branchIndex = idx % colorCount;
    l1.x = cursorX;
    l1.y = -l1.height / 2;
    l1.freeEdge = 'right';
    l1.childSide = above ? 'top' : 'bottom';
    l1.siblingFlow = 'right';
    sink.nodes.push(l1);
    sink.specs.push({ kind: 'axis', from: root, to: l1, prev });

    const alignX = l1.x + INDENT_STEP;
    let subNodes: LayoutNode[] = [];
    if (l1.children.length > 0) {
      if (above) {
        // 上方子树：先试排一次得到总高度，再整体放到一级节点上方
        const dry: IndentSink = { nodes: [], specs: [] };
        const dryBottom = placeIndentedChildren(l1, alignX, 0, 1, 'top', () => l1.branchIndex, dry);
        const blockHeight = dryBottom;
        const startY = l1.y - TIMELINE_BRANCH_GAP - blockHeight;
        const real: IndentSink = { nodes: [], specs: [] };
        placeIndentedChildren(l1, alignX, startY, 1, 'top', () => l1.branchIndex, real);
        subNodes = real.nodes;
        sink.nodes.push(...real.nodes);
        sink.specs.push(...real.specs);
      } else {
        const real: IndentSink = { nodes: [], specs: [] };
        placeIndentedChildren(
          l1,
          alignX,
          l1.y + l1.height + TIMELINE_BRANCH_GAP,
          1,
          'bottom',
          () => l1.branchIndex,
          real,
        );
        subNodes = real.nodes;
        sink.nodes.push(...real.nodes);
        sink.specs.push(...real.specs);
      }
    }

    const columnRight = subNodes.length > 0
      ? Math.max(l1.x + l1.width, horizontalExtent(subNodes).maxX)
      : l1.x + l1.width;
    cursorX = columnRight + TIMELINE_GAP;
    prev = l1;
  });

  const last = prev;
  return {
    ...sink,
    // 主轴末端：延伸线 + 实心箭头
    decorate: () => {
      const axisY = root.y + root.height / 2;
      const startX = last.x + last.width;
      const tipX = startX + TIMELINE_TAIL;
      return [
        { path: straightPath(startX, axisY, tipX - 6, axisY), strokeWidth: 2.5 },
        {
          path: `M ${tipX} ${axisY} L ${tipX - 9} ${axisY - 5.5} L ${tipX - 9} ${axisY + 5.5} Z`,
          strokeWidth: 1,
          filled: true,
        },
      ];
    },
  };
}
