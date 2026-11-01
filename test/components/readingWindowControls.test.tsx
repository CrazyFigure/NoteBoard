// 沉浸阅读窗口控件：右上角悬停展开、各平台按钮差异、顶部拖动条与按钮行为
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeWindow = {
  label: 'nb-main',
  isFullscreen: vi.fn(async () => false),
  setFullscreen: vi.fn(async (_enabled: boolean) => {}),
  minimize: vi.fn(async () => {}),
  onResized: vi.fn(async (_handler: () => void) => () => {}),
};
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => nativeWindow }));
vi.mock('../../src/components/Tooltip', () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
}));

type ControlsProps = ComponentProps<typeof import('../../src/features/reading/ReadingWindowControls').ReadingWindowControls>;

interface PlatformFlags {
  TARGET_PLATFORM: string;
  IS_WEB: boolean;
  IS_MOBILE_UI: boolean;
  USES_MAC_TRAFFIC_LIGHTS: boolean;
}

const WINDOWS: PlatformFlags = { TARGET_PLATFORM: 'windows', IS_WEB: false, IS_MOBILE_UI: false, USES_MAC_TRAFFIC_LIGHTS: false };
const LINUX: PlatformFlags = { ...WINDOWS, TARGET_PLATFORM: 'linux' };
const MACOS: PlatformFlags = { ...WINDOWS, TARGET_PLATFORM: 'macos', USES_MAC_TRAFFIC_LIGHTS: true };
const WEB: PlatformFlags = { ...WINDOWS, TARGET_PLATFORM: 'web', IS_WEB: true };
const MOBILE: PlatformFlags = { ...WINDOWS, TARGET_PLATFORM: 'android', IS_MOBILE_UI: true };

let host: HTMLDivElement;
let root: Root | null = null;

/** 平台常量在模块加载时固定，每次渲染按目标平台重新加载被测模块 */
async function renderControls(platform: PlatformFlags, props: Partial<ControlsProps> = {}) {
  unmount();
  vi.resetModules();
  vi.doMock('../../src/core/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/core/platform')>()),
    ...platform,
  }));
  const { ReadingWindowControls } = await import('../../src/features/reading/ReadingWindowControls');
  const { requestReadingMode } = await import('../../src/features/reading/readingMode');
  requestReadingMode(true);
  const onExit = vi.fn();
  root = createRoot(host);
  // 冲刷首次全屏状态同步，避免异步 setState 落在 act 之外
  await act(async () => {
    root?.render(<ReadingWindowControls onExit={onExit} {...props} />);
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); });
  return { onExit };
}

function unmount() {
  if (!root) return;
  act(() => root?.unmount());
  root = null;
}

const buttonLabels = () => Array.from(host.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'));
const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const capsule = () => host.querySelector('.nb-reading-capsule') as HTMLElement;
const corner = () => host.querySelector('.nb-reading-corner') as HTMLElement;

/** React 的 pointerenter / pointerleave 由 pointerover / pointerout 合成 */
function hoverCorner(entering: boolean) {
  act(() => {
    corner().dispatchEvent(new MouseEvent(entering ? 'pointerover' : 'pointerout', { bubbles: true, relatedTarget: null }));
  });
}

function click(target: HTMLElement) {
  act(() => { target.click(); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  nativeWindow.isFullscreen.mockReset().mockResolvedValue(false);
  nativeWindow.setFullscreen.mockClear();
  nativeWindow.minimize.mockClear();
  nativeWindow.onResized.mockClear();
});

afterEach(() => {
  unmount();
  host.remove();
  vi.useRealTimers();
  vi.doUnmock('../../src/core/platform');
  vi.unstubAllGlobals();
});

describe('沉浸阅读窗口控件', () => {
  it.each([['Windows', WINDOWS], ['Linux', LINUX], ['macOS', MACOS]] as const)('%s 窗口状态提供最小化、全屏、退出', async (_name, platform) => {
    await renderControls(platform);
    expect(buttonLabels()).toEqual(['最小化', '全屏', '退出沉浸阅读']);
  });

  it('macOS 原生全屏无法最小化，隐藏最小化按钮', async () => {
    nativeWindow.isFullscreen.mockResolvedValue(true);
    await renderControls(MACOS);
    expect(buttonLabels()).toEqual(['退出全屏', '退出沉浸阅读']);
  });

  it('Windows 全屏时保留最小化', async () => {
    nativeWindow.isFullscreen.mockResolvedValue(true);
    await renderControls(WINDOWS);
    expect(buttonLabels()).toEqual(['最小化', '退出全屏', '退出沉浸阅读']);
  });

  it('网页只提供全屏与退出，浏览器禁用全屏时只留退出', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    await renderControls(WEB);
    expect(buttonLabels()).toEqual(['全屏', '退出沉浸阅读']);

    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    await renderControls(WEB);
    expect(buttonLabels()).toEqual(['退出沉浸阅读']);
  });

  it('移动端只提供退出且不访问窗口接口', async () => {
    await renderControls(MOBILE);
    expect(buttonLabels()).toEqual(['退出沉浸阅读']);
    expect(nativeWindow.isFullscreen).not.toHaveBeenCalled();
    expect(host.querySelector('.nb-reading-drag')).toBeNull();
  });

  it('进入时短暂提示后隐藏，移到右上角才展开，移开后收起', async () => {
    vi.useFakeTimers();
    await renderControls(WINDOWS);
    expect(capsule().dataset.visible).toBe('true');

    act(() => { vi.advanceTimersByTime(1800); });
    expect(capsule().dataset.visible).toBe('false');

    hoverCorner(true);
    expect(capsule().dataset.visible).toBe('true');

    hoverCorner(false);
    expect(capsule().dataset.visible).toBe('false');
  });

  it('只在悬停展开期间铺遮罩，确保指针移到跨进程 iframe 时能收起', async () => {
    vi.useFakeTimers();
    await renderControls(WINDOWS);
    // 进入提示不是悬停，不能拦截正文
    expect(host.querySelector('.nb-reading-hover-shield')).toBeNull();
    act(() => { vi.advanceTimersByTime(1800); });

    hoverCorner(true);
    expect(host.querySelector('.nb-reading-hover-shield')).not.toBeNull();

    hoverCorner(false);
    expect(host.querySelector('.nb-reading-hover-shield')).toBeNull();
  });

  it('热区挂载到静止指针下方时，移动鼠标也能展开', async () => {
    vi.useFakeTimers();
    await renderControls(WINDOWS);
    act(() => { vi.advanceTimersByTime(1800); });
    expect(capsule().dataset.visible).toBe('false');

    // 浏览器不会补发进入事件，只有 pointermove
    act(() => { corner().dispatchEvent(new MouseEvent('pointermove', { bubbles: true })); });
    expect(capsule().dataset.visible).toBe('true');
  });

  it('触屏按下不算悬停', async () => {
    vi.useFakeTimers();
    await renderControls(WINDOWS);
    act(() => { vi.advanceTimersByTime(1800); });

    const touch = new MouseEvent('pointerover', { bubbles: true, relatedTarget: null });
    Object.defineProperty(touch, 'pointerType', { value: 'touch' });
    act(() => { corner().dispatchEvent(touch); });
    expect(capsule().dataset.visible).toBe('false');
  });

  it('窗口失焦时收起，最小化恢复后不会常驻', async () => {
    vi.useFakeTimers();
    await renderControls(WINDOWS);
    act(() => { vi.advanceTimersByTime(1800); });
    hoverCorner(true);

    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(capsule().dataset.visible).toBe('false');
    vi.restoreAllMocks();
  });

  it('焦点进入 iframe 时窗口未失焦，保持展开', async () => {
    vi.useFakeTimers();
    await renderControls(WINDOWS);
    act(() => { vi.advanceTimersByTime(1800); });
    hoverCorner(true);

    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(capsule().dataset.visible).toBe('true');
    vi.restoreAllMocks();
  });

  it('桌面窗口状态显示拖动条，全屏、网页与工具栏格式不显示', async () => {
    await renderControls(WINDOWS);
    expect(host.querySelector('.nb-reading-drag [data-tauri-drag-region]')).not.toBeNull();

    nativeWindow.isFullscreen.mockResolvedValue(true);
    await renderControls(WINDOWS);
    expect(host.querySelector('.nb-reading-drag')).toBeNull();

    nativeWindow.isFullscreen.mockResolvedValue(false);
    await renderControls(WEB);
    expect(host.querySelector('.nb-reading-drag')).toBeNull();

    await renderControls(WINDOWS, { dragStrip: false });
    expect(host.querySelector('.nb-reading-drag')).toBeNull();
  });

  it('按钮分别调用最小化、全屏与退出', async () => {
    const { onExit } = await renderControls(WINDOWS);

    click(button('最小化'));
    expect(nativeWindow.minimize).toHaveBeenCalledTimes(1);

    click(button('全屏'));
    await vi.waitFor(() => expect(nativeWindow.setFullscreen).toHaveBeenCalledWith(true));

    click(button('退出沉浸阅读'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('窗口尺寸变化时同步全屏按钮', async () => {
    await renderControls(WINDOWS);
    expect(button('全屏')).not.toBeNull();

    nativeWindow.isFullscreen.mockResolvedValue(true);
    const onResized = nativeWindow.onResized.mock.calls[0][0];
    await act(async () => {
      onResized();
      await Promise.resolve();
    });
    expect(button('退出全屏')).not.toBeNull();
  });

  it('全屏切换后尺寸未变化也同步按钮', async () => {
    let fullscreen = false;
    nativeWindow.isFullscreen.mockImplementation(async () => fullscreen);
    nativeWindow.setFullscreen.mockImplementationOnce(async (enabled: boolean) => { fullscreen = enabled; });
    await renderControls(WINDOWS);

    await act(async () => {
      button('全屏').click();
      await vi.waitFor(() => expect(nativeWindow.setFullscreen).toHaveBeenCalledWith(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(button('退出全屏')).not.toBeNull();
    expect(nativeWindow.onResized.mock.calls).toHaveLength(1);
  });

  it('显示阅读进度', async () => {
    await renderControls(WINDOWS, { percent: 42 });
    expect(host.querySelector('.nb-reading-percent')?.textContent).toBe('42%');
  });

  it('浮动工具栏格式的热区层级低于工具栏', async () => {
    await renderControls(WINDOWS, { belowToolbar: true });
    expect(corner().dataset.belowToolbar).toBe('true');
  });
});
