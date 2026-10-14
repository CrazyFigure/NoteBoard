// NoteBoard 最近关闭窗口快照持久化测试
// 覆盖判定：运行期间增量写入（更新/崩溃/结束进程不丢标签）、启动恢复阶段前不写、
//           切换激活标签不写盘、关闭冻结、启动恢复条件、双击启动时恢复标签排在前面、
//           从暂存副本恢复的未命名标签不会被暂存清理删掉自身副本。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startClosedWindowSessionTracker,
  markStartupRestoreSettled,
  saveCurrentWindowSnapshot,
  shouldRestoreOnStartup,
  restoreLastClosedWindow,
} from '@/features/session/closedWindowSession';
import {
  registerRestoredStagedPath,
  stashPendingDocuments,
  getStagedPath,
} from '@/features/staging/stagingManager';
import * as ipc from '@/core/ipc/commands';
import type { SessionSnapshot } from '@/core/ipc/types';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore, type Tab } from '@/stores/windowStore';
import { useSettingsStore } from '@/stores/settingsStore';

vi.mock('@/features/editor-code/orchestration/openDocument', () => ({
  openDocument: vi.fn().mockResolvedValue('opened'),
}));

vi.mock('@/core/ipc/commands', () => ({
  loadSession: vi.fn(),
  saveSession: vi.fn().mockResolvedValue(undefined),
  clearSession: vi.fn().mockResolvedValue(undefined),
  pathExists: vi.fn(),
  readDir: vi.fn().mockResolvedValue([]),
  stashDocuments: vi.fn().mockResolvedValue([]),
  deleteStagedFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'nb-main' }),
}));

const KEY_A = 'C:\\t\\a.md';
const KEY_B = 'C:\\t\\b.md';
const KEY_D = 'C:\\t\\d.md';

function namedTab(key: string): Tab {
  return {
    key,
    displayName: key.split('\\').pop() ?? key,
    path: key,
    kind: 'markdown',
    language: 'markdown',
    isDirty: false,
    isPreview: false,
    viewMode: null,
    externalStatus: null,
    isDetached: false,
  };
}

function setRestoreSession(enabled: boolean): void {
  const settings = useSettingsStore.getState().settings;
  useSettingsStore.setState({ settings: { ...settings, file: { ...settings.file, restoreSession: enabled } } });
}

/** 最近一次 saveSession 写入的标签 key 列表 */
function lastSavedKeys(): string[] {
  const calls = vi.mocked(ipc.saveSession).mock.calls;
  const snapshot = calls[calls.length - 1]?.[0] as SessionSnapshot | undefined;
  return snapshot?.windows[0]?.tabs.map((tab) => tab.key) ?? [];
}

describe('最近关闭窗口快照增量持久化', () => {
  let stopTracker: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setRestoreSession(true);
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
    stopTracker = startClosedWindowSessionTracker();
  });

  afterEach(() => {
    stopTracker();
    vi.useRealTimers();
  });

  it('启动恢复阶段结束前不写；之后标签变化防抖写入（更新/崩溃时也能恢复）', async () => {
    useWindowStore.getState().openTab(namedTab(KEY_A));
    await vi.advanceTimersByTimeAsync(2_000);
    // 恢复阶段尚未结束：显式打开的文件不得抢先覆盖待恢复的旧快照
    expect(ipc.saveSession).not.toHaveBeenCalled();

    markStartupRestoreSettled();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(ipc.saveSession).toHaveBeenCalledTimes(1);
    expect(lastSavedKeys()).toEqual([KEY_A]);

    useWindowStore.getState().openTab(namedTab(KEY_B));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(ipc.saveSession).toHaveBeenCalledTimes(2);
    expect(lastSavedKeys()).toEqual([KEY_A, KEY_B]);
  });

  it('只切换激活标签不重复写盘', async () => {
    useWindowStore.setState({ tabs: [namedTab(KEY_A), namedTab(KEY_B)], activeKey: KEY_A });
    markStartupRestoreSettled();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(ipc.saveSession).toHaveBeenCalledTimes(1);

    useWindowStore.getState().activateTab(KEY_B);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(ipc.saveSession).toHaveBeenCalledTimes(1);
  });

  it('关闭“恢复会话”设置时不写', async () => {
    setRestoreSession(false);
    markStartupRestoreSettled();
    useWindowStore.getState().openTab(namedTab(KEY_A));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(ipc.saveSession).not.toHaveBeenCalled();
    expect(ipc.clearSession).not.toHaveBeenCalled();
  });

  it('窗口最终关闭写入后冻结：关闭流程移除标签不会清空快照', async () => {
    useWindowStore.setState({ tabs: [namedTab(KEY_A), namedTab(KEY_B)], activeKey: KEY_A });
    markStartupRestoreSettled();
    await vi.advanceTimersByTimeAsync(1_100);
    vi.mocked(ipc.saveSession).mockClear();

    await saveCurrentWindowSnapshot();
    expect(ipc.saveSession).toHaveBeenCalledTimes(1);
    expect(lastSavedKeys()).toEqual([KEY_A, KEY_B]);

    // 关闭流程技术性移除标签
    useWindowStore.setState({ tabs: [], activeKey: null });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(ipc.saveSession).toHaveBeenCalledTimes(1);
    expect(ipc.clearSession).not.toHaveBeenCalled();
  });

  it('文本对比等工具视图不进入快照', async () => {
    const diffTab: Tab = { ...namedTab('untitled:textdiff:1'), path: null, toolKind: 'textdiff' };
    useWindowStore.setState({ tabs: [namedTab(KEY_A), diffTab], activeKey: KEY_A });
    await saveCurrentWindowSnapshot();
    expect(lastSavedKeys()).toEqual([KEY_A]);
  });

  it('双击文件冷启动：恢复上次标签并排在显式打开的文件之前，改写快照包含两者', async () => {
    // 显式打开的文件已在标签栏（激活）
    useWindowStore.setState({ tabs: [namedTab(KEY_D)], activeKey: KEY_D });
    vi.mocked(ipc.loadSession).mockResolvedValue({
      schemaVersion: 1,
      savedAt: Date.now(),
      windows: [{
        seq: 0,
        explorerRoot: '',
        layout: { explorerVisible: true, explorerWidth: 260, outlineVisible: false, outlineWidth: 240 },
        tabs: [KEY_A, KEY_B].map((key) => ({
          key,
          isPinned: false,
          viewMode: null,
          sourcePath: key,
          stagedPath: null,
          displayName: key.split('\\').pop() ?? key,
        })),
        activeKey: KEY_A,
      }],
    });
    vi.mocked(ipc.pathExists).mockResolvedValue({ exists: true, isDir: false });

    await restoreLastClosedWindow();

    expect(useWindowStore.getState().tabs.map((tab) => tab.key)).toEqual([KEY_A, KEY_B, KEY_D]);
    expect(useWindowStore.getState().activeKey).toBe(KEY_D);
    expect(lastSavedKeys()).toEqual([KEY_A, KEY_B, KEY_D]);
  });
});

describe('启动恢复条件', () => {
  beforeEach(() => setRestoreSession(true));

  it('唯一存活窗口的空启动与双击文件冷启动都恢复', () => {
    expect(shouldRestoreOnStartup({ startupMode: 'empty', isSoleWindow: true })).toBe(true);
    expect(shouldRestoreOnStartup({ startupMode: 'explicit-open', isSoleWindow: true })).toBe(true);
    // 旧握手未携带字段时按唯一窗口处理
    expect(shouldRestoreOnStartup({ startupMode: 'empty' })).toBe(true);
  });

  it('新建窗口（已有存活窗口）、迁移窗口、关闭设置时不恢复', () => {
    expect(shouldRestoreOnStartup({ startupMode: 'empty', isSoleWindow: false })).toBe(false);
    expect(shouldRestoreOnStartup({ startupMode: 'handoff', isSoleWindow: true })).toBe(false);
    setRestoreSession(false);
    expect(shouldRestoreOnStartup({ startupMode: 'empty', isSoleWindow: true })).toBe(false);
  });
});

describe('从暂存副本恢复的未命名标签', () => {
  const STAGED = 'C:\\staging\\20261012-091822-001-未命名.md';

  beforeEach(() => {
    vi.clearAllMocks();
    useDocumentStore.setState({ documents: new Map() });
  });

  it('加载后脏态被清除（如可视化模式确认内容未变），暂存清理不得删除标签正在显示的副本', async () => {
    // 恢复链：key 即暂存副本路径、无原路径，登记暂存记录
    registerRestoredStagedPath(STAGED, STAGED);
    useDocumentStore.getState().upsertFromPayload({
      key: STAGED,
      displayName: '未命名.md',
      dirPath: 'C:\\staging',
      kind: 'markdown',
      language: 'markdown',
      content: '草稿内容',
      encoding: 'utf8',
      eol: 'lf',
      size: 4,
      mtime: 0,
      readonly: false,
    });
    useWindowStore.setState({
      tabs: [{ ...namedTab(STAGED), path: null, isDirty: false }],
      activeKey: STAGED,
      transferringKeys: [],
    });

    await stashPendingDocuments();

    expect(ipc.deleteStagedFile).not.toHaveBeenCalledWith(STAGED);
    // 暂存记录保留：下次关闭/增量快照仍能写出 stagedPath，重启后可再次恢复
    expect(getStagedPath(STAGED)).toBe(STAGED);
  });
});
