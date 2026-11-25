// 外壳级窗口标题同步测试：验证桌面 AppShell 与移动端 MobileShell 在打开/切换/回主页时的标题同步。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setTitleMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'nb-main',
    setTitle: setTitleMock,
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn().mockResolvedValue(undefined),
    onResized: vi.fn().mockResolvedValue(() => {}),
  }),
}));
vi.mock('@tauri-apps/api/app', () => ({
  onBackButtonPress: vi.fn().mockResolvedValue({ unregister: vi.fn() }),
}));
vi.mock('@/core/ipc/commands', () => ({
  getPlatformInfo: vi.fn().mockResolvedValue({
    platform: 'web',
    isMobile: true,
    defaultWorkspace: '/workspace',
    externalRoot: '/workspace',
    allFilesAccess: false,
  }),
  ensureDefaultWorkspace: vi.fn().mockResolvedValue('/workspace'),
  takeIncomingFiles: vi.fn().mockResolvedValue([]),
  readDir: vi.fn().mockResolvedValue([]),
  setSystemBarStyle: vi.fn().mockResolvedValue(undefined),
  moveAppToBackground: vi.fn().mockResolvedValue(undefined),
  setTrafficLightsHidden: vi.fn().mockResolvedValue(undefined),
  unregisterDocument: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/components/titlebar/TitleBar', () => ({ TitleBar: () => null }));
vi.mock('@/components/statusbar/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('@/components/WelcomeScreen', () => ({ WelcomeScreen: () => null }));
vi.mock('@/components/Toast', () => ({ ToastContainer: () => null }));
vi.mock('@/components/PromptDialogHost', () => ({ PromptDialogHost: () => null }));
vi.mock('@/components/ExportResultDialogHost', () => ({ ExportResultDialogHost: () => null }));
vi.mock('@/features/wikilink/WikiLinkDialogHost', () => ({ WikiLinkDialogHost: () => null }));
vi.mock('@/features/wikilink/LinkGraphHost', () => ({ LinkGraphHost: () => null }));
vi.mock('@/components/rail/RailToggle', () => ({ RailToggle: () => null }));
vi.mock('@/components/FileDropOverlay', () => ({ FileDropOverlay: () => null }));
vi.mock('@/components/shell/EditorStack', () => ({ EditorStack: () => null }));
vi.mock('@/components/shell/CompactModeNotice', () => ({ CompactModeNotice: () => null }));
vi.mock('@/features/outline/OutlinePanel', () => ({ OutlinePanel: () => null }));
vi.mock('@/features/editor-code/UnsavedGuardDialog', () => ({ UnsavedGuardDialog: () => null }));
vi.mock('@/features/explorer/Explorer', () => ({ Explorer: () => null }));
vi.mock('@/features/search/SearchReplaceBar', () => ({ SearchReplaceBar: () => null }));
vi.mock('@/features/toolbar/EditorToolbar', () => ({ EditorToolbar: () => null }));
vi.mock('@/features/external/MissingFileDialog', () => ({ MissingFileDialog: () => null }));
vi.mock('@/features/external/ExternalChangeDialog', () => ({ ExternalChangeDialog: () => null }));
vi.mock('@/features/versionHistory/HistoryHost', () => ({ HistoryHost: () => null }));
vi.mock('@/features/window/windowManager', () => ({ performWindowClose: vi.fn() }));
vi.mock('@/features/staging/stagingManager', () => ({
  discardStagedDocuments: vi.fn(),
  stashPendingDocuments: vi.fn(),
}));
vi.mock('@/features/session/closedWindowSession', () => ({
  saveCurrentWindowSnapshot: vi.fn(),
  loadRestoredTab: vi.fn().mockResolvedValue('loaded'),
}));
vi.mock('@/features/external/missingFileGuard', () => ({
  checkActiveDocumentStillExists: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/features/welcome/welcomeActions', () => ({
  openFileDialog: vi.fn(),
  openFolderDialog: vi.fn(),
  openStagingArea: vi.fn(),
  openSyncFolder: vi.fn(),
  newMarkdown: vi.fn(),
  newMindmap: vi.fn(),
  newTextDiff: vi.fn(),
  newDrawio: vi.fn(),
  newBitable: vi.fn(),
  newBoard: vi.fn(),
  newMermaid: vi.fn(),
  newPlantUml: vi.fn(),
  newInfographic: vi.fn(),
  newJson: vi.fn(),
  newSql: vi.fn(),
  newText: vi.fn(),
}));
vi.mock('@/mobile/MobileHome', () => ({ MobileHome: () => null }));
vi.mock('@/mobile/MobileEditorPage', () => ({ MobileEditorPage: () => null }));
vi.mock('@/mobile/components', () => ({ PromptDialog: () => null }));
vi.mock('@/mobile/mobileFiles', () => ({
  consumeIncomingFiles: vi.fn().mockResolvedValue(undefined),
  navigateUp: vi.fn().mockResolvedValue(false),
  refreshCurrentFolder: vi.fn().mockResolvedValue(undefined),
  switchLocation: vi.fn().mockResolvedValue(undefined),
  validateFileName: vi.fn(),
}));

import { AppShell } from '@/components/AppShell';
import { MobileShell } from '@/mobile/MobileShell';
import { useMobileStore } from '@/mobile/mobileStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { useWindowStore, type Tab } from '@/stores/windowStore';

class ResizeObserverStub {
  observe(): void { /* jsdom 无布局 */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

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

describe('外壳组件窗口标题联动', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setTitleMock.mockClear();
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [], pendingCloseKeys: [] });
    useLayoutStore.setState({ explorerVisible: false, outlineVisible: false, statusBarVisible: false });
    useMobileStore.setState({ page: 'home' });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    host.remove();
    vi.unstubAllGlobals();
  });

  it('AppShell 随活动标签与主页状态同步窗口标题', async () => {
    await act(async () => {
      root?.render(<AppShell />);
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('NoteBoard');

    await act(async () => {
      useWindowStore.getState().openTab(makeTab('doc-1', '桌面文档.md'));
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('桌面文档.md - NoteBoard');

    await act(async () => {
      useWindowStore.setState({ activeKey: null });
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('NoteBoard');
  });

  it('MobileShell 仅在编辑页显示当前文件名，返回首页时恢复应用标题', async () => {
    await act(async () => {
      root?.render(<MobileShell />);
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('NoteBoard');

    // 打开文档后 MobileShell 自动切换到编辑页并更新标题
    await act(async () => {
      useWindowStore.getState().openTab(makeTab('m-1', '移动笔记.md'));
    });
    expect(useMobileStore.getState().page).toBe('editor');
    expect(setTitleMock).toHaveBeenLastCalledWith('移动笔记.md - NoteBoard');

    // 返回首页后即使后台仍保留已打开标签，标题也应恢复为 NoteBoard
    await act(async () => {
      useMobileStore.getState().setPage('home');
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('NoteBoard');

    // 再次进入编辑页恢复文件名标题
    await act(async () => {
      useMobileStore.getState().setPage('editor');
    });
    expect(setTitleMock).toHaveBeenLastCalledWith('移动笔记.md - NoteBoard');
  });
});
