// 触屏双指捏合：拖过概要端点手柄（pointerup 被手柄阻止冒泡）后，捏合缩放仍要正常工作。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
import { MindmapRenderer } from '@/features/mindmap/MindmapRenderer';
import { getMindmapTheme } from '@/features/mindmap/mindmapTheme';
import type { MindNode } from '@/features/mindmap/mindmapTypes';

const tree = (): MindNode => ({
  id: 'root', text: '中心', isExpanded: true,
  summaries: [{ id: 's1', startId: 'a', endId: 'b', text: '概要' }],
  children: [
    { id: 'a', text: 'A', isExpanded: true, children: [] },
    { id: 'b', text: 'B', isExpanded: true, children: [] },
  ],
});

/** 派发触屏指针事件 */
const touch = (el: Element, type: string, pointerId: number, x: number, y: number, isPrimary: boolean) => {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, pointerType: 'touch', isPrimary, clientX: x, clientY: y, button: 0 }));
};

describe('触屏捏合缩放', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const renderMindmap = async (onZoomChange: (zoom: number) => void) => {
    const theme = getMindmapTheme();
    await act(async () => root.render(
      <MindmapRenderer root={tree()} onChange={() => {}} zoom={1} onZoomChange={onZoomChange} layout="right" theme={theme}
        edgeStyle={theme.edgeStyle} maxNodeWidth={300} defaultTextAlign="left" defaultImageFit="original" />,
    ));
    // 画布容器即 host 的第一个子元素
    return host.firstElementChild as HTMLElement;
  };

  it('拖动概要端点手柄后，双指捏合仍按两指距离缩放', async () => {
    const onZoomChange = vi.fn();
    const canvas = await renderMindmap(onZoomChange);
    // 选中概要，出现范围手柄
    await act(async () => (host.querySelector('.nb-mindmap-summary-label') as HTMLElement).click());
    const handle = host.querySelector('.nb-mindmap-range-handle') as HTMLElement;
    expect(handle).toBeTruthy();
    // 单指在手柄上按下、抬起（手柄会阻止 pointerup 冒泡）
    await act(async () => {
      touch(handle, 'pointerdown', 11, 50, 50, true);
      touch(handle, 'pointerup', 11, 50, 50, true);
    });
    // 新一轮双指捏合：两指间距从 100 拉到 200，应放大到 2 倍
    await act(async () => {
      touch(canvas, 'pointerdown', 12, 100, 100, true);
      touch(canvas, 'pointerdown', 13, 200, 100, false);
      touch(canvas, 'pointermove', 13, 300, 100, false);
    });
    expect(onZoomChange).toHaveBeenLastCalledWith(2);
  });

  it('一指按在手柄上开始捏合时，两指移动都参与缩放', async () => {
    const onZoomChange = vi.fn();
    const canvas = await renderMindmap(onZoomChange);
    await act(async () => (host.querySelector('.nb-mindmap-summary-label') as HTMLElement).click());
    const handle = host.querySelector('.nb-mindmap-range-handle') as HTMLElement;
    await act(async () => {
      touch(handle, 'pointerdown', 21, 100, 100, true);
      touch(canvas, 'pointerdown', 22, 200, 100, false);
      // 手柄上的手指向左移动 100：间距 100 → 200
      touch(handle, 'pointermove', 21, 0, 100, true);
    });
    expect(onZoomChange).toHaveBeenLastCalledWith(2);
  });
});
