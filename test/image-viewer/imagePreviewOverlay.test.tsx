// NoteBoard 通用图片预览浮层测试（Markdown 图片与思维导图节点图片共用）
// 回归：滚轮滚动平移、Ctrl/⌘+滚轮与触控板捏合缩放、拖动平移、触屏双指捏合，
// 事件不透传给背后的导图画布 / 编辑器；Esc 只关闭预览
// 详见 docs/09-开发路线图.md

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagePreviewOverlay } from '../../src/features/image-viewer/ImagePreviewOverlay';
import { TooltipProvider } from '../../src/components/Tooltip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 视图经 rAF 合并写入 DOM：手动推进显示帧，断言确定
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

function flushFrames() {
  act(() => {
    const pending = Array.from(frames.values());
    frames.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}

function previewEl(): HTMLElement {
  const el = document.body.querySelector('.nb-image-preview');
  if (!el) throw new Error('预览浮层未渲染');
  return el as HTMLElement;
}

function imageTransform(): string {
  return (previewEl().querySelector('img') as HTMLImageElement).style.transform;
}

/** 派发滚轮事件并推进一帧，返回事件以便断言 defaultPrevented */
function wheel(init: WheelEventInit): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  act(() => {
    previewEl().dispatchEvent(event);
  });
  flushFrames();
  return event;
}

/** jsdom 的 PointerEvent 支持不完整，用带 pointerId 的 MouseEvent 模拟 */
function pointer(type: string, x: number, y: number, pointerId = 1, target: Element = previewEl()) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  act(() => {
    target.dispatchEvent(event);
  });
}

beforeEach(() => {
  frames.clear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ImagePreviewOverlay', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();
  const parentWheel = vi.fn();
  const parentMouseDown = vi.fn();

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    onClose.mockClear();
    parentWheel.mockClear();
    parentMouseDown.mockClear();
    act(() => {
      root.render(
        <TooltipProvider>
          {/* 模拟导图画布 / 编辑器：预览是它的 React 子组件（Portal 到 body） */}
          <div onWheel={parentWheel} onMouseDown={parentMouseDown}>
            <ImagePreviewOverlay src="data:image/png;base64,AAAA" onClose={onClose} />
          </div>
        </TooltipProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('浮层挂载到 body 而不是画布内部', () => {
    expect(previewEl().parentElement).toBe(document.body);
    expect(host.contains(previewEl())).toBe(false);
  });

  it('普通滚轮滚动平移图片、拦截默认行为且不传给画布', () => {
    const event = wheel({ deltaY: 100 });
    expect(event.defaultPrevented).toBe(true);
    expect(imageTransform()).toContain('translate(0px, -100px)');
    expect(imageTransform()).toContain('scale(1)');
    expect(parentWheel).not.toHaveBeenCalled();
  });

  it('Shift+滚轮横向滚动；按行上报的增量换算为像素', () => {
    wheel({ deltaY: 40, shiftKey: true });
    expect(imageTransform()).toContain('translate(-40px, 0px)');
    wheel({ deltaY: 3, deltaMode: 1 });
    expect(imageTransform()).toContain('translate(-40px, -48px)');
  });

  it('Ctrl+滚轮缩放：鼠标一格约 1.22 倍', () => {
    const event = wheel({ deltaY: -100, ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(imageTransform()).toMatch(/scale\(1\.22/);
    expect(parentWheel).not.toHaveBeenCalled();
  });

  it('⌘+滚轮缩小；触控板捏合的小增量连续缩放', () => {
    wheel({ deltaY: 100, metaKey: true });
    expect(imageTransform()).toMatch(/scale\(0\.81/);
    wheel({ deltaY: -10, ctrlKey: true });
    // 0.8187 × e^0.1 ≈ 0.9048
    expect(imageTransform()).toMatch(/scale\(0\.90/);
  });

  it('macOS WebKit 的 gesture 捏合事件缩放图片', () => {
    const start = new Event('gesturestart', { cancelable: true });
    act(() => {
      previewEl().dispatchEvent(start);
    });
    const change = Object.assign(new Event('gesturechange', { cancelable: true }), { scale: 2, clientX: 0, clientY: 0 });
    act(() => {
      previewEl().dispatchEvent(change);
    });
    flushFrames();
    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(imageTransform()).toContain('scale(2)');
  });

  it('按住拖动平移图片，松开后不关闭', () => {
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 150, 130);
    pointer('pointerup', 150, 130);
    flushFrames();
    expect(imageTransform()).toContain('translate(50px, 30px)');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('点击空白处关闭预览', () => {
    pointer('pointerdown', 20, 20);
    pointer('pointerup', 20, 20);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('触屏双指捏合以两指中点缩放，松开后不关闭', () => {
    pointer('pointerdown', 100, 100, 1);
    pointer('pointerdown', 200, 100, 2);
    pointer('pointermove', 300, 100, 2);
    flushFrames();
    expect(imageTransform()).toContain('scale(2)');
    // jsdom 中浮层尺寸为 0，中心在原点：起点中点 (150,100) 下的像素跟随到新中点 (200,100)
    expect(imageTransform()).toContain('translate(-100px, -100px)');
    pointer('pointerup', 300, 100, 2);
    pointer('pointerup', 100, 100, 1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('按下鼠标不会触发画布的平移处理', () => {
    act(() => {
      previewEl().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    expect(parentMouseDown).not.toHaveBeenCalled();
  });

  it('Esc 关闭预览且不再传给其他快捷键监听', () => {
    const windowKeydown = vi.fn();
    window.addEventListener('keydown', windowKeydown);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    window.removeEventListener('keydown', windowKeydown);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(windowKeydown).not.toHaveBeenCalled();
  });

  it('旋转按钮顺时针旋转 90°', () => {
    act(() => {
      (document.body.querySelector('[aria-label="顺时针旋转 90°"]') as HTMLButtonElement).click();
    });
    flushFrames();
    expect(imageTransform()).toContain('rotate(90deg)');
  });

  it('单图不显示切换按钮、序号与文件操作', () => {
    expect(previewEl().querySelector('.nb-image-preview-nav')).toBeNull();
    expect(previewEl().querySelector('.nb-image-preview-counter')).toBeNull();
    expect(previewEl().querySelector('[aria-label="在独立标签页中打开"]')).toBeNull();
    expect(previewEl().querySelector('.nb-image-preview-caption')).toBeNull();
  });
});

describe('ImagePreviewOverlay 多图浏览', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onNavigate = vi.fn();
  const onDelete = vi.fn();

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    onNavigate.mockClear();
    onDelete.mockClear();
    act(() => {
      root.render(
        <TooltipProvider>
          <ImagePreviewOverlay
            src="data:image/png;base64,AAAA"
            index={0}
            count={3}
            onNavigate={onNavigate}
            onDelete={onDelete}
            onClose={() => undefined}
          />
        </TooltipProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('显示序号，← → 键与按钮首尾循环切换', () => {
    expect(document.body.querySelector('.nb-image-preview-counter')?.textContent).toBe('1 / 3');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    });
    expect(onNavigate).toHaveBeenLastCalledWith(2);
    act(() => {
      (document.body.querySelector('.nb-image-preview-nav.is-next') as HTMLButtonElement).click();
    });
    expect(onNavigate).toHaveBeenLastCalledWith(1);
  });

  it('删除按钮删除当前图片', () => {
    act(() => {
      (document.body.querySelector('[aria-label="删除这张图片"]') as HTMLButtonElement).click();
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('ImagePreviewOverlay Markdown 图片', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onOpenInTab = vi.fn();
  const onRevealInDir = vi.fn();

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <TooltipProvider>
          <ImagePreviewOverlay
            src="data:image/png;base64,AAAA"
            alt="架构图"
            onOpenInTab={onOpenInTab}
            onRevealInDir={onRevealInDir}
            onClose={() => undefined}
          />
        </TooltipProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('显示图片说明与文件操作按钮', () => {
    expect(document.body.querySelector('.nb-image-preview-caption')?.textContent).toBe('架构图');
    act(() => {
      (document.body.querySelector('[aria-label="在独立标签页中打开"]') as HTMLButtonElement).click();
      (document.body.querySelector('[aria-label="在文件夹中显示"]') as HTMLButtonElement).click();
    });
    expect(onOpenInTab).toHaveBeenCalledTimes(1);
    expect(onRevealInDir).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[aria-label="删除这张图片"]')).toBeNull();
  });
});

describe('ImagePreviewOverlay 复制图片', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onCopyImage = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    onCopyImage.mockClear();
    act(() => {
      root.render(
        <TooltipProvider>
          <ImagePreviewOverlay src="data:image/png;base64,AAAA" onCopyImage={onCopyImage} onClose={() => undefined} />
        </TooltipProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('工具栏复制按钮复制当前图片，完成后显示对勾', async () => {
    const button = document.body.querySelector('[aria-label="复制图片"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    await act(async () => {
      button.click();
    });
    expect(onCopyImage).toHaveBeenCalledTimes(1);
    expect(button.querySelector('.lucide-check')).not.toBeNull();
  });

  it('Ctrl+C 复制图片而不是背后编辑器的选区', async () => {
    const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(onCopyImage).toHaveBeenCalledTimes(1);
  });
});
