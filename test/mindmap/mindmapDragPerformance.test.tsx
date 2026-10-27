// 导图拖动回归：高频输入按帧合并，落点不变时不重绘节点，松手与取消不能遗留待绘任务。
import React, { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
import { MindmapRenderer } from '@/features/mindmap/MindmapRenderer';
import { getMindmapTheme } from '@/features/mindmap/mindmapTheme';
import type { MindNode } from '@/features/mindmap/mindmapTypes';

/** 使用独立的小树检验搬移语义，性能断言只统计移动期间的工作次数，不依赖机器速度。 */
const createTree = (): MindNode => ({
  id: 'root', text: '中心', isExpanded: true,
  children: ['a', 'b', 'c'].map((id) => ({ id, text: `节点 ${id}`, isExpanded: true, children: [] })),
});

describe('导图拖动按帧更新', () => {
  let host: HTMLDivElement;
  let root: Root;
  let canvas: HTMLElement;
  let frameId: number;
  let mounted: boolean;
  const frames = new Map<number, FrameRequestCallback>();
  const onChange = vi.fn<(tree: MindNode) => void>();
  const onRender = vi.fn();

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onChange.mockClear();
    onRender.mockClear();
    frames.clear();
    frameId = 0;
    mounted = true;
    // 手动推进显示帧，确定性覆盖「移动已到达、浏览器尚未绘制」的边界。
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(768);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const theme = getMindmapTheme();
    await act(async () => root.render(
      <Profiler id="mindmap" onRender={onRender}>
        <MindmapRenderer root={createTree()} onChange={onChange} zoom={1} onZoomChange={() => {}} layout="right"
          theme={theme} edgeStyle={theme.edgeStyle} maxNodeWidth={300} defaultTextAlign="left" defaultImageFit="original" />
      </Profiler>,
    ));
    canvas = host.firstElementChild as HTMLElement;
    await nextFrame();
  });

  afterEach(async () => {
    if (mounted) await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** 只消费当前帧任务；执行过程中请求的新帧留给下一轮。 */
  const nextFrame = async () => {
    await act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(performance.now()));
    });
  };

  const node = (id: string) => host.querySelector(`[data-node-id="${id}"]`) as HTMLElement;

  /** jsdom 不计算绝对定位，将实际节点布局加上画布初始平移，得到点击中心。 */
  const point = (id: string) => {
    const style = node(id).style;
    return { x: 80 + parseFloat(style.left) + parseFloat(style.width) / 2, y: 160 + parseFloat(style.top) + parseFloat(style.height) / 2 };
  };

  const pointer = (target: Element, type: string, position: { x: number; y: number }, pointerId = 1) => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', button: 0, clientX: position.x, clientY: position.y,
    }));
  };

  const startDrag = async () => {
    await act(async () => {
      pointer(node('a'), 'pointerdown', point('a'));
      pointer(canvas, 'pointermove', point('b'));
    });
    await nextFrame();
  };

  it('触控板同一帧多次平移只写一次变换，且累加全部增量', async () => {
    const layer = host.querySelector('.nb-mindmap-transform') as HTMLElement;
    const initial = layer.style.transform;
    const transform = vi.spyOn(layer.style, 'transform', 'set');
    await act(async () => {
      for (let i = 0; i < 20; i += 1) canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 1, deltaY: 2 }));
    });
    expect(layer.style.transform).toBe(initial);
    expect(transform).not.toHaveBeenCalled();
    await nextFrame();
    expect(transform).toHaveBeenCalledTimes(1);
    // 只检查实际位移，允许浮点累加在不同运行时产生末位误差。
    const [x, y] = layer.style.transform.match(/\(([^)]+)\)/)![1].split(',').map(parseFloat);
    expect(x).toBeCloseTo(64);
    expect(y).toBeCloseTo(128);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('同一落点内高频移动只计算一次，后续各帧移动不重绘节点', async () => {
    await startDrag();
    const rect = vi.spyOn(canvas, 'getBoundingClientRect');
    onRender.mockClear();
    const target = point('b');
    await act(async () => {
      for (let i = 0; i < 20; i += 1) pointer(canvas, 'pointermove', { x: target.x + i / 10, y: target.y });
    });
    expect(rect).not.toHaveBeenCalled();
    await nextFrame();
    expect(rect).toHaveBeenCalledTimes(1);
    expect(onRender).not.toHaveBeenCalled();
    const preview = host.querySelector('.nb-mindmap-drag-preview') as HTMLElement;
    expect(preview.style.transform).toContain(`${target.x + 1.9 + 14}px`);
    for (let i = 0; i < 5; i += 1) {
      await act(async () => pointer(canvas, 'pointermove', { x: target.x + i / 10, y: target.y }));
      await nextFrame();
    }
    expect(onRender).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('松手前最后一个移动尚未绘制时，仍提交最新落点', async () => {
    await startDrag();
    await act(async () => {
      pointer(canvas, 'pointermove', point('c'));
      pointer(canvas, 'pointerup', point('c'));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.lastCall![0].children.find((child) => child.id === 'c')!.children.map((child) => child.id)).toEqual(['a']);
    await nextFrame();
    expect(host.querySelector('.nb-mindmap-drag-preview')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('按下和松手之间没有显示帧时也能完成节点搬移', async () => {
    await act(async () => {
      pointer(node('a'), 'pointerdown', point('a'));
      pointer(canvas, 'pointermove', point('b'));
      pointer(canvas, 'pointerup', point('b'));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.lastCall![0].children.find((child) => child.id === 'b')!.children[0].id).toBe('a');
    await nextFrame();
    expect(host.querySelector('.nb-mindmap-drag-preview')).toBeNull();
  });

  it.each(['Escape', 'pointercancel'])('%s 取消时丢弃待绘移动，不提交树结构', async (reason) => {
    await startDrag();
    await act(async () => {
      pointer(canvas, 'pointermove', point('c'));
      if (reason === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      else pointer(canvas, 'pointercancel', point('c'));
    });
    await nextFrame();
    expect(host.querySelector('.nb-mindmap-drag-preview')).toBeNull();
    expect(document.body.style.cursor).toBe('default');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('其他指针的移动和松手不覆盖正在拖动的落点', async () => {
    await startDrag();
    await act(async () => {
      pointer(canvas, 'pointermove', point('c'), 2);
      pointer(canvas, 'pointerup', point('c'), 2);
    });
    await nextFrame();
    expect(onChange).not.toHaveBeenCalled();
    expect(host.querySelector('.nb-mindmap-drag-preview')).not.toBeNull();
    await act(async () => pointer(canvas, 'pointerup', point('b')));
    expect(onChange.mock.lastCall![0].children.find((child) => child.id === 'b')!.children[0].id).toBe('a');
  });

  it('多选搬移仍一次提交，并保留原有节点顺序', async () => {
    // 两次点击之间完成一次渲染，匹配真实用户先单选、再按修饰键追加选择的事件顺序。
    await act(async () => node('a').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      node('b').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, metaKey: true }));
    });
    await act(async () => {
      pointer(node('a'), 'pointerdown', point('a'));
      pointer(canvas, 'pointermove', point('c'));
    });
    await nextFrame();
    await act(async () => pointer(canvas, 'pointerup', point('c')));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.lastCall![0].children.find((child) => child.id === 'c')!.children.map((child) => child.id)).toEqual(['a', 'b']);
  });

  it('第二个触点开始捏合时取消尚未绘制的节点拖动', async () => {
    const start = point('a');
    await act(async () => {
      node('a').dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerType: 'touch', pointerId: 11, isPrimary: true, button: 0, clientX: start.x, clientY: start.y,
      }));
      pointer(canvas, 'pointermove', point('b'), 11);
      canvas.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerType: 'touch', pointerId: 12, isPrimary: false, button: 0, clientX: start.x + 100, clientY: start.y,
      }));
    });
    await nextFrame();
    expect(host.querySelector('.nb-mindmap-drag-preview')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('卸载时取消尚未绘制的拖动帧并复位光标', async () => {
    await startDrag();
    await act(async () => {
      pointer(canvas, 'pointermove', point('c'));
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 1 }));
    });
    expect(frames.size).toBeGreaterThan(0);
    await act(async () => root.unmount());
    mounted = false;
    expect(frames.size).toBe(0);
    expect(document.body.style.cursor).toBe('default');
    expect(onChange).not.toHaveBeenCalled();
  });
});
