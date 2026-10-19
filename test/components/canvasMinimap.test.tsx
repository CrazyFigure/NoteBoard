// NoteBoard 画布缩略图回归测试
// 验证显隐记忆、按视野占比自动出现、隐藏时不作画，以及点选缩略图时导航中心被限制在内容范围内。

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../src/components/Tooltip';
import { CanvasMinimap, type MinimapScene } from '../../src/components/minimap/CanvasMinimap';

const STORAGE_KEY = 'nb-minimap-visible:test';

/** 内容为 1000×500 的场景：面板 120×150，内容缩放 0.104、偏移 (8, 49) */
const scene: MinimapScene = {
  bounds: { left: 0, top: 0, width: 1000, height: 500 },
  paint: () => undefined,
};

/** 视野 200×100 只看到内容的 4%，缩略图应出现 */
const smallViewport = () => ({ left: 0, top: 0, width: 200, height: 100 });

describe('CanvasMinimap', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // jsdom 没有 Canvas 实现，返回空上下文即可跳过实际作画
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: () => undefined,
      clearRect: () => undefined,
    } as unknown as CanvasRenderingContext2D);
    // rAF 同步执行，绘制在 act 内完成
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    window.localStorage.removeItem(STORAGE_KEY);
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

  const render = async (props: Partial<ComponentProps<typeof CanvasMinimap>> = {}) => {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <CanvasMinimap
            storageKey={STORAGE_KEY}
            getScene={() => scene}
            getViewport={smallViewport}
            onNavigate={() => undefined}
            {...props}
          />
        </TooltipProvider>,
      );
    });
  };

  it('收起后记住状态，隐藏时不作画', async () => {
    const paint = vi.fn();
    const getScene = vi.fn(() => ({ ...scene, paint }));
    await render({ getScene });
    expect(paint).toHaveBeenCalled();
    expect(host.querySelector('.nb-minimap')?.getAttribute('data-idle')).toBeNull();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="隐藏缩略图"]')!.click();
    });
    expect(host.querySelector('.nb-minimap')).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('0');

    // 重新挂载后保持收起，只算边界不作画
    await act(async () => root.unmount());
    root = createRoot(host);
    paint.mockClear();
    await render({ getScene });
    expect(host.querySelector('[aria-label="显示缩略图"]')).not.toBeNull();
    expect(paint).not.toHaveBeenCalled();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="显示缩略图"]')!.click();
    });
    expect(host.querySelector('.nb-minimap')).not.toBeNull();
    expect(paint).toHaveBeenCalled();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1');
  });

  it('视野能看到大部分内容时不出现，收起把手也不出现', async () => {
    const paint = vi.fn();
    // 视野 600×300：面积 36% 高于 1/3，宽高各 60% 也高于 1/2，不出现
    await render({ getScene: () => ({ ...scene, paint }), getViewport: () => ({ left: 0, top: 0, width: 600, height: 300 }) });
    expect(host.querySelector('.nb-minimap')?.getAttribute('data-idle')).toBe('true');
    expect(paint).not.toHaveBeenCalled();

    window.localStorage.setItem(STORAGE_KEY, '0');
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ getViewport: () => ({ left: 0, top: 0, width: 600, height: 300 }) });
    expect(host.querySelector('[aria-label="显示缩略图"]')).toBeNull();
  });

  it('宽度能看全但高度只看到一半以下时出现', async () => {
    // 视野 1000×240：宽 100%、高 48%，面积 48% 虽高于 1/3，但高度方向已不足一半
    await render({ getViewport: () => ({ left: 0, top: 0, width: 1000, height: 240 }) });
    expect(host.querySelector('.nb-minimap')?.getAttribute('data-idle')).toBeNull();
  });

  it('视野尺寸够大但偏到空白处时按实际看到的内容出现', async () => {
    // 视野与内容同样大，但右移 700 后只重叠 300×500：宽度方向只看到 30%
    await render({ getViewport: () => ({ left: 700, top: 0, width: 1000, height: 500 }) });
    expect(host.querySelector('.nb-minimap')?.getAttribute('data-idle')).toBeNull();
  });

  it('点选空白边缘时导航中心限制在内容范围内', async () => {
    const onNavigate = vi.fn();
    await render({ onNavigate });
    const panel = host.querySelector<HTMLDivElement>('.nb-minimap')!;
    panel.getBoundingClientRect = () => ({ left: 0, top: 0, right: 120, bottom: 150, width: 120, height: 150, x: 0, y: 0, toJSON: () => ({}) });
    panel.setPointerCapture = () => undefined;

    // 面板右下角像素 (119, 149) 落在内容外，应被夹到内容右下角
    await act(async () => {
      const event = new MouseEvent('pointerdown', { bubbles: true, clientX: 119, clientY: 149, button: 0 });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      panel.dispatchEvent(event);
    });
    expect(onNavigate).toHaveBeenCalledWith(1000, 500);
  });
});
