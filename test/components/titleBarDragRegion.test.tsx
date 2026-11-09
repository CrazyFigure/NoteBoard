// 标题栏双击回归：Tauri 已处理拖拽区域的缩放，React 不能再次切换导致窗口回弹。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TitleBarDragRegion } from '../../src/components/titlebar/TitleBarDragRegion';
import { useLayoutStore } from '../../src/stores/layoutStore';
import { on, off } from '../../src/core/emitter';

// 保留真实组件和布局状态，只替换原生窗口接口与极窄模式 IPC。
const windowApi = vi.hoisted(() => ({ toggleMaximize: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowApi }));
vi.mock('../../src/core/ipc/commands', () => ({
  beginDockDrag: vi.fn(async () => {}),
  endDockDrag: vi.fn(async () => {}),
}));

describe('标题栏拖拽区域双击', () => {
  let host: HTMLDivElement;
  let root: Root;
  let platform: 'macos' | 'windows' | 'linux';
  let maximized: boolean;
  let downPosition: { x: number; y: number } | null;
  let nativeToggle: ReturnType<typeof vi.fn>;

  /** 模拟 Tauri 2.11.5 drag.js 的缩放入口，macOS 在原位置松开后执行，其余桌面平台在第二次按下时执行。 */
  function handleNativeMouse(event: MouseEvent) {
    if (event.button !== 0 || event.detail !== 2
      || !(event.target instanceof HTMLElement)
      || !event.target.hasAttribute('data-tauri-drag-region')) return;
    if (event.type === 'mousedown') {
      downPosition = { x: event.clientX, y: event.clientY };
      if (platform !== 'macos') nativeToggle();
    } else if (platform === 'macos' && downPosition?.x === event.clientX && downPosition.y === event.clientY) {
      nativeToggle();
    }
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    platform = 'macos';
    maximized = false;
    downPosition = null;
    nativeToggle = vi.fn(() => { maximized = !maximized; });
    windowApi.toggleMaximize.mockReset().mockImplementation(async () => { maximized = !maximized; });
    useLayoutStore.setState({ compactMode: false, activeMenuCount: 0 });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    document.addEventListener('mousedown', handleNativeMouse);
    document.addEventListener('mouseup', handleNativeMouse);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.removeEventListener('mousedown', handleNativeMouse);
    document.removeEventListener('mouseup', handleNativeMouse);
    useLayoutStore.setState({ compactMode: false, activeMenuCount: 0 });
    vi.unstubAllGlobals();
  });

  /** 两种占位区域共用双击流程，固定宽度用于覆盖 macOS 红绿灯旁的拖拽区域。 */
  function renderRegion(width?: number) {
    act(() => root.render(<TitleBarDragRegion width={width} />));
    return host.firstElementChild as HTMLDivElement;
  }

  /** 按真实事件顺序派发双击，保留第二次 mouseup 后紧跟的 React dblclick。 */
  function doubleClick(region: HTMLElement, releaseX = 10) {
    act(() => {
      for (const detail of [1, 2]) {
        region.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail, clientX: 10, clientY: 10 }));
        region.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, detail, clientX: releaseX, clientY: 10 }));
        region.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail, clientX: releaseX, clientY: 10 }));
      }
      region.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0, detail: 2, clientX: releaseX, clientY: 10 }));
    });
  }

  it.each(['macos', 'windows', 'linux'] as const)('%s 每次双击只切换一次，能最大化并还原', (target) => {
    platform = target;
    const region = renderRegion();
    expect(region.hasAttribute('data-tauri-drag-region')).toBe(true);

    doubleClick(region);
    expect(maximized).toBe(true);
    expect(nativeToggle).toHaveBeenCalledTimes(1);
    expect(windowApi.toggleMaximize).not.toHaveBeenCalled();

    doubleClick(region);
    expect(maximized).toBe(false);
    expect(nativeToggle).toHaveBeenCalledTimes(2);
    expect(windowApi.toggleMaximize).not.toHaveBeenCalled();
  });

  it('macOS 红绿灯占位区同样只由 Tauri 切换一次', () => {
    doubleClick(renderRegion(76));
    expect(maximized).toBe(true);
    expect(nativeToggle).toHaveBeenCalledTimes(1);
    expect(windowApi.toggleMaximize).not.toHaveBeenCalled();
  });

  it('macOS 第二次按下后移动鼠标会取消缩放，React 不补发切换', () => {
    doubleClick(renderRegion(), 12);
    expect(maximized).toBe(false);
    expect(nativeToggle).not.toHaveBeenCalled();
    expect(windowApi.toggleMaximize).not.toHaveBeenCalled();
  });

  it('极窄模式不挂原生拖拽属性，双击也不突破尺寸限制', () => {
    useLayoutStore.setState({ compactMode: true });
    const region = renderRegion();
    expect(region.hasAttribute('data-tauri-drag-region')).toBe(false);
    doubleClick(region);
    expect(nativeToggle).not.toHaveBeenCalled();
    expect(windowApi.toggleMaximize).not.toHaveBeenCalled();
  });

  it('菜单打开时双击只请求关闭菜单', () => {
    useLayoutStore.setState({ activeMenuCount: 1 });
    const closeMenus = vi.fn();
    on('close-titlebar-menus', closeMenus);
    try {
      const region = renderRegion();
      expect(region.hasAttribute('data-tauri-drag-region')).toBe(false);
      doubleClick(region);
      expect(closeMenus).toHaveBeenCalled();
      expect(nativeToggle).not.toHaveBeenCalled();
      expect(windowApi.toggleMaximize).not.toHaveBeenCalled();
    } finally {
      off('close-titlebar-menus', closeMenus);
    }
  });
});
