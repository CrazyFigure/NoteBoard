// 标签栏滚动回归：使用真实组件与窗口状态，模拟 jsdom 缺少的横向布局尺寸。
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabBar } from '@/components/titlebar/TabBar';
import { useWindowStore, type Tab } from '@/stores/windowStore';

// 隔离文件操作和原生拖放，保留真实标签渲染、排序及激活状态订阅。
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/features/welcome/welcomeActions', () => ({
  openFileDialog: vi.fn(), openFolderDialog: vi.fn(), openStagingArea: vi.fn(), openSyncFolder: vi.fn(),
  newMarkdown: vi.fn(), newMindmap: vi.fn(), newDrawio: vi.fn(), newBitable: vi.fn(),
  newBoard: vi.fn(), newMermaid: vi.fn(), newPlantUml: vi.fn(), newInfographic: vi.fn(),
  newJson: vi.fn(), newSql: vi.fn(), newText: vi.fn(), newTextDiff: vi.fn(),
}));
vi.mock('@/features/editor-code/orchestration/saveDocument', () => ({ saveDocument: vi.fn(), saveAs: vi.fn() }));
vi.mock('@/features/window/windowManager', () => ({ moveToNewWindow: vi.fn() }));
vi.mock('@/features/window/TabDropOverlay', () => ({ TabDropOverlay: () => null }));
vi.mock('@/features/window/tabDragFeedback', () => ({
  useArrivingTabKey: () => null, useNativeDraggedTabKey: () => null,
}));

/** 构造含选择器特殊字符的路径，确保定位不依赖把文件路径拼入 CSS 选择器。 */
function makeTab(index: number): Tab {
  const key = `C:\\notes\\[${index}]'文档.md`;
  return {
    key, displayName: `文档${index}.md`, path: key, kind: 'markdown', language: 'markdown',
    isDirty: false, isPreview: false, viewMode: 'visual', externalStatus: 'clean', isDetached: false,
  };
}

/** 生成浏览器布局矩形；纵向坐标故意偏离原点，验证只修改横向滚动。 */
function rect(left: number, width: number): DOMRect {
  return { x: left, y: 24, left, right: left + width, top: 24, bottom: 52, width, height: 28, toJSON() {} };
}

describe('激活标签自动横向定位', () => {
  let host: HTMLDivElement;
  let root: Root;
  let viewportWidth: number;
  let resizeCallback: () => void;
  let disconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    viewportWidth = 250;
    disconnect = vi.fn();
    // 保留尺寸变化回调，允许模拟桌面分屏及设备转向后的容器宽度变化。
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resizeCallback = callback; }
      observe() { /* 由用例显式触发尺寸变化。 */ }
      disconnect = disconnect;
    });
    const getRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'tablist') return rect(40, viewportWidth);
      if (this.dataset.tabKey) {
        const index = useWindowStore.getState().tabs.findIndex((tab) => tab.key === this.dataset.tabKey);
        const bar = this.closest<HTMLElement>('[role="tablist"]')!;
        // 每项宽 100px，以实际 scrollLeft 计算屏幕位置，覆盖双向滚动及重复调用。
        return rect(40 + index * 100 - bar.scrollLeft, 100);
      }
      return getRect.call(this);
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tablist' ? viewportWidth : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tablist' ? useWindowStore.getState().tabs.length * 100 : 0;
    });
    useWindowStore.setState({ tabs: [], activeKey: null });
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

  /** 挂载已打开的标签，返回唯一可滚动区域，方便检查焦点与纵向位置。 */
  async function mount(activeIndex = 0) {
    const tabs = Array.from({ length: 6 }, (_, index) => makeTab(index));
    useWindowStore.setState({ tabs, activeKey: tabs[activeIndex].key });
    await act(async () => root.render(<TabBar />));
    return host.querySelector<HTMLElement>('[role="tablist"]')!;
  }

  it('新文件追加到右侧后完整显示，并立即更新自绘滑块，不移动焦点或纵向位置', async () => {
    const bar = await mount();
    const thumb = host.querySelector<HTMLElement>('[aria-hidden="true"] > div')!;
    const originalTransform = thumb.style.transform;
    const input = document.createElement('input');
    host.appendChild(input);
    input.focus();
    bar.scrollTop = 12;
    await act(async () => useWindowStore.getState().openTab(makeTab(6)));
    expect(bar.scrollLeft).toBe(450);
    expect(bar.scrollTop).toBe(12);
    expect(document.activeElement).toBe(input);
    expect(thumb.style.transform).not.toBe(originalTransform);
  });

  it('重新打开已有文件时向左定位，完全可见的标签切换保持原滚动位置', async () => {
    const bar = await mount(5);
    expect(bar.scrollLeft).toBe(350);
    await act(async () => useWindowStore.getState().openTab(makeTab(0)));
    expect(bar.scrollLeft).toBe(0);
    await act(async () => useWindowStore.getState().activateTab(makeTab(1).key));
    expect(bar.scrollLeft).toBe(0);
  });

  it('预览替换及重新排序后按新位置定位，不要求标签数量增加', async () => {
    const bar = await mount();
    const replacement = makeTab(9);
    await act(async () => {
      useWindowStore.setState((state) => ({ tabs: [...state.tabs.slice(0, -1), replacement], activeKey: replacement.key }));
    });
    expect(bar.scrollLeft).toBe(350);
    await act(async () => useWindowStore.getState().reorderTabs(5, 0));
    expect(bar.scrollLeft).toBe(0);
  });

  it('手动浏览后更新保存状态不会拉回激活标签，返回主页也不改变滚动位置', async () => {
    const bar = await mount();
    bar.scrollLeft = 300;
    await act(async () => useWindowStore.getState().setTabDirty(makeTab(0).key, true));
    expect(bar.scrollLeft).toBe(300);
    await act(async () => useWindowStore.setState({ activeKey: null }));
    expect(bar.scrollLeft).toBe(300);
  });

  it('容器缩窄后补足裁切量，单个标签宽于容器时稳定展示起点，并清理观察器', async () => {
    const bar = await mount(5);
    viewportWidth = 150;
    await act(async () => resizeCallback());
    expect(bar.scrollLeft).toBe(450);
    viewportWidth = 60;
    await act(async () => resizeCallback());
    expect(bar.scrollLeft).toBe(500);
    await act(async () => resizeCallback());
    expect(bar.scrollLeft).toBe(500);
    await act(async () => root.unmount());
    expect(disconnect).toHaveBeenCalled();
  });

  it('旧版 WebView 缺少 ResizeObserver 时仍通过窗口尺寸变化重新定位', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const bar = await mount(5);
    viewportWidth = 150;
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(bar.scrollLeft).toBe(450);
  });
});
