// NoteBoard 思维导图图片预览浮层测试
// 回归：放大预览时滚轮 / Ctrl+滚轮应缩放图片，而不是透传给背后的导图画布；Esc 只关闭预览
// 详见 docs/09-开发路线图.md

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MindmapImagePreview } from '../../src/features/mindmap/MindmapImagePreview';
import { TooltipProvider } from '../../src/components/Tooltip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('MindmapImagePreview', () => {
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
          {/* 模拟导图画布：预览是它的 React 子组件（Portal 到 body） */}
          <div onWheel={parentWheel} onMouseDown={parentMouseDown}>
            <MindmapImagePreview src="data:image/png;base64,AAAA" onClose={onClose} />
          </div>
        </TooltipProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function previewEl(): HTMLElement {
    const el = document.body.querySelector('.nb-image-preview');
    if (!el) throw new Error('预览浮层未渲染');
    return el as HTMLElement;
  }

  function imageTransform(): string {
    return (previewEl().querySelector('img') as HTMLImageElement).style.transform;
  }

  it('浮层挂载到 body 而不是画布内部', () => {
    expect(previewEl().parentElement).toBe(document.body);
    expect(host.contains(previewEl())).toBe(false);
  });

  it('滚轮缩放图片、拦截默认行为且不传给画布', () => {
    const before = imageTransform();
    const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    act(() => {
      previewEl().dispatchEvent(wheel);
    });
    expect(wheel.defaultPrevented).toBe(true);
    expect(imageTransform()).not.toBe(before);
    expect(imageTransform()).toContain('scale(1.2)');
    expect(parentWheel).not.toHaveBeenCalled();
  });

  it('Ctrl+滚轮同样缩放图片', () => {
    const wheel = new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      previewEl().dispatchEvent(wheel);
    });
    expect(wheel.defaultPrevented).toBe(true);
    expect(imageTransform()).toMatch(/scale\(0\.83/);
    expect(parentWheel).not.toHaveBeenCalled();
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
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    window.removeEventListener('keydown', windowKeydown);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(windowKeydown).not.toHaveBeenCalled();
  });

  it('单图不显示切换按钮与序号', () => {
    expect(previewEl().querySelector('.nb-image-preview-nav')).toBeNull();
    expect(previewEl().querySelector('.nb-image-preview-counter')).toBeNull();
  });
});

describe('MindmapImagePreview 多图浏览', () => {
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
          <MindmapImagePreview
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
