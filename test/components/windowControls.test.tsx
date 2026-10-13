// NoteBoard 窗口控制按钮回归测试
// 使用真实 Tooltip，验证最小化前释放触发按钮焦点，避免窗口恢复时再次打开提示。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../src/components/Tooltip';
import { WindowControls } from '../../src/components/titlebar/WindowControls';

// 仅替换原生窗口接口，保留按钮与 Radix Tooltip 的真实交互流程。
const windowApi = vi.hoisted(() => ({
  isMaximized: vi.fn(),
  onResized: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowApi }));
vi.mock('../../src/features/window/windowManager', () => ({
  requestCurrentWindowClose: vi.fn(),
}));

// jsdom 不提供布局观察，空实现足以支持 Tooltip 内容挂载与卸载。
class ResizeObserverStub {
  observe() { /* 测试不依赖布局尺寸。 */ }
  unobserve() { /* 测试不依赖布局尺寸。 */ }
  disconnect() { /* 无实际观察资源需要释放。 */ }
}

/** 模拟鼠标指针事件；显式提供 pointerType，保留 Radix 的鼠标/触屏分支。 */
function dispatchPointer(target: HTMLElement, type: string) {
  // React 根据冒泡的 pointerout 合成 onPointerLeave，原生 pointerleave 不会触发该回调。
  const nativeType = type === 'pointerleave' ? 'pointerout' : type;
  const event = new MouseEvent(nativeType, { bubbles: true, clientX: 10, clientY: 10 });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  target.dispatchEvent(event);
}

describe('窗口最小化 Tooltip', () => {
  let host: HTMLDivElement;
  let root: Root;
  let button: HTMLButtonElement;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    windowApi.isMaximized.mockResolvedValue(false);
    windowApi.onResized.mockResolvedValue(() => undefined);
    windowApi.minimize.mockReset().mockResolvedValue(undefined);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<TooltipProvider><WindowControls /></TooltipProvider>);
    });
    button = host.querySelector<HTMLButtonElement>('[aria-label="最小化"]')!;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** 显示悬停提示后完成鼠标按下、聚焦及松开，不额外模拟鼠标离开。 */
  async function hoverAndPress() {
    await act(async () => {
      dispatchPointer(button, 'pointermove');
      vi.advanceTimersByTime(110);
    });
    expect(button.getAttribute('data-state')).toBe('delayed-open');
    await act(async () => {
      dispatchPointer(button, 'pointerdown');
      button.focus();
      dispatchPointer(button, 'pointerup');
    });
    expect(document.activeElement).toBe(button);
  }

  it('调用最小化之前释放按钮焦点，恢复窗口后不重新显示 Tooltip', async () => {
    await hoverAndPress();
    let focusAtMinimize: Element | null = null;
    windowApi.minimize.mockImplementation(() => {
      focusAtMinimize = document.activeElement;
      return Promise.resolve();
    });
    await act(async () => {
      button.click();
      window.dispatchEvent(new Event('blur'));
    });
    expect(windowApi.minimize).toHaveBeenCalledTimes(1);
    // 模拟窗口恢复时对原焦点元素发送 focusin；已释放焦点时只能恢复到 body。
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      focusAtMinimize?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      vi.advanceTimersByTime(110);
    });
    expect(button.getAttribute('data-state')).toBe('closed');
    expect(focusAtMinimize).not.toBe(button);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('快速点击仍取消悬停延迟，重新悬停和键盘聚焦仍可显示提示', async () => {
    await act(async () => {
      dispatchPointer(button, 'pointermove');
      dispatchPointer(button, 'pointerdown');
      button.focus();
      dispatchPointer(button, 'pointerup');
      button.click();
      vi.advanceTimersByTime(110);
    });
    expect(button.getAttribute('data-state')).toBe('closed');
    await act(async () => {
      dispatchPointer(button, 'pointerleave');
      dispatchPointer(button, 'pointermove');
      vi.advanceTimersByTime(110);
    });
    expect(button.getAttribute('data-state')).not.toBe('closed');
    // 分开提交鼠标离开与键盘聚焦，确保先完成悬停提示的关闭状态更新。
    await act(async () => {
      dispatchPointer(button, 'pointerleave');
    });
    expect(button.getAttribute('data-state')).toBe('closed');
    await act(async () => {
      button.focus();
    });
    expect(button.getAttribute('data-state')).toBe('instant-open');
  });
});
