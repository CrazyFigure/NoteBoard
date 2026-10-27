// 极窄模式回归：验证进入/退出时的尺寸约束、常规外观还原、极窄外观记忆（与常规模式分开）、
// 置顶切换、自动贴边开关与关闭前还原。只替换原生窗口接口与 IPC，布局 store 使用真实实现。

import { beforeEach, describe, expect, it, vi } from 'vitest';

class LogicalSize {
  constructor(public width: number, public height: number) {}
}
class PhysicalPosition {
  constructor(public x: number, public y: number) {}
}

const nativeWindow = vi.hoisted(() => ({
  label: 'nb-main',
  isFullscreen: vi.fn(),
  setFullscreen: vi.fn(),
  isMaximized: vi.fn(),
  unmaximize: vi.fn(),
  maximize: vi.fn(),
  scaleFactor: vi.fn(),
  innerSize: vi.fn(),
  outerPosition: vi.fn(),
  setMinSize: vi.fn(),
  setMaxSize: vi.fn(),
  setSize: vi.fn(),
  setPosition: vi.fn(),
  setAlwaysOnTop: vi.fn(),
  hide: vi.fn(),
}));
const monitors = vi.hoisted(() => vi.fn());

// 自动贴边：命令与事件由 Rust 提供，测试中记录调用并手动派发状态
const edgeDockIpc = vi.hoisted(() => ({
  setEdgeDock: vi.fn(),
  listener: null as null | ((event: { label: string; edge: 'left' | 'right' | 'top' | null; hidden: boolean }) => void),
}));
vi.mock('../../src/core/ipc/commands', () => ({ setEdgeDock: edgeDockIpc.setEdgeDock }));
vi.mock('../../src/core/ipc/events', () => ({
  onEdgeDock: (cb: NonNullable<typeof edgeDockIpc.listener>) => {
    edgeDockIpc.listener = cb;
    return Promise.resolve(() => undefined);
  },
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => nativeWindow,
  availableMonitors: monitors,
  LogicalSize,
  PhysicalPosition,
}));

type CompactModule = typeof import('../../src/features/window/compactMode');
type LayoutModule = typeof import('../../src/stores/layoutStore');
type ToastModule = typeof import('../../src/stores/toastStore');
let compact: CompactModule;
let layout: LayoutModule['useLayoutStore'];
let toasts: ToastModule['useToastStore'];

/** 设定当前原生窗口外观（逻辑尺寸，缩放比 1） */
function setNativeBounds(width: number, height: number, x: number, y: number) {
  nativeWindow.innerSize.mockResolvedValue({ toLogical: () => ({ width, height }) });
  nativeWindow.outerPosition.mockResolvedValue(new PhysicalPosition(x, y));
}

beforeEach(async () => {
  vi.resetModules();
  window.localStorage.clear();
  for (const fn of Object.values(nativeWindow)) {
    if (typeof fn === 'function') fn.mockReset().mockResolvedValue(undefined);
  }
  nativeWindow.isFullscreen.mockResolvedValue(false);
  nativeWindow.isMaximized.mockResolvedValue(false);
  nativeWindow.scaleFactor.mockResolvedValue(1);
  setNativeBounds(1200, 800, 100, 50);
  monitors.mockReset().mockResolvedValue([{ position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } }]);
  edgeDockIpc.setEdgeDock.mockReset().mockResolvedValue(undefined);
  edgeDockIpc.listener = null;
  compact = await import('../../src/features/window/compactMode');
  layout = (await import('../../src/stores/layoutStore')).useLayoutStore;
  toasts = (await import('../../src/stores/toastStore')).useToastStore;
});

describe('极窄模式', () => {
  it('首次进入使用默认宽度并限制宽度范围，高度沿用当前窗口', async () => {
    await compact.requestCompactMode(true);

    expect(layout.getState().compactMode).toBe(true);
    expect(nativeWindow.setMinSize).toHaveBeenCalledWith(new LogicalSize(360, 240));
    expect(nativeWindow.setSize).toHaveBeenCalledWith(new LogicalSize(408, 800));
    expect(nativeWindow.setMaxSize).toHaveBeenCalledWith(new LogicalSize(680, 16384));
    // 无记忆位置时保持窗口左上角不动
    expect(nativeWindow.setPosition).not.toHaveBeenCalled();
  });

  it('退出时记住极窄外观，并还原常规尺寸、位置与最大化', async () => {
    nativeWindow.isMaximized.mockResolvedValue(true);
    await compact.requestCompactMode(true);
    expect(nativeWindow.unmaximize).toHaveBeenCalled();

    // 用户在极窄模式下调整了尺寸并移动了窗口
    setNativeBounds(520, 640, 1300, 200);
    await compact.requestCompactMode(false);

    expect(layout.getState().compactMode).toBe(false);
    expect(nativeWindow.setMaxSize).toHaveBeenLastCalledWith(null);
    expect(nativeWindow.setSize).toHaveBeenLastCalledWith(new LogicalSize(1200, 800));
    expect(nativeWindow.setPosition).toHaveBeenLastCalledWith(new PhysicalPosition(100, 50));
    expect(nativeWindow.setMinSize).toHaveBeenLastCalledWith(new LogicalSize(680, 480));
    expect(nativeWindow.maximize).toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem('nb-compact-window')!)).toEqual({
      width: 520,
      height: 640,
      positions: { 'nb-main': { x: 1300, y: 200 } },
    });
  });

  it('再次进入恢复记忆的极窄尺寸与位置；位置已不在任何屏幕上时只恢复尺寸', async () => {
    window.localStorage.setItem('nb-compact-window', JSON.stringify({
      width: 9999,
      height: 600,
      positions: { 'nb-main': { x: 1500, y: 300 } },
    }));
    await compact.requestCompactMode(true);
    // 记忆宽度超出上限时钳制到常规最小宽度
    expect(nativeWindow.setSize).toHaveBeenLastCalledWith(new LogicalSize(680, 600));
    expect(nativeWindow.setPosition).toHaveBeenLastCalledWith(new PhysicalPosition(1500, 300));

    await compact.requestCompactMode(false);
    nativeWindow.setPosition.mockClear();
    // 外接显示器拔除后原位置不可见
    window.localStorage.setItem('nb-compact-window', JSON.stringify({
      width: 400,
      height: 600,
      positions: { 'nb-main': { x: 2500, y: 300 } },
    }));
    await compact.requestCompactMode(true);
    expect(nativeWindow.setSize).toHaveBeenLastCalledWith(new LogicalSize(400, 600));
    expect(nativeWindow.setPosition).not.toHaveBeenCalled();
  });

  it('沉浸阅读等全屏状态下不进入极窄模式', async () => {
    layout.getState().setReadingMode(true);
    await compact.requestCompactMode(true);

    expect(layout.getState().compactMode).toBe(false);
    expect(nativeWindow.setSize).not.toHaveBeenCalled();
  });

  it('置顶失败时回滚状态并提示，退出极窄模式时自动取消置顶', async () => {
    await compact.requestCompactMode(true);
    nativeWindow.setAlwaysOnTop.mockRejectedValueOnce(new Error('unsupported'));
    await compact.toggleWindowPinned();
    expect(layout.getState().windowPinned).toBe(false);
    expect(toasts.getState().toasts.some((t) => t.message === '当前系统不支持窗口置顶')).toBe(true);

    await compact.toggleWindowPinned();
    expect(layout.getState().windowPinned).toBe(true);
    expect(nativeWindow.setAlwaysOnTop).toHaveBeenLastCalledWith(true);

    await compact.requestCompactMode(false);
    expect(layout.getState().windowPinned).toBe(false);
    expect(nativeWindow.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  });

  it('关闭前先隐藏再还原常规尺寸，不恢复最大化以免重新显示窗口', async () => {
    expect(await compact.settleCompactModeBeforeClose()).toBe(false);

    nativeWindow.isMaximized.mockResolvedValue(true);
    await compact.requestCompactMode(true);
    expect(await compact.settleCompactModeBeforeClose()).toBe(true);

    expect(nativeWindow.hide).toHaveBeenCalled();
    expect(nativeWindow.hide.mock.invocationCallOrder[0])
      .toBeLessThan(nativeWindow.setSize.mock.invocationCallOrder.at(-1)!);
    expect(nativeWindow.setSize).toHaveBeenLastCalledWith(new LogicalSize(1200, 800));
    expect(nativeWindow.maximize).not.toHaveBeenCalled();
    expect(layout.getState().compactMode).toBe(false);
  });

  it('自动贴边：开启后吸附期间保持置顶，退出极窄模式时先关闭贴边并记住选择', async () => {
    await compact.requestCompactMode(true);
    await compact.toggleEdgeDock();
    expect(edgeDockIpc.setEdgeDock).toHaveBeenLastCalledWith(true);
    expect(layout.getState().edgeDockEnabled).toBe(true);

    // Rust 通知已吸附左侧：未钉住也须置顶，收起后的细边才能被鼠标碰到
    edgeDockIpc.listener?.({ label: 'nb-main', edge: 'left', hidden: false });
    expect(layout.getState().dockedEdge).toBe('left');
    expect(nativeWindow.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
    // 其它窗口的通知不影响本窗口
    edgeDockIpc.listener?.({ label: 'nb-2', edge: null, hidden: false });
    expect(layout.getState().dockedEdge).toBe('left');

    await compact.requestCompactMode(false);
    expect(edgeDockIpc.setEdgeDock).toHaveBeenLastCalledWith(false);
    // 关闭贴边（窗口滑回）先于记录位置与还原尺寸
    expect(edgeDockIpc.setEdgeDock.mock.invocationCallOrder.at(-1)!)
      .toBeLessThan(nativeWindow.setSize.mock.invocationCallOrder.at(-1)!);
    expect(layout.getState().edgeDockEnabled).toBe(false);
    expect(layout.getState().dockedEdge).toBeNull();
    expect(nativeWindow.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(JSON.parse(window.localStorage.getItem('nb-compact-window')!).edgeDock).toBe(true);

    // 再次进入极窄模式沿用上次的贴边设置
    edgeDockIpc.setEdgeDock.mockClear();
    await compact.requestCompactMode(true);
    expect(edgeDockIpc.setEdgeDock).toHaveBeenCalledWith(true);
    expect(layout.getState().edgeDockEnabled).toBe(true);
  });

  it('桌面环境不支持自动贴边时保持关闭并提示原因', async () => {
    await compact.requestCompactMode(true);
    edgeDockIpc.setEdgeDock.mockRejectedValueOnce('当前桌面环境不支持自动贴边');
    await compact.toggleEdgeDock();

    expect(layout.getState().edgeDockEnabled).toBe(false);
    expect(toasts.getState().toasts.some((t) => t.message === '当前桌面环境不支持自动贴边')).toBe(true);
    expect(window.localStorage.getItem('nb-compact-window')).toBeNull();
  });
});
