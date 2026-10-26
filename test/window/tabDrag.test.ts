// 验证原生结果路由与真实 DOM 标签几何；不把这里的模拟当成系统拖放实测。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main' }) }));
vi.mock('@/core/ipc/commands', () => ({ startTabDrag: vi.fn() }));
vi.mock('@/features/window/windowManager', () => ({ moveTabToWindow: vi.fn().mockResolvedValue(true) }));
import * as ipc from '@/core/ipc/commands';
import { moveTabToWindow } from '@/features/window/windowManager';
import { dragTab } from '@/features/window/tabDrag';
import { nativeTabInsertionAnchor, tabInsertionAnchor } from '@/features/window/tabDropTarget';
import { useWindowStore, type Tab } from '@/stores/windowStore';

/** 用固定可视窗口和标签位置模拟横向滚动；中线是插入边界。 */
function elementRect(element: Element, left: number, right: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ left, right, top: 0, bottom: 36,
    x: left, y: 0, width: right - left, height: 36, toJSON() {} });
}

describe('原生标签拖放编排', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<div role="tablist"><div data-tab-key="a"></div><div data-tab-key="b"></div><div data-tab-key="c"></div></div>';
    const bar = document.querySelector('[role="tablist"]')!;
    elementRect(bar, 40, 340);
    [...bar.children].forEach((element, index) => elementRect(element, 40 + index * 100, 140 + index * 100));
    const tabs = ['a', 'b', 'c'].map((key): Tab => ({ key, displayName: key, path: null,
      kind: 'code', language: 'plaintext', isDirty: false, isPreview: false, viewMode: null,
      externalStatus: null, isDetached: false }));
    useWindowStore.setState({ tabs, activeKey: 'b', transferringKeys: [], pendingCloseKeys: [], isWindowClosing: false });
    // jsdom 没有 Canvas 绘制，用轻量替身生成原生接口需要的预览格式。
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      beginPath() {}, roundRect() {}, fill() {}, stroke() {}, fillText() {}, measureText: () => ({ width: 10 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AA==');
  });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

  it('标签左右半区按中线决定插入位置，内容区追加', () => {
    expect(tabInsertionAnchor(70, 18)).toBe('a');
    expect(tabInsertionAnchor(120, 18)).toBe('b');
    expect(tabInsertionAnchor(300, 18)).toBeNull();
    expect(tabInsertionAnchor(70, 100)).toBeNull();
    expect(tabInsertionAnchor(70, 18, 'a')).toBe('b');
  });

  it('目标物理坐标按自身 DPI 换算，不使用源窗口缩放', () => {
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
    expect(nativeTabInsertionAnchor({ x: 240, y: 36 })).toBe('b');
  });

  it('系统取消不排序、不迁移', async () => {
    vi.mocked(ipc.startTabDrag).mockResolvedValue({ cancelled: true, target: null, position: null });
    await dragTab('b');
    expect(moveTabToWindow).not.toHaveBeenCalled();
    expect(useWindowStore.getState().tabs.map((tab) => tab.key)).toEqual(['a', 'b', 'c']);
  });

  it('松手在窗口外携带原生位置创建新窗', async () => {
    vi.mocked(ipc.startTabDrag).mockResolvedValue({ cancelled: false, target: null, position: [-1200, 90] });
    await dragTab('b');
    expect(moveTabToWindow).toHaveBeenCalledWith('b', expect.objectContaining({ position: [-1200, 90], targetLabel: undefined }));
  });

  it('拖入另一个窗口，携带目标内落点，不新建窗口', async () => {
    vi.mocked(ipc.startTabDrag).mockResolvedValue({ cancelled: false,
      target: { label: 'nb-other', beforeKey: 'remote', x: 100, y: 18 }, position: [1000, 600] });
    await dragTab('b');
    expect(moveTabToWindow).toHaveBeenCalledWith('b', expect.objectContaining({ targetLabel: 'nb-other',
      position: null, dropPosition: { x: 100, y: 18 } }));
  });

  it('同窗原生落点只排序，排除被拖标签自身', async () => {
    vi.mocked(ipc.startTabDrag).mockResolvedValue({ cancelled: false,
      target: { label: 'nb-main', beforeKey: null, x: 60, y: 18 }, position: null });
    await dragTab('c');
    expect(useWindowStore.getState().tabs.map((tab) => tab.key)).toEqual(['c', 'a', 'b']);
    expect(moveTabToWindow).not.toHaveBeenCalled();
  });
});
