// NoteBoard 多维表格通用「指针拖拽排序」Hook
// 表头换列与视图 Tab 换序共用同一套实现，保证两处的手感与落点语义完全一致。
//
// 关键设计：落点用「插入槽位 (insert slot)」而不是「目标索引」表达。
// N 个元素共 N+1 个槽位，槽位 k 表示「插入到第 k 个元素之前」，k = N 表示追加到末尾。
// 落库时数组操作是 splice「先删后插」，因此提交前必须换算为删除后的插入索引：
//     toIdx = insertAt > fromIdx ? insertAt - 1 : insertAt
// 若直接把槽位当索引用，指示线会画在元素左侧、元素却落到右侧一位，
// 表现为「鼠标明明停在这里，列却跑到隔壁」。

import { useCallback, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { isSlotNoop, slotToSpliceIndex } from './bitableUtils';

export interface PointerDragState {
  /** 被拖拽元素的原始索引 */
  fromIdx: number;
  /** 落点槽位，取值 0 ~ items.length */
  insertAt: number;
  /** 指针视口坐标 */
  x: number;
  y: number;
}

export interface PointerReorderOptions<T> {
  items: T[];
  /** 取元素对应的 DOM 节点，用于测量位置 */
  getElement: (item: T) => HTMLElement | null | undefined;
  /** 提交重排：参数为原始索引与「删除后的插入索引」 */
  onReorder: (fromIdx: number, toIdx: number) => void;
  /** 位移未超过阈值时视为点击 */
  onTap?: (idx: number, event: MouseEvent) => void;
  /** 需要排除的子元素选择器（按钮、输入框等），默认 [data-no-drag] */
  skipSelector?: string;
  /** 拖拽轴，默认水平 */
  axis?: 'x' | 'y';
  disabled?: boolean;
  /** 触发拖拽的位移阈值（像素），默认 4 */
  threshold?: number;
}

export function usePointerReorder<T>({
  items,
  getElement,
  onReorder,
  onTap,
  skipSelector = '[data-no-drag]',
  axis = 'x',
  disabled = false,
  threshold = 4,
}: PointerReorderOptions<T>) {
  const [drag, setDrag] = useState<PointerDragState | null>(null);
  const metaRef = useRef<{
    fromIdx: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  /** 抓取点相对被拖元素左上角的偏移，用于让拖拽幽灵与元素精准贴合 */
  const grabOffsetRef = useRef({ x: 0, y: 0 });
  const suppressClickRef = useRef(false);

  /** 依据指针坐标计算落点槽位：以每个元素自身的中线为分界 */
  const resolveSlot = useCallback(
    (clientX: number, clientY: number) => {
      const pointer = axis === 'x' ? clientX : clientY;
      for (let i = 0; i < items.length; i += 1) {
        const el = getElement(items[i]);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const start = axis === 'x' ? rect.left : rect.top;
        const size = axis === 'x' ? rect.width : rect.height;
        if (pointer < start + size / 2) return i;
      }
      return items.length;
    },
    [items, getElement, axis],
  );

  const startDrag = useCallback(
    (e: ReactMouseEvent, idx: number) => {
      if (disabled || e.button !== 0) return;
      // 菜单按钮、输入框、列宽把手等元素不参与拖拽
      if (skipSelector && (e.target as HTMLElement | null)?.closest?.(skipSelector)) return;

      const el = getElement(items[idx]);
      if (el) {
        const rect = el.getBoundingClientRect();
        grabOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      } else {
        grabOffsetRef.current = { x: 0, y: 0 };
      }
      pointerRef.current = { x: e.clientX, y: e.clientY };
      metaRef.current = { fromIdx: idx, startX: e.clientX, startY: e.clientY, active: false };

      const handleMove = (moveEvent: MouseEvent) => {
        const meta = metaRef.current;
        if (!meta) return;
        if (!meta.active) {
          if (
            Math.abs(moveEvent.clientX - meta.startX) < threshold &&
            Math.abs(moveEvent.clientY - meta.startY) < threshold
          ) {
            return;
          }
          meta.active = true;
        }
        moveEvent.preventDefault();
        pointerRef.current = { x: moveEvent.clientX, y: moveEvent.clientY };
        // 每帧最多刷新一次，避免高频重绘整张表格
        if (rafRef.current !== null) return;
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = null;
          const current = metaRef.current;
          if (!current) return;
          setDrag({
            fromIdx: current.fromIdx,
            insertAt: resolveSlot(pointerRef.current.x, pointerRef.current.y),
            x: pointerRef.current.x,
            y: pointerRef.current.y,
          });
        });
      };

      const handleUp = (upEvent: MouseEvent) => {
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleUp);
        if (rafRef.current !== null) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        const meta = metaRef.current;
        metaRef.current = null;
        setDrag(null);
        if (!meta) return;

        if (!meta.active) {
          onTap?.(idx, upEvent);
          return;
        }

        // 拖拽结束后紧跟的 click 不应再触发切换等点击行为；
        // 若指针在元素外松开则不会派发 click，用宏任务兜底复位，避免标记残留吞掉下一次点击
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        const insertAt = resolveSlot(upEvent.clientX, upEvent.clientY);
        // 落在自身左右两侧等同于原位，无需提交
        if (isSlotNoop(insertAt, meta.fromIdx)) return;
        onReorder(meta.fromIdx, slotToSpliceIndex(insertAt, meta.fromIdx));
      };

      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);
    },
    [disabled, items, getElement, onReorder, onTap, resolveSlot, skipSelector, threshold],
  );

  /**
   * 判断指定索引处应绘制的落点指示线位置
   * null 表示不绘制（包含落在原位两侧的情况，避免出现「无意义的移动」提示）
   */
  const getIndicator = useCallback(
    (idx: number): 'left' | 'right' | null => {
      if (!drag) return null;
      const { fromIdx, insertAt } = drag;
      if (isSlotNoop(insertAt, fromIdx)) return null;
      if (insertAt === idx) return 'left';
      if (insertAt === items.length && idx === items.length - 1) return 'right';
      return null;
    },
    [drag, items.length],
  );

  /** 消费「本次点击由拖拽引发」标记：消费一次后自动复位 */
  const consumeDraggedFlag = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  return {
    drag,
    startDrag,
    getIndicator,
    grabOffset: grabOffsetRef.current,
    consumeDraggedFlag,
  };
}
