// Issue #40：SVG 必须具有真实视口，并保持 SVG 世界坐标与 HTML 节点坐标一致。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
import { MindmapRenderer } from '@/features/mindmap/MindmapRenderer';
import { getMindmapTheme } from '@/features/mindmap/mindmapTheme';
import type { MindmapLayout, MindNode } from '@/features/mindmap/mindmapTypes';

const tree: MindNode = {
  id: 'root', text: '中心', isExpanded: true,
  relations: [{ id: 'relation', targetId: 'a' }],
  children: ['a', 'b'].map((id) => ({ id, text: `节点 ${id}`, isExpanded: true, children: [] })),
};

describe('导图 SVG 视口与节点对齐', () => {
  let host: HTMLDivElement;
  let root: Root;
  let size: { width: number; height: number };
  let observers: ResizeObserverCallback[];
  const frames = new Map<number, FrameRequestCallback>();
  let frameId: number;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    size = { width: 1024, height: 768 };
    observers = [];
    frames.clear();
    frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
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

  /** 检查浏览器的 viewBox 映射：单位比例为 1，原点偏移抵消，且真实 SVG 覆盖整个画布。 */
  const expectAligned = (zoom: number, count = 2) => {
    const layer = host.querySelector('.nb-mindmap-transform') as HTMLElement;
    const [panX, panY] = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(layer.style.transform)!.slice(1).map(Number);
    const svgs = layer.querySelectorAll<SVGSVGElement>(':scope > svg');
    expect(svgs).toHaveLength(count);
    for (const svg of svgs) {
      const [x, y, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
      expect(width * zoom).toBeGreaterThanOrEqual(size.width);
      expect(height * zoom).toBeGreaterThanOrEqual(size.height);
      expect(parseFloat(svg.style.width) / width).toBeCloseTo(1);
      expect(parseFloat(svg.style.height) / height).toBeCloseTo(1);
      expect(parseFloat(svg.style.left) - x).toBeCloseTo(0);
      expect(parseFloat(svg.style.top) - y).toBeCloseTo(0);
      expect(x * zoom + panX).toBeLessThanOrEqual(0);
      expect(y * zoom + panY).toBeLessThanOrEqual(0);
      expect((x + width) * zoom + panX).toBeGreaterThanOrEqual(size.width);
      expect((y + height) * zoom + panY).toBeGreaterThanOrEqual(size.height);
      // 整层不可吞掉节点或画布的输入；只有已有的线条命中区可交互。
      expect(svg.style.pointerEvents).toBe('none');
    }
  };

  it.each<MindmapLayout>(['left', 'tree-up', 'balanced'])('%s 负坐标布局在缩放后仍保持一对一坐标映射', async (layout) => {
    for (const zoom of [0.25, 1, 2]) {
      await render(layout, zoom);
      expectAligned(zoom);
    }
  });

  it('画布从隐藏到显示及横竖屏尺寸变化时更新真实视口', async () => {
    for (const nextSize of [{ width: 0, height: 0 }, { width: 1728, height: 1080 }, { width: 1080, height: 1728 }]) {
      size = nextSize;
      await render('balanced');
      await act(async () => observers.forEach((callback) => callback([], {} as ResizeObserver)));
      expectAligned(1);
    }
  });

  it('连续平移跨过缓冲区后重新定位 SVG，保持连线坐标不变', async () => {
    await render('balanced');
    const path = host.querySelector('.nb-mindmap-relation-line')!.getAttribute('d');
    for (const deltaX of [80, 800, -1600]) {
      await act(async () => host.firstElementChild!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX })));
      await act(async () => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(performance.now()));
      });
      expectAligned(1);
      expect(host.querySelector('.nb-mindmap-relation-line')!.getAttribute('d')).toBe(path);
    }
  });

  it('联系线仍可选中，控制点引导线使用相同视口', async () => {
    await render('left');
    const hitArea = host.querySelector<SVGPathElement>('.nb-mindmap-relation [data-mindmap-structure]')!;
    expect(hitArea.style.pointerEvents).toBe('stroke');
    await act(async () => hitArea.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host.querySelectorAll('.nb-mindmap-bend-handle')).toHaveLength(2);
    expectAligned(1, 3);
  });
});
