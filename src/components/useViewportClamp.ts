// NoteBoard 浮层收回视口
// 下拉面板与子菜单按左右翻转规则定位后，窄窗口（如极窄模式）里两侧都可能放不下：
// 展开时测量一次，越界部分整体平移回窗口内（允许覆盖父级菜单）。
// 平移使用独立的 translate 属性，不与浮层入场动画的 transform 冲突。

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { IS_MOBILE_UI } from '../core/platform';

/** 浮层与窗口边缘保留的最小间距 */
const VIEWPORT_MARGIN = 8;

interface Shift {
  x: number;
  y: number;
}

const NO_SHIFT: Shift = { x: 0, y: 0 };

/**
 * 浮层实际可见的区域：窗口与各级会裁剪溢出内容的祖先容器（如编辑区）的交集
 * 遇到固定定位的元素即停止：其后的祖先不再裁剪它
 */
function visibleBounds(el: HTMLElement): { left: number; top: number; right: number; bottom: number } {
  const bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  if (getComputedStyle(el).position === 'fixed') return bounds;
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      const rect = node.getBoundingClientRect();
      bounds.left = Math.max(bounds.left, rect.left);
      bounds.top = Math.max(bounds.top, rect.top);
      bounds.right = Math.min(bounds.right, rect.right);
      bounds.bottom = Math.min(bounds.bottom, rect.bottom);
    }
    if (style.position === 'fixed') break;
  }
  return bounds;
}

/**
 * @param open 浮层是否展开；每次展开重新测量，收起时复位
 * @param placement 浮层定位方式（如左右翻转结果），变化后重新测量
 * @returns 绑定到浮层根元素的 ref，以及需要合并进浮层样式的平移
 */
export function useViewportClamp<T extends HTMLElement>(open: boolean, placement?: unknown) {
  const ref = useRef<T>(null);
  const [shift, setShift] = useState<Shift>(NO_SHIFT);
  // 测量结果包含当前平移，需扣除后再按原始位置计算
  const shiftRef = useRef<Shift>(NO_SHIFT);

  useLayoutEffect(() => {
    const el = ref.current;
    // 移动端浮层由样式表改为内联展开 / 底部弹出，不做平移
    if (!open || !el || IS_MOBILE_UI) {
      shiftRef.current = NO_SHIFT;
      setShift(NO_SHIFT);
      return;
    }
    const measured = el.getBoundingClientRect();
    const left = measured.left - shiftRef.current.x;
    const right = measured.right - shiftRef.current.x;
    const top = measured.top - shiftRef.current.y;
    const bottom = measured.bottom - shiftRef.current.y;
    const bounds = visibleBounds(el);

    let x = 0;
    if (right > bounds.right - VIEWPORT_MARGIN) x = bounds.right - VIEWPORT_MARGIN - right;
    // 左侧优先：浮层比可见区域还宽时至少保证起始内容可见
    if (left + x < bounds.left + VIEWPORT_MARGIN) x = bounds.left + VIEWPORT_MARGIN - left;

    let y = 0;
    if (bottom > bounds.bottom - VIEWPORT_MARGIN) y = bounds.bottom - VIEWPORT_MARGIN - bottom;
    if (top + y < bounds.top + VIEWPORT_MARGIN) y = bounds.top + VIEWPORT_MARGIN - top;

    const next = x === 0 && y === 0 ? NO_SHIFT : { x, y };
    shiftRef.current = next;
    setShift(next);
  }, [open, placement]);

  const style: CSSProperties = shift === NO_SHIFT ? {} : { translate: `${shift.x}px ${shift.y}px` };
  return { ref, style };
}
