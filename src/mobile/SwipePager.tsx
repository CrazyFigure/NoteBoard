// NoteBoard 移动端左右滑动分页
// 首页"文件 / 收藏 / 已打开"之间跟手滑动切换：
// - 方向锁定：横向位移明显大于纵向时才接管，纵向滚动列表不受影响；
// - 跟手 + 边缘阻尼：首页/末页继续拖动时按 0.35 系数衰减；
// - 释放判定：位移超过 22% 宽度或速度足够快即翻页，否则回弹；
// - 动画：320ms ease-out（cubic-bezier(0.22, 1, 0.36, 1)），与系统手势观感一致；尊重"减少动态效果"设置。

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

export interface SwipePagerProps {
  index: number;
  count: number;
  onIndexChange: (index: number) => void;
  /** 拖动进度回调（以页为单位的连续位置，供分段控件指示条跟随） */
  onProgress?: (position: number) => void;
  children: ReactNode[];
}

const LOCK_DISTANCE = 10;
const SWITCH_RATIO = 0.22;
const SWITCH_VELOCITY = 0.45; // px/ms
const EDGE_RESISTANCE = 0.35;
const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const DURATION_MS = 320;
// 在这些区域内开始的手势不触发翻页（面包屑、位置栏自身可横向滚动或点击）
const NO_SWIPE_SELECTOR = '[data-no-swipe], input, textarea, select';

export function SwipePager({ index, count, onIndexChange, onProgress, children }: SwipePagerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastT: number;
    velocity: number;
    locked: 'x' | 'y' | null;
  } | null>(null);
  // 刚完成一次横向拖动：吞掉随后的 click，避免松手时误打开列表项
  const suppressClickRef = useRef(false);

  const reduceMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /** 把轨道移到指定连续位置（以页为单位），animated 控制是否过渡 */
  const applyPosition = (position: number, animated: boolean) => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = animated && !reduceMotion ? `transform ${DURATION_MS}ms ${EASING}` : 'none';
    track.style.transform = `translate3d(${-position * 100 / count}%, 0, 0)`;
    onProgress?.(position);
  };

  // 外部切换（点分段控件）时动画滑到目标页
  useLayoutEffect(() => {
    applyPosition(index, true);
    // applyPosition 依赖的状态均为 ref，只需随 index 变化执行
  }, [index]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if ((event.target as Element | null)?.closest(NO_SWIPE_SELECTOR)) return;
      gestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastT: event.timeStamp,
        velocity: 0,
        locked: null,
      };
    };

    const handleMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (!gesture.locked) {
        if (Math.abs(dx) < LOCK_DISTANCE && Math.abs(dy) < LOCK_DISTANCE) {
          // 锁定方向前也记录最新位置，保证速度与取消时的回退坐标准确
          gesture.lastX = event.clientX;
          gesture.lastT = event.timeStamp;
          return;
        }
        gesture.locked = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
        if (gesture.locked === 'x') viewport.setPointerCapture?.(event.pointerId);
      }
      if (gesture.locked !== 'x') return;

      // 速度采用指数平滑，减少末段抖动对判定的影响
      const dt = Math.max(1, event.timeStamp - gesture.lastT);
      const instant = (event.clientX - gesture.lastX) / dt;
      gesture.velocity = gesture.velocity * 0.6 + instant * 0.4;
      gesture.lastX = event.clientX;
      gesture.lastT = event.timeStamp;

      const width = viewport.clientWidth || 1;
      let offset = -dx / width;
      const target = index + offset;
      // 首末页外继续拖动时加阻尼
      if (target < 0) offset = -index + target * EDGE_RESISTANCE;
      if (target > count - 1) offset = (count - 1 - index) + (target - (count - 1)) * EDGE_RESISTANCE;
      applyPosition(index + offset, false);
    };

    const finish = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      if (gesture.locked !== 'x') return;
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);

      const width = viewport.clientWidth || 1;
      // pointercancel 事件在 Android WebView 上坐标通常为 0，必须改用最后一次有效移动位置，
      // 否则任何手势都会被算成大幅左滑（这正是"只能向右翻页"的根因）
      const endX = event.type === 'pointercancel' ? gesture.lastX : event.clientX;
      const dx = endX - gesture.startX;
      // 先看速度（快速轻扫），再看位移；两者只取其一，避免互相覆盖
      let direction = 0;
      if (Math.abs(gesture.velocity) >= SWITCH_VELOCITY) {
        direction = gesture.velocity < 0 ? 1 : -1;
      } else if (Math.abs(dx) >= width * SWITCH_RATIO) {
        direction = dx < 0 ? 1 : -1;
      }
      const next = Math.max(0, Math.min(count - 1, index + direction));
      if (next !== index) {
        onIndexChange(next);
      } else {
        applyPosition(index, true);
      }
    };

    const handleClickCapture = (event: MouseEvent) => {
      if (!suppressClickRef.current) return;
      event.stopPropagation();
      event.preventDefault();
    };

    viewport.addEventListener('pointerdown', handleDown);
    viewport.addEventListener('pointermove', handleMove);
    viewport.addEventListener('pointerup', finish);
    viewport.addEventListener('pointercancel', finish);
    viewport.addEventListener('click', handleClickCapture, true);
    return () => {
      viewport.removeEventListener('pointerdown', handleDown);
      viewport.removeEventListener('pointermove', handleMove);
      viewport.removeEventListener('pointerup', finish);
      viewport.removeEventListener('pointercancel', finish);
      viewport.removeEventListener('click', handleClickCapture, true);
    };
    // 手势处理只依赖当前页序号与页数
  }, [index, count]);

  return (
    <div ref={viewportRef} className="nb-m-pager">
      <div ref={trackRef} className="nb-m-pager-track" style={{ width: `${count * 100}%` }}>
        {children.map((child, childIndex) => (
          <section
            key={childIndex}
            className="nb-m-pager-page"
            style={{ width: `${100 / count}%` }}
            aria-hidden={childIndex !== index}
          >
            {child}
          </section>
        ))}
      </div>
    </div>
  );
}
