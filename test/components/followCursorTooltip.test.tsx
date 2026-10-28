// 跟随提示回归：保留延迟与触发元素身份，高频移动只更新图层，不反复渲染 React 子树。
import React, { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Tooltip } from '@/components/Tooltip';

let host: HTMLDivElement;
let root: Root;
let mounted: boolean;
let nextFrameId: number;
const frames = new Map<number, FrameRequestCallback>();
const renders = vi.fn();
const originalMove = vi.fn();

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  frames.clear();
  nextFrameId = 0;
  mounted = true;
  renders.mockClear();
  originalMove.mockClear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrameId, callback); return nextFrameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 使用真实子元素的鼠标事件，保证原事件处理器和双击所依赖的 DOM 身份不变。 */
async function render(disabled = false) {
  await act(async () => root.render(
    <Profiler id="tooltip" onRender={renders}>
      <Tooltip content="跟随提示" followCursor disabled={disabled}>
        <button onMouseMove={originalMove}>触发元素</button>
      </Tooltip>
    </Profiler>,
  ));
  return host.querySelector('button')!;
}

const tooltip = () => (document.querySelector('.nb-tooltip-content')?.parentElement ?? null) as HTMLElement | null;
const mouse = (target: Element, type: string, x: number, y: number) => target.dispatchEvent(new MouseEvent(type, {
  bubbles: true, clientX: x, clientY: y, relatedTarget: type === 'mouseout' ? document.body : null,
}));

async function nextFrame() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}

it('100ms 后按最新指针位置显示，移动不推迟提示出现', async () => {
  const button = await render();
  await act(async () => {
    mouse(button, 'mouseover', 100, 100);
    vi.advanceTimersByTime(50);
    mouse(button, 'mousemove', 200, 220);
    vi.advanceTimersByTime(49);
  });
  expect(tooltip()).toBeNull();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(tooltip()?.style.transform).toBe('translate3d(200px, 206px, 0) translate(-50%, -100%)');
});

it('同一帧 100 次移动只写一次位置，连续移动不产生 React 提交', async () => {
  const button = await render();
  await act(async () => { mouse(button, 'mouseover', 100, 100); vi.advanceTimersByTime(100); });
  const transform = vi.spyOn(tooltip()!.style, 'transform', 'set');
  renders.mockClear();
  await act(async () => {
    for (let i = 0; i < 100; i += 1) mouse(button, 'mousemove', 200 + i, 300);
  });
  expect(transform).not.toHaveBeenCalled();
  expect(frames.size).toBe(1);
  await nextFrame();
  expect(transform).toHaveBeenCalledTimes(1);
  expect(tooltip()?.style.transform).toBe('translate3d(299px, 286px, 0) translate(-50%, -100%)');
  expect(renders).not.toHaveBeenCalled();
  expect(originalMove).toHaveBeenCalledTimes(100);
  transform.mockRestore();
});

it('到达窗口两侧时继续按原规则夹紧提示位置', async () => {
  const button = await render();
  await act(async () => { mouse(button, 'mouseover', 0, 100); vi.advanceTimersByTime(100); });
  expect(tooltip()?.style.transform).toContain('translate3d(90px,');
  await act(async () => mouse(button, 'mousemove', 100000, 100));
  await nextFrame();
  expect(tooltip()?.style.transform).toContain(`translate3d(${window.innerWidth - 90}px,`);
});

it('离开时丢弃待绘位置并隐藏提示', async () => {
  const button = await render();
  await act(async () => { mouse(button, 'mouseover', 100, 100); vi.advanceTimersByTime(100); });
  await act(async () => {
    mouse(button, 'mousemove', 200, 200);
    mouse(button, 'mouseout', 200, 200);
  });
  expect(frames.size).toBe(0);
  expect(tooltip()).toBeNull();
  await nextFrame();
  expect(tooltip()).toBeNull();
});

it('禁用和恢复时保留触发元素身份，并清除待绘帧', async () => {
  const button = await render();
  await act(async () => { mouse(button, 'mouseover', 100, 100); vi.advanceTimersByTime(100); });
  await act(async () => mouse(button, 'mousemove', 200, 200));
  await render(true);
  expect(frames.size).toBe(0);
  expect(tooltip()).toBeNull();
  expect(host.querySelector('button')).toBe(button);
  await render(false);
  expect(host.querySelector('button')).toBe(button);
});

it('卸载时清理未触发的延迟和未绘制的帧', async () => {
  const button = await render();
  await act(async () => { mouse(button, 'mouseover', 100, 100); vi.advanceTimersByTime(100); });
  await act(async () => mouse(button, 'mousemove', 200, 200));
  await act(async () => root.unmount());
  mounted = false;
  expect(frames.size).toBe(0);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(tooltip()).toBeNull();
});
