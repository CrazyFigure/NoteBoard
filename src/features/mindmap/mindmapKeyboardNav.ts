// NoteBoard 思维导图键盘导航
// 方向键在节点间移动选中：父子方向按树结构跳转（回到父节点 / 进入最靠近的子节点），
// 其余方向按画面位置寻找最近的节点；选中节点超出画面时计算最小平移量把它移回可见区域。
// 详见 docs/09-开发路线图.md

import type { LayoutNode, NodeSide } from './layouts/layoutTypes';

export type MindmapNavDirection = 'left' | 'right' | 'up' | 'down';

/** 方向键 → 导航方向 */
export const ARROW_KEY_DIRECTIONS: Readonly<Record<string, MindmapNavDirection>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

const DIRECTION_SIDE: Record<MindmapNavDirection, NodeSide> = {
  left: 'left',
  right: 'right',
  up: 'top',
  down: 'bottom',
};

const OPPOSITE_SIDE: Record<NodeSide, NodeSide> = {
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
};

/** 垂直方向的偏离按此倍数计入距离：同一行 / 列上的节点优先 */
const CROSS_AXIS_WEIGHT = 3;

interface Axis {
  horizontal: boolean;
  /** 沿方向前进为 +1，反向为 -1 */
  sign: 1 | -1;
}

function axisOf(dir: MindmapNavDirection): Axis {
  return {
    horizontal: dir === 'left' || dir === 'right',
    sign: dir === 'right' || dir === 'down' ? 1 : -1,
  };
}

/** 节点中心在主轴 / 副轴上的坐标 */
function centerOn(n: LayoutNode, horizontal: boolean): { main: number; cross: number } {
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  return horizontal ? { main: cx, cross: cy } : { main: cy, cross: cx };
}

/** 两个节点在副轴上的间隙（有重叠时为 0） */
function crossGap(a: LayoutNode, b: LayoutNode, horizontal: boolean): number {
  const [aStart, aEnd] = horizontal ? [a.y, a.y + a.height] : [a.x, a.x + a.width];
  const [bStart, bEnd] = horizontal ? [b.y, b.y + b.height] : [b.x, b.x + b.width];
  return Math.max(0, Math.max(aStart, bStart) - Math.min(aEnd, bEnd));
}

/**
 * 子节点展开轴与同级排列轴互相垂直时，才按树结构跳转父子
 * （缩进树、鱼骨图等两轴重合的布局，按画面位置导航更符合直觉）
 */
function isTreeAxisNode(n: LayoutNode): boolean {
  const childHorizontal = n.childSide === 'left' || n.childSide === 'right';
  const siblingHorizontal = n.siblingFlow !== 'down';
  return childHorizontal !== siblingHorizontal;
}

/** candidate 的中心是否位于 from 中心的指定方向上 */
function isAhead(from: LayoutNode, candidate: LayoutNode, axis: Axis): boolean {
  return axis.sign * (centerOn(candidate, axis.horizontal).main - centerOn(from, axis.horizontal).main) > 1;
}

/**
 * 计算按方向键后应选中的节点
 * @param nodes 当前全部已展开节点的布局（含概要主题子树）
 * @param currentId 当前选中节点
 * @returns 目标节点；该方向没有节点时返回 null
 */
export function findNavigationTarget(
  nodes: readonly LayoutNode[],
  currentId: string,
  dir: MindmapNavDirection,
): LayoutNode | null {
  const current = nodes.find((n) => n.node.id === currentId);
  if (!current) return null;
  const side = DIRECTION_SIDE[dir];
  const axis = axisOf(dir);
  const origin = centerOn(current, axis.horizontal);

  // 1. 朝子节点方向：进入副轴上离当前节点最近的子节点
  const children = current.children.filter(
    (child) => child.childSide === side && isTreeAxisNode(child) && isAhead(current, child, axis),
  );
  if (children.length > 0) {
    let best = children[0];
    let bestScore = Infinity;
    for (const child of children) {
      const c = centerOn(child, axis.horizontal);
      // 副轴距离相同（如缩进排列）时取主轴更近的一个；仍相同则保留靠前的子节点
      const score = Math.abs(c.cross - origin.cross) * 1000 + Math.abs(c.main - origin.main);
      if (score < bestScore) {
        bestScore = score;
        best = child;
      }
    }
    return best;
  }

  // 2. 朝父节点方向：回到父节点
  if (isTreeAxisNode(current) && OPPOSITE_SIDE[current.childSide] === side) {
    const parent = nodes.find((n) => n.children.includes(current));
    if (parent && isAhead(current, parent, axis)) return parent;
  }

  // 3. 其余情况：按画面位置找该方向上最近的节点，同一行 / 列的优先
  let best: LayoutNode | null = null;
  let bestScore = Infinity;
  for (const candidate of nodes) {
    if (candidate === current) continue;
    const c = centerOn(candidate, axis.horizontal);
    const mainDistance = axis.sign * (c.main - origin.main);
    if (mainDistance <= 1) continue;
    const gap = crossGap(current, candidate, axis.horizontal);
    // 副轴中心距离只作为细微的平局裁决
    const score = mainDistance + gap * CROSS_AXIS_WEIGHT + Math.abs(c.cross - origin.cross) * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * 计算让节点完整出现在画面中所需的新平移量（已可见时原样返回）
 * @param pan 当前平移（屏幕像素）
 * @param rect 节点在导图坐标中的矩形
 * @param margin 节点与画面边缘至少保留的距离（屏幕像素），画面放不下时自动收窄
 */
export function panToRevealRect(
  pan: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
  zoom: number,
  viewWidth: number,
  viewHeight: number,
  margin: number,
): { x: number; y: number } {
  const fit = (offset: number, start: number, length: number, viewLength: number) => {
    const size = length * zoom;
    const gap = Math.min(margin, Math.max(0, (viewLength - size) / 2));
    const screenStart = offset + start * zoom;
    if (screenStart < gap) return offset + gap - screenStart;
    const overflow = screenStart + size - (viewLength - gap);
    // 节点比画面还大时贴齐起始边，保证标题可见
    return overflow > 0 ? offset - Math.min(overflow, screenStart - gap) : offset;
  };
  const x = fit(pan.x, rect.x, rect.width, viewWidth);
  const y = fit(pan.y, rect.y, rect.height, viewHeight);
  return x === pan.x && y === pan.y ? pan : { x, y };
}
