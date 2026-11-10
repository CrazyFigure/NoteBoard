// 多维表格列宽拖动：表格与甘特图共用鼠标、触摸和手写笔的指针生命周期。
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

interface ColumnResizeOptions {
  /** 无法测量表头时使用的起始列宽。 */
  width: number;
  /** 两种视图沿用最小 90px；甘特图移动端另行限制最大宽度。 */
  minWidth?: number;
  maxWidth?: number;
  onResize: (width: number) => void;
}

/** 捕获发起拖动的指针，实时更新列宽，并在结束、取消、失焦或卸载时完整清理。 */
export function useColumnResize() {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  return useCallback((e: ReactPointerEvent<HTMLDivElement>, options: ColumnResizeOptions) => {
    // 只允许主指针的左键或触摸接管一次拖动，避免多指手势覆盖正在进行的调整。
    if (!e.isPrimary || e.button !== 0 || cleanupRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const trigger = e.currentTarget;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startWidth = trigger.closest('th')?.getBoundingClientRect().width ?? options.width;
    const { minWidth = 90, maxWidth = Infinity, onResize } = options;
    let lastWidth = startWidth;
    const previousCursor = document.body.style.cursor;
    trigger.setPointerCapture(pointerId);
    document.body.style.cursor = 'col-resize';

    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      const width = Math.min(maxWidth, Math.max(minWidth, startWidth + event.clientX - startX));
      if (width === lastWidth) return;
      lastWidth = width;
      onResize(width);
    };
    const cleanup = () => {
      cleanupRef.current = null;
      document.body.style.cursor = previousCursor;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('pointercancel', handleEnd);
      window.removeEventListener('blur', cleanup);
      trigger.removeEventListener('lostpointercapture', handleEnd);
      if (trigger.hasPointerCapture(pointerId)) trigger.releasePointerCapture(pointerId);
    };
    const handleEnd = (event: PointerEvent) => {
      if (event.pointerId === pointerId) cleanup();
    };
    cleanupRef.current = cleanup;
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('pointercancel', handleEnd);
    window.addEventListener('blur', cleanup);
    trigger.addEventListener('lostpointercapture', handleEnd);
  }, []);
}
