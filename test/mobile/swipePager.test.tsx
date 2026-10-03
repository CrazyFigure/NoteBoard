// NoteBoard 移动端左右滑动分页测试
// 重点覆盖 Android WebView 的事件特征：横向手势可能以 pointercancel 结束，且取消事件坐标为 0。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SwipePager } from '../../src/mobile/SwipePager';

let container: HTMLDivElement;
let root: Root;

/** 渲染分页器，返回切换回调 */
function renderPager(index: number) {
  const onIndexChange = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <SwipePager index={index} count={3} onIndexChange={onIndexChange}>
        {[<div key="a">A</div>, <div key="b">B</div>, <div key="c">C</div>]}
      </SwipePager>,
    );
  });
  const viewport = container.querySelector('.nb-m-pager') as HTMLDivElement;
  // jsdom 无布局，手动给定视口宽度
  Object.defineProperty(viewport, 'clientWidth', { value: 400, configurable: true });
  return { viewport, onIndexChange };
}

// 模拟时间轴：jsdom 中连续派发的事件几乎同一时刻，速度会被算得极大而掩盖位移判定
let clock = 1000;

/** 派发指针事件（jsdom 中用 MouseEvent 携带坐标，pointerId 统一为 undefined；timeStamp 按模拟时钟） */
function pointer(target: Element, type: string, clientX: number, clientY = 300, advanceMs = 100) {
  clock += advanceMs;
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, 'timeStamp', { value: clock });
  target.dispatchEvent(event);
}

/** 按步匀速移动手指（默认每步 100ms，速度约 0.25px/ms，低于快速轻扫阈值，按位移判定） */
function drag(target: Element, from: number, to: number, steps = 8) {
  pointer(target, 'pointerdown', from);
  for (let step = 1; step <= steps; step += 1) {
    pointer(target, 'pointermove', from + ((to - from) * step) / steps);
  }
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SwipePager', () => {
  it('向左滑动切到下一页', () => {
    const { viewport, onIndexChange } = renderPager(1);
    drag(viewport, 300, 100);
    pointer(viewport, 'pointerup', 100);
    expect(onIndexChange).toHaveBeenCalledWith(2);
  });

  it('向右滑动切到上一页', () => {
    const { viewport, onIndexChange } = renderPager(1);
    drag(viewport, 100, 300);
    pointer(viewport, 'pointerup', 300);
    expect(onIndexChange).toHaveBeenCalledWith(0);
  });

  it('向右滑动以坐标为 0 的 pointercancel 结束时仍切到上一页（Android WebView）', () => {
    const { viewport, onIndexChange } = renderPager(1);
    drag(viewport, 100, 300);
    pointer(viewport, 'pointercancel', 0, 0);
    expect(onIndexChange).toHaveBeenCalledWith(0);
    expect(onIndexChange).not.toHaveBeenCalledWith(2);
  });

  it('首页继续向右滑动不越界', () => {
    const { viewport, onIndexChange } = renderPager(0);
    drag(viewport, 100, 300);
    pointer(viewport, 'pointerup', 300);
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('纵向滑动不翻页', () => {
    const { viewport, onIndexChange } = renderPager(1);
    pointer(viewport, 'pointerdown', 200, 100);
    for (let step = 1; step <= 8; step += 1) pointer(viewport, 'pointermove', 205, 100 + step * 40);
    pointer(viewport, 'pointerup', 205, 420);
    expect(onIndexChange).not.toHaveBeenCalled();
  });
});
