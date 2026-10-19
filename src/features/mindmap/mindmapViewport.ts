// 视口裁剪只减少 DOM，不改变全图布局、搜索范围或实际节点树。
import type { LayoutNode, LayoutLink } from './layouts/layoutTypes';

export interface MindmapViewport {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 预留视口外缓冲，平移时可先移动现有图层，再补绘即将进入屏幕的节点。 */
export const VIEWPORT_OVERSCAN = 256;

/** 将屏幕范围换算为导图坐标，缩放越小需要覆盖的世界坐标范围越大。 */
export function getMindmapViewport(pan: { x: number; y: number }, zoom: number, width: number, height: number): MindmapViewport {
  return {
    left: (-pan.x - VIEWPORT_OVERSCAN) / zoom,
    top: (-pan.y - VIEWPORT_OVERSCAN) / zoom,
    right: (width - pan.x + VIEWPORT_OVERSCAN) / zoom,
    bottom: (height - pan.y + VIEWPORT_OVERSCAN) / zoom,
  };
}

/** 节点边界与缓冲视口相交即保留，边缘相接也不能提前隐藏。 */
export function isMindmapNodeVisible(node: LayoutNode, viewport: MindmapViewport): boolean {
  return node.x <= viewport.right && node.x + node.width >= viewport.left
    && node.y <= viewport.bottom && node.y + node.height >= viewport.top;
}

/** 连线跨越视口时即使两端节点不在屏幕内也要保留，避免平移出现断线。 */
export function isMindmapLinkVisible(link: LayoutLink, viewport: MindmapViewport): boolean {
  const left = Math.min(link.from.x, link.to.x);
  const right = Math.max(link.from.x + link.from.width, link.to.x + link.to.width);
  const top = Math.min(link.from.y, link.to.y);
  const bottom = Math.max(link.from.y + link.from.height, link.to.y + link.to.height);
  return left <= viewport.right && right >= viewport.left && top <= viewport.bottom && bottom >= viewport.top;
}
