// 左侧栏自动关闭开关测试
// 覆盖：默认保持展开、开启后启动/Home 与打开文件不自动展开左侧栏、
//       开启/远程同步立即收起、会话恢复不意外展开、打开文件夹仍正常展开左侧栏。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: 'windows',
  dialogOpen: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn().mockResolvedValue(1),
  prepareDocument: vi.fn(),
  registerDocument: vi.fn(),
  readDir: vi.fn(),
  pushRecent: vi.fn().mockResolvedValue(undefined),
  openWithDefaultApp: vi.fn(),
  focusWindow: vi.fn().mockResolvedValue(undefined),
  ensureStagingDirectory: vi.fn(),
  openLinuxPathDialog: vi.fn(),
  loadSession: vi.fn(),
  saveSession: vi.fn().mockResolvedValue(undefined),
  clearSession: vi.fn().mockResolvedValue(undefined),
  pathExists: vi.fn(),
  onSettingsChanged: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock('@/core/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/platform')>()),
  get TARGET_PLATFORM() {
    return mocks.platform;
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.dialogOpen,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'nb-main' }),
}));

vi.mock('@/core/ipc/commands', () => ({
  loadSettings: mocks.loadSettings,
  saveSettings: mocks.saveSettings,
  prepareDocument: mocks.prepareDocument,
  registerDocument: mocks.registerDocument,
  readDir: mocks.readDir,
  pushRecent: mocks.pushRecent,
  openWithDefaultApp: mocks.openWithDefaultApp,
  focusWindow: mocks.focusWindow,
  ensureStagingDirectory: mocks.ensureStagingDirectory,
  openLinuxPathDialog: mocks.openLinuxPathDialog,
  loadSession: mocks.loadSession,
  saveSession: mocks.saveSession,
  clearSession: mocks.clearSession,
  pathExists: mocks.pathExists,
}));

vi.mock('@/core/ipc/events', () => ({
  onSettingsChanged: mocks.onSettingsChanged,
}));

vi.mock('@/core/theme/applyTheme', () => ({
  resolveTheme: vi.fn().mockReturnValue('chen-guang'),
  applyTheme: vi.fn(),
  applyTypography: vi.fn(),
  startSystemThemeListener: vi.fn(),
  stopSystemThemeListener: vi.fn(),
}));

import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { useWindowStore } from '@/stores/windowStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useExplorerStore } from '@/features/explorer/explorerStore';
import { useSyncStore } from '@/stores/syncStore';
import { useFontPackStore } from '@/stores/fontPackStore';
import { openDocument } from '@/features/editor-code/orchestration/openDocument';
import {
  openFolderDialog,
  openFolderInExplorer,
  openStagingArea,
  openSyncFolder,
} from '@/features/welcome/welcomeActions';
import { restoreLastClosedWindow } from '@/features/session/closedWindowSession';

describe('左侧栏自动关闭开关', () => {
  const initialSettings = structuredClone(useSettingsStore.getState().settings);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform = 'windows';
    mocks.saveSettings.mockResolvedValue(1);
    mocks.readDir.mockResolvedValue([]);
    mocks.registerDocument.mockResolvedValue({ type: 'ok' });
    mocks.pushRecent.mockResolvedValue(undefined);
    mocks.focusWindow.mockResolvedValue(undefined);
    mocks.saveSession.mockResolvedValue(undefined);
    mocks.clearSession.mockResolvedValue(undefined);
    mocks.pathExists.mockResolvedValue({ exists: true, isDir: false });
    mocks.onSettingsChanged.mockResolvedValue(() => undefined);
    vi.spyOn(useFontPackStore.getState(), 'init').mockResolvedValue(undefined);

    useSettingsStore.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      initialized: false,
    });
    useLayoutStore.setState({
      explorerVisible: true,
      outlineVisible: true,
    });
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
    useExplorerStore.getState().clear();
    useSyncStore.setState({ config: null, status: null, initialized: false });
  });

  afterEach(() => {
    useSettingsStore.setState({ settings: structuredClone(initialSettings), initialized: false });
    vi.restoreAllMocks();
  });

  it('默认关闭“左侧栏自动关闭”，启动保持展开且打开文件自动展开左侧栏', async () => {
    expect(DEFAULT_SETTINGS.layout.autoCloseExplorer).toBe(false);

    mocks.loadSettings.mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
    await useSettingsStore.getState().init();
    expect(useLayoutStore.getState().explorerVisible).toBe(true);

    // 手动收起后打开文件，默认行为仍会自动展开左侧栏
    useLayoutStore.getState().setExplorerVisible(false);
    const mdPath = 'C:\\notes\\guide.md';
    mocks.prepareDocument.mockResolvedValue({
      type: 'text',
      payload: {
        key: mdPath,
        displayName: 'guide.md',
        dirPath: 'C:\\notes',
        kind: 'markdown',
        language: 'markdown',
        content: '# 指南',
        encoding: 'utf8',
        eol: 'lf',
        size: 10,
        mtime: 1,
        readonly: false,
      },
    });

    await openDocument(mdPath);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(useLayoutStore.getState().explorerVisible).toBe(true);
    expect(useExplorerStore.getState().root).toBe('C:\\notes');
  });

  it('开启“左侧栏自动关闭”后，启动时收起左侧栏且开关打开立即收起', async () => {
    const enabled = structuredClone(DEFAULT_SETTINGS);
    enabled.layout.autoCloseExplorer = true;
    mocks.loadSettings.mockResolvedValue(enabled);

    await useSettingsStore.getState().init();
    expect(useLayoutStore.getState().explorerVisible).toBe(false);

    // 模拟其它入口将侧栏展开后，在设置中开启或跨窗口同步开启时立即收起
    useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    useLayoutStore.getState().setExplorerVisible(true);
    await useSettingsStore.getState().setLayout({ autoCloseExplorer: true });
    expect(useLayoutStore.getState().explorerVisible).toBe(false);

    useLayoutStore.getState().setExplorerVisible(true);
    useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    const remote = structuredClone(DEFAULT_SETTINGS);
    remote.revision = 9;
    remote.layout.autoCloseExplorer = true;
    useSettingsStore.getState()._applyRemoteUpdate(remote);
    expect(useLayoutStore.getState().explorerVisible).toBe(false);
  });

  it('开启后打开文本、图片或不支持格式文件均不自动展开左侧栏', async () => {
    const enabled = structuredClone(DEFAULT_SETTINGS);
    enabled.layout.autoCloseExplorer = true;
    useSettingsStore.setState({ settings: enabled });
    useLayoutStore.getState().setExplorerVisible(false);

    const mdPath = 'C:\\notes\\alone.md';
    mocks.prepareDocument.mockResolvedValueOnce({
      type: 'text',
      payload: {
        key: mdPath,
        displayName: 'alone.md',
        dirPath: 'C:\\notes',
        kind: 'markdown',
        language: 'markdown',
        content: '正文',
        encoding: 'utf8',
        eol: 'lf',
        size: 6,
        mtime: 1,
        readonly: false,
      },
    });
    await openDocument(mdPath);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(useLayoutStore.getState().explorerVisible).toBe(false);
    expect(useWindowStore.getState().activeKey).toBe(mdPath);

    const imgPath = 'C:\\notes\\pic.png';
    mocks.prepareDocument.mockResolvedValueOnce({
      type: 'image',
      key: imgPath,
      displayName: 'pic.png',
      dirPath: 'C:\\notes',
      language: 'plaintext',
      size: 128,
      mtime: 1,
    });
    await openDocument(imgPath);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(useLayoutStore.getState().explorerVisible).toBe(false);

    const binPath = 'C:\\notes\\raw.bin';
    mocks.prepareDocument.mockResolvedValueOnce({
      type: 'unsupported',
      key: binPath,
      displayName: 'raw.bin',
      dirPath: 'C:\\notes',
      language: 'plaintext',
      size: 256,
    });
    await openDocument(binPath);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(useLayoutStore.getState().explorerVisible).toBe(false);
  });

  it('开启后选择打开文件夹、拖入文件夹或打开暂存区时仍会展开左侧栏', async () => {
    const enabled = structuredClone(DEFAULT_SETTINGS);
    enabled.layout.autoCloseExplorer = true;
    useSettingsStore.setState({ settings: enabled });

    // 1. 系统选择器打开文件夹
    useLayoutStore.getState().setExplorerVisible(false);
    mocks.dialogOpen.mockResolvedValueOnce('C:\\workspace\\folder-a');
    await openFolderDialog();
    expect(useLayoutStore.getState().explorerVisible).toBe(true);
    expect(useExplorerStore.getState().root).toBe('C:\\workspace\\folder-a');

    // 2. 在已展开的文件树内继续打开文件，不会意外关闭用户主动打开的侧栏
    mocks.prepareDocument.mockResolvedValueOnce({
      type: 'text',
      payload: {
        key: 'C:\\workspace\\folder-a\\doc.md',
        displayName: 'doc.md',
        dirPath: 'C:\\workspace\\folder-a',
        kind: 'markdown',
        language: 'markdown',
        content: '# doc',
        encoding: 'utf8',
        eol: 'lf',
        size: 5,
        mtime: 1,
        readonly: false,
      },
    });
    await openDocument('C:\\workspace\\folder-a\\doc.md');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(useLayoutStore.getState().explorerVisible).toBe(true);

    // 3. 本地搜索等入口打开文件夹
    useLayoutStore.getState().setExplorerVisible(false);
    await openFolderInExplorer('C:\\workspace\\folder-b');
    expect(useLayoutStore.getState().explorerVisible).toBe(true);
    expect(useExplorerStore.getState().root).toBe('C:\\workspace\\folder-b');

    // 4. 打开暂存区
    useLayoutStore.getState().setExplorerVisible(false);
    mocks.ensureStagingDirectory.mockResolvedValueOnce('C:\\staging');
    await openStagingArea();
    expect(useLayoutStore.getState().explorerVisible).toBe(true);
    expect(useExplorerStore.getState().root).toBe('C:\\staging');

    // 5. 拖入/打开目录
    useLayoutStore.getState().setExplorerVisible(false);
    mocks.prepareDocument.mockResolvedValueOnce({ type: 'directory', path: 'C:\\workspace\\folder-c' });
    await openDocument('C:\\workspace\\folder-c');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(useLayoutStore.getState().explorerVisible).toBe(true);
    expect(useExplorerStore.getState().root).toBe('C:\\workspace\\folder-c');

    // 6. 打开同步文件夹
    useLayoutStore.getState().setExplorerVisible(false);
    useSyncStore.setState({
      config: {
        version: 1,
        deviceId: 'test',
        sync: {
          enabled: false,
          rootDir: 'C:\\sync-notes',
          deviceName: 'test',
          provider: {} as never,
          syncOnSave: true,
          intervalEnabled: false,
          intervalMinutes: 5,
          syncOnStartup: false,
          notifyNoChange: false,
          trashEnabled: true,
          trashDays: 30,
        },
        backup: {
          autoEnabled: false,
          intervalHours: 24,
          keepCount: 10,
          target: 'local',
          localDir: '',
          provider: {} as never,
        },
      },
    });
    await openSyncFolder();
    expect(useLayoutStore.getState().explorerVisible).toBe(true);
    expect(useExplorerStore.getState().root).toBe('C:\\sync-notes');
  });

  it('开启后启动恢复会话在 Home 不自动展开左侧栏；默认关闭时按快照恢复', async () => {
    const fileA = 'C:\\notes\\a.md';
    mocks.loadSession.mockResolvedValue({
      schemaVersion: 1,
      savedAt: Date.now(),
      windows: [{
        seq: 0,
        explorerRoot: '',
        layout: {
          explorerVisible: true,
          explorerWidth: 300,
          outlineVisible: false,
          outlineWidth: 240,
        },
        tabs: [{
          key: fileA,
          isPinned: false,
          viewMode: null,
          sourcePath: fileA,
          stagedPath: null,
          displayName: 'a.md',
        }],
        activeKey: fileA,
      }],
    });

    // 开启开关：停留在 Home，不恢复为展开状态，同时仍恢复侧栏宽度等布局参数
    const enabled = structuredClone(DEFAULT_SETTINGS);
    enabled.layout.autoCloseExplorer = true;
    useSettingsStore.setState({ settings: enabled });
    useLayoutStore.getState().setExplorerVisible(false);

    await restoreLastClosedWindow();
    expect(useLayoutStore.getState().explorerVisible).toBe(false);
    expect(useLayoutStore.getState().explorerWidth).toBe(300);

    // 关闭开关：恢复快照中记录的展开状态
    useWindowStore.setState({ tabs: [], activeKey: null });
    useDocumentStore.setState({ documents: new Map() });
    useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    useLayoutStore.getState().setExplorerVisible(false);

    await restoreLastClosedWindow();
    expect(useLayoutStore.getState().explorerVisible).toBe(true);
  });
});
