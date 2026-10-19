// NoteBoard 思维导图连线路径生成
// 曲线 / 直线 / 折线三种样式，分别适配水平、垂直与缩进树状三类连接方式。
// 详见 docs/09-开发路线图.md

import type { MindmapEdgeStyle } from '../mindmapTypes';
import type { LayoutNode } from './layoutTypes';

type Point = [number, number];

/** 保留两位小数，避免 path 中出现过长浮点串 */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** 带圆角拐点的折线路径 */
export function roundedPolyline(points: Point[], radius = 6): string {
  if (points.length === 0) return '';
  let d = `M ${fmt(points[0][0])} ${fmt(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const d1 = Math.hypot(cx - px, cy - py);
    const d2 = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r <= 0.5) {
      d += ` L ${fmt(cx)} ${fmt(cy)}`;
      continue;
    }
    // 拐点前后各退 r 距离，用二次贝塞尔圆滑过渡
    const ax = cx + ((px - cx) / d1) * r;
    const ay = cy + ((py - cy) / d1) * r;
    const bx = cx + ((nx - cx) / d2) * r;
    const by = cy + ((ny - cy) / d2) * r;
    d += ` L ${fmt(ax)} ${fmt(ay)} Q ${fmt(cx)} ${fmt(cy)} ${fmt(bx)} ${fmt(by)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${fmt(last[0])} ${fmt(last[1])}`;
  return d;
}

/** 水平布局连线：自动判断父子相对方向（右侧连父节点右边缘，左侧连父节点左边缘） */
export function horizontalLinkPath(from: LayoutNode, to: LayoutNode, edgeStyle: MindmapEdgeStyle): string {
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
    return `M ${fmt(x1)} ${fmt(y1)} L ${fmt(x2)} ${fmt(y2)}`;
  }
  if (edgeStyle === 'elbow') {
    const mx = x1 + (x2 - x1) / 2;
    return roundedPolyline([[x1, y1], [mx, y1], [mx, y2], [x2, y2]]);
  }

  const cX1 = x1 + (x2 - x1) * 0.55;
  const cX2 = x1 + (x2 - x1) * 0.45;
  return `M ${fmt(x1)} ${fmt(y1)} C ${fmt(cX1)} ${fmt(y1)}, ${fmt(cX2)} ${fmt(y2)}, ${fmt(x2)} ${fmt(y2)}`;
}

/**
 * 垂直布局连线（组织图）
 * @param dir 1 = 子节点在下方；-1 = 子节点在上方
 */
export function verticalLinkPath(
  from: LayoutNode,
  to: LayoutNode,
  edgeStyle: MindmapEdgeStyle,
  dir: 1 | -1,
): string {
  const x1 = from.x + from.width / 2;
  const y1 = dir === 1 ? from.y + from.height : from.y;
  const x2 = to.x + to.width / 2;
  const y2 = dir === 1 ? to.y : to.y + to.height;
  if (edgeStyle === 'straight') {
    return `M ${fmt(x1)} ${fmt(y1)} L ${fmt(x2)} ${fmt(y2)}`;
  }
  if (edgeStyle === 'elbow') {
    const my = y1 + (y2 - y1) / 2;
    return roundedPolyline([[x1, y1], [x1, my], [x2, my], [x2, y2]]);
  }
  const cY1 = y1 + (y2 - y1) * 0.55;
  const cY2 = y1 + (y2 - y1) * 0.45;
  return `M ${fmt(x1)} ${fmt(y1)} C ${fmt(x1)} ${fmt(cY1)}, ${fmt(x2)} ${fmt(cY2)}, ${fmt(x2)} ${fmt(y2)}`;
}

/**
 * 缩进树状连线：从父节点底部（或顶部）锚点竖直走到子节点所在行，再横向接入子节点侧边
 */
export function indentLinkPath(
  px: number,
  py: number,
  cx: number,
  cy: number,
  edgeStyle: MindmapEdgeStyle,
): string {
  if (edgeStyle === 'straight') {
    return `M ${fmt(px)} ${fmt(py)} L ${fmt(cx)} ${fmt(cy)}`;
  }
  if (edgeStyle === 'curve') {
    return `M ${fmt(px)} ${fmt(py)} Q ${fmt(px)} ${fmt(cy)} ${fmt(cx)} ${fmt(cy)}`;
  }
  return roundedPolyline([[px, py], [px, cy], [cx, cy]]);
}

/** 两点直线（鱼骨斜骨、时间轴主轴等不随样式变化的连线） */
export function straightPath(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${fmt(x1)} ${fmt(y1)} L ${fmt(x2)} ${fmt(y2)}`;
}
