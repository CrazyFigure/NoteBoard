// 窗口标题同步测试：验证桌面端、网页端及移动端壳的窗口标题格式、切换更新与异常降级。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWindowStore, type Tab } from '@/stores/windowStore';

const setTitleMock = vi.fn();
let throwOnGetWindow = false;
let omitSetTitle = false;

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => {
    if (throwOnGetWindow) throw new Error('missing tauri runtime');
    return omitSetTitle ? { label: 'nb-main' } : { label: 'nb-main', setTitle: setTitleMock };
  },
}));

function makeTab(key: string, displayName: string): Tab {
  return {
    key,
    displayName,
    path: `C:\\notes\\${displayName}`,
    kind: 'markdown',
    language: 'markdown',
    isDirty: false,
    isPreview: false,
    viewMode: 'visual',
    externalStatus: null,
    isDetached: false,
  };
}

describe('窗口标题同步', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setTitleMock.mockReset().mockResolvedValue(undefined);
    throwOnGetWindow = false;
    omitSetTitle = false;
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [], pendingCloseKeys: [] });
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    host.remove();
    vi.doUnmock('@/core/platform');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('formatWindowTitle 在无活动文件时返回应用名，有文件时文件名置前', async () => {
    const { formatWindowTitle } = await import('@/features/window/windowTitle');
    expect(formatWindowTitle(null)).toBe('NoteBoard');
    expect(formatWindowTitle(undefined)).toBe('NoteBoard');
    expect(formatWindowTitle('')).toBe('NoteBoard');
    expect(formatWindowTitle('   ')).toBe('NoteBoard');
    expect(formatWindowTitle('需求.md')).toBe('需求.md - NoteBoard');
    expect(formatWindowTitle('未命名.excalidraw')).toBe('未命名.excalidraw - NoteBoard');
    expect(formatWindowTitle('文本对比')).toBe('文本对比 - NoteBoard');
    expect(formatWindowTitle('周报.md', 'NoteBoard Dev')).toBe('周报.md - NoteBoard Dev');
    expect(formatWindowTitle(null, 'NoteBoard Dev')).toBe('NoteBoard Dev');
  });

  it('syncCurrentWindowTitle 在无运行时、缺方法、拒绝或原生移动端时均安全降级', async () => {
    const { syncCurrentWindowTitle } = await import('@/features/window/windowTitle');

    syncCurrentWindowTitle('笔记.md - NoteBoard');
    expect(setTitleMock).toHaveBeenCalledWith('笔记.md - NoteBoard');

    // 模拟未注入 __TAURI_INTERNALS__
    throwOnGetWindow = true;
    expect(() => syncCurrentWindowTitle('NoteBoard')).not.toThrow();

    // 模拟单测中仅返回 { label } 的局部窗口替身
    throwOnGetWindow = false;
    omitSetTitle = true;
    expect(() => syncCurrentWindowTitle('NoteBoard')).not.toThrow();

    // 模拟底层 Promise 拒绝，不应产生未捕获拒绝
    omitSetTitle = false;
    setTitleMock.mockRejectedValueOnce(new Error('setTitle failed'));
    expect(() => syncCurrentWindowTitle('故障.md - NoteBoard')).not.toThrow();

    // 模拟原生移动端（Android），应直接跳过原生窗口标题 IPC
    vi.resetModules();
    setTitleMock.mockClear();
    vi.doMock('@/core/platform', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/core/platform')>()),
      IS_NATIVE_MOBILE: true,
      IS_WEB: false,
    }));
    const mobileModule = await import('@/features/window/windowTitle');
    mobileModule.syncCurrentWindowTitle('忽略.md - NoteBoard');
    expect(setTitleMock).not.toHaveBeenCalled();
  });

  it('useWindowTitleSync 随活动标签打开、切换、重命名、回主页与关闭实时更新', async () => {
    const { useWindowTitleSync } = await import('@/features/window/windowTitle');

    function Harness() {
      const tabs = useWindowStore((s) => s.tabs);
      const activeKey = useWindowStore((s) => s.activeKey);
      const activeTab = tabs.find((tab) => tab.key === activeKey);
      useWindowTitleSync(activeTab?.displayName ?? null);
      return null;
    }

    root = createRoot(host);
    await act(async () => {
      root?.render(<Harness />);
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('NoteBoard');

    // 打开文件 A 与文件 B
    await act(async () => {
      useWindowStore.getState().openTab(makeTab('a', 'alpha.md'));
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('alpha.md - NoteBoard');

    await act(async () => {
      useWindowStore.getState().openTab(makeTab('b', 'beta.excalidraw'));
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('beta.excalidraw - NoteBoard');

    // 切回文件 A 并重命名
    await act(async () => {
      useWindowStore.getState().activateTab('a');
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('alpha.md - NoteBoard');

    await act(async () => {
      useWindowStore.getState().updateTabPath('a', 'C:\\notes\\alpha-v2.md', 'alpha-v2.md');
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('alpha-v2.md - NoteBoard');

    // 回到主页（activeKey = null）再切回文件
    await act(async () => {
      useWindowStore.setState({ activeKey: null });
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('NoteBoard');

    // 重新激活并关闭唯一标签后恢复应用标题
    await act(async () => {
      useWindowStore.getState().activateTab('b');
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('beta.excalidraw - NoteBoard');

    await act(async () => {
      useWindowStore.setState({ tabs: [], activeKey: null });
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('NoteBoard');
  });

  it('网页端 runtime 的 setTitle 同步更新浏览器标签页 document.title', async () => {
    const originalTitle = document.title;
    try {
      const { getCurrentWindow } = await import('@/web/runtime');
      await getCurrentWindow().setTitle('网页笔记.md - NoteBoard');
      expect(document.title).toBe('网页笔记.md - NoteBoard');
      await getCurrentWindow().setTitle('NoteBoard');
      expect(document.title).toBe('NoteBoard');
    } finally {
      document.title = originalTitle;
    }
  });

  it('tauriMock 处理 plugin:window|set_title 并同步 document.title', async () => {
    const originalTitle = document.title;
    try {
      const { installTauriMock } = await import('@/dev/tauriMock');
      const { clearMocks } = await import('@tauri-apps/api/mocks');
      const { invoke } = await import('@tauri-apps/api/core');
      installTauriMock();
      try {
        await invoke('plugin:window|set_title', { label: 'nb-main', value: '模拟预览.md - NoteBoard' });
        expect(document.title).toBe('模拟预览.md - NoteBoard');
      } finally {
        clearMocks();
      }
    } finally {
      document.title = originalTitle;
    }
  });
});
