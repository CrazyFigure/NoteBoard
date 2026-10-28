// 导图首次显示居中：首帧即居中（不先停在默认偏移再跳动），画布尺寸为 0 时等测得尺寸后再居中。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
import { MindmapRenderer } from '@/features/mindmap/MindmapRenderer';
import { getMindmapTheme } from '@/features/mindmap/mindmapTheme';
import type { MindmapLayout, MindNode } from '@/features/mindmap/mindmapTypes';

const tree: MindNode = {
  id: 'root', text: '中心', isExpanded: true,
  children: ['a', 'b', 'c', 'd'].map((id) => ({ id, text: `节点 ${id}`, isExpanded: true, children: [] })),
};

describe('导图首次显示居中', () => {
  let host: HTMLDivElement;
  let root: Root;
  let size = { width: 1024, height: 768 };
  let observers: ResizeObserverCallback[] = [];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    size = { width: 1024, height: 768 };
    observers = [];
    // 帧任务不执行：断言的就是首帧（未经逐帧合并）时的位置
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { observers.push(callback); }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => size.width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => size.height);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const render = (layout: MindmapLayout, zoom = 1) => {
    const theme = getMindmapTheme();
    return act(async () => root.render(
      <MindmapRenderer root={tree} onChange={() => {}} zoom={zoom} onZoomChange={() => {}} layout={layout}
        theme={theme} edgeStyle={theme.edgeStyle} maxNodeWidth={300} defaultTextAlign="left" defaultImageFit="original" />,
    ));
  };

  /** 由节点样式与图层平移算出全部节点外接矩形在屏幕上的中心 */
  const screenCenter = (zoom = 1) => {
    const layer = host.querySelector('.nb-mindmap-transform') as HTMLElement;
    const [panX, panY] = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(layer.style.transform)!.slice(1).map(Number);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    host.querySelectorAll<HTMLElement>('[data-node-id]').forEach((el) => {
      const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x + parseFloat(el.style.width)); bottom = Math.max(bottom, y + parseFloat(el.style.height));
    });
    return { x: panX + ((left + right) / 2) * zoom, y: panY + ((top + bottom) / 2) * zoom };
  };

  it.each<MindmapLayout>(['balanced', 'right'])('%s 布局首帧即位于画布中央', async (layout) => {
    await render(layout);
    const center = screenCenter();
    expect(center.x).toBeCloseTo(512, 0);
    expect(center.y).toBeCloseTo(384, 0);
  });

  it('画布尺寸为 0 时不居中，测得尺寸后再居中', async () => {
    size = { width: 0, height: 0 };
    await render('balanced');
    size = { width: 800, height: 600 };
    await act(async () => observers.forEach((callback) => callback([], {} as ResizeObserver)));
    const center = screenCenter();
    expect(center.x).toBeCloseTo(400, 0);
    expect(center.y).toBeCloseTo(300, 0);
  });

  it('未移动视图时恢复缩放后仍保持居中', async () => {
    await render('balanced');
    await render('balanced', 0.5);
    const center = screenCenter(0.5);
    expect(center.x).toBeCloseTo(512, 0);
    expect(center.y).toBeCloseTo(384, 0);
  });
});
