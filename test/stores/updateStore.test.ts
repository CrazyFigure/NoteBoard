// NoteBoard 更新 Store 单元测试
// 验证静默检查、主动检查、红点标记以及弹窗开关状态

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useUpdateStore } from '../../src/stores/updateStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../src/stores/settingsStore';
import type { UpdateCheckResult } from '../../src/core/ipc/types';
import * as ipc from '../../src/core/ipc/commands';

// Mock ipc 命令模块
vi.mock('../../src/core/ipc/commands', () => ({
  checkForUpdates: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  openExternalUrl: vi.fn(),
  saveSettings: vi.fn(),
}));

describe('useUpdateStore 状态管理与检查逻辑', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(ipc.saveSettings).mockResolvedValue(1);
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
    useUpdateStore.setState({
      checking: false,
      hasUpdate: false,
      updateResult: null,
      checkError: null,
      modalOpen: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('主动检查更新：发现新版本时应打开弹窗并标记 hasUpdate = true', async () => {
    vi.mocked(ipc.checkForUpdates).mockResolvedValueOnce({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      releaseUrl: 'https://github.com/CrazyFigure/NoteBoard/releases',
    });

    const promise = useUpdateStore.getState().checkForUpdates(false);
    expect(useUpdateStore.getState().modalOpen).toBe(true);
    expect(useUpdateStore.getState().checking).toBe(true);

    await promise;

    const state = useUpdateStore.getState();
    expect(state.checking).toBe(false);
    expect(state.hasUpdate).toBe(true);
    expect(state.updateResult?.latestVersion).toBe('0.2.0');
    expect(state.checkError).toBeNull();
    expect(ipc.checkForUpdates).toHaveBeenCalledExactlyOnceWith('github');
    expect(ipc.saveSettings).not.toHaveBeenCalled();
  });

  it('静默检查更新：发现新版本时只标记 hasUpdate = true，不主动弹窗', async () => {
    vi.mocked(ipc.checkForUpdates).mockResolvedValueOnce({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      releaseUrl: 'https://github.com/CrazyFigure/NoteBoard/releases',
    });

    await useUpdateStore.getState().checkForUpdates(true);

    const state = useUpdateStore.getState();
    expect(state.modalOpen).toBe(false);
    expect(state.hasUpdate).toBe(true);
    expect(state.updateResult?.latestVersion).toBe('0.2.0');
  });

  it('静默检查更新：无新版本时 hasUpdate 应为 false 且不弹窗', async () => {
    vi.mocked(ipc.checkForUpdates).mockResolvedValueOnce({
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      updateAvailable: false,
      releaseUrl: 'https://github.com/CrazyFigure/NoteBoard/releases',
    });

    await useUpdateStore.getState().checkForUpdates(true);

    const state = useUpdateStore.getState();
    expect(state.modalOpen).toBe(false);
    expect(state.hasUpdate).toBe(false);
  });

  it('主动检查失败：应记录错误提示并展示在弹窗中', async () => {
    vi.mocked(ipc.checkForUpdates).mockRejectedValue(
      new Error('update_error:network:Connection timed out')
    );

    await useUpdateStore.getState().checkForUpdates(false);

    const state = useUpdateStore.getState();
    expect(state.modalOpen).toBe(true);
    expect(state.checking).toBe(false);
    expect(state.checkError).toContain('网络连接失败');
    expect(state.checkError).toContain('GitHub');
    expect(state.checkError).toContain('腾讯云 CNB');
    expect(ipc.checkForUpdates).toHaveBeenNthCalledWith(1, 'github');
    expect(ipc.checkForUpdates).toHaveBeenNthCalledWith(2, 'cnb');
    expect(ipc.saveSettings).not.toHaveBeenCalled();
  });

  it.each([false, true])('GitHub 失败后回退 CNB 并保存下载渠道，静默模式为 %s', async (silent) => {
    const result: UpdateCheckResult = {
      currentVersion: '0.1.0', latestVersion: '0.2.0', updateAvailable: true,
      releaseUrl: 'https://cnb.cool/crazy-figure/NoteBoard/-/releases/tag/v0.2.0',
      installerDownloadUrl: 'https://cnb.cool/crazy-figure/NoteBoard/-/releases/download/v0.2.0/setup.exe',
    };
    vi.mocked(ipc.checkForUpdates)
      .mockRejectedValueOnce(new Error('update_error:forbidden'))
      .mockResolvedValueOnce(result);

    await useUpdateStore.getState().checkForUpdates(silent);

    expect(vi.mocked(ipc.checkForUpdates).mock.calls).toEqual([['github'], ['cnb']]);
    expect(useSettingsStore.getState().settings.system?.updateChannel).toBe('cnb');
    expect(ipc.saveSettings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      system: expect.objectContaining({ updateChannel: 'cnb' }),
    }));
    expect(useUpdateStore.getState()).toMatchObject({
      checking: false, checkError: null, hasUpdate: true, updateResult: result, modalOpen: !silent,
    });
  });

  it.each([false, true])('原渠道为 CNB 时仍优先 GitHub，无新版本也保存 GitHub，静默模式为 %s', async (silent) => {
    useSettingsStore.setState({ settings: {
      ...DEFAULT_SETTINGS, system: { ...DEFAULT_SETTINGS.system, updateChannel: 'cnb' },
    } });
    vi.mocked(ipc.checkForUpdates).mockResolvedValueOnce({
      currentVersion: '0.1.0', latestVersion: '0.1.0', updateAvailable: false,
      releaseUrl: 'https://github.com/CrazyFigure/NoteBoard/releases',
    });

    await useUpdateStore.getState().checkForUpdates(silent);

    expect(ipc.checkForUpdates).toHaveBeenCalledExactlyOnceWith('github');
    expect(useSettingsStore.getState().settings.system?.updateChannel).toBe('github');
    expect(ipc.saveSettings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      system: expect.objectContaining({ updateChannel: 'github' }),
    }));
    expect(useUpdateStore.getState().hasUpdate).toBe(false);
  });

  it('探测结束前保留原渠道，重复检测不会启动额外请求', async () => {
    let rejectGithub!: (reason: Error) => void;
    vi.mocked(ipc.checkForUpdates)
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectGithub = reject; }))
      .mockResolvedValueOnce({
        currentVersion: '0.1.0', latestVersion: '0.1.0', updateAvailable: false, releaseUrl: '',
      });
    const pending = useUpdateStore.getState().checkForUpdates(false);
    await useUpdateStore.getState().checkForUpdates(true);
    expect(ipc.checkForUpdates).toHaveBeenCalledExactlyOnceWith('github');
    expect(ipc.saveSettings).not.toHaveBeenCalled();
    rejectGithub(new Error('update_error:network:超时'));
    await pending;
    expect(useSettingsStore.getState().settings.system?.updateChannel).toBe('cnb');
  });

  it('两个渠道静默检测均失败时保留原设置和已有更新提醒', async () => {
    useSettingsStore.setState({ settings: {
      ...DEFAULT_SETTINGS, system: { ...DEFAULT_SETTINGS.system, updateChannel: 'cnb' },
    } });
    useUpdateStore.setState({ hasUpdate: true });
    vi.mocked(ipc.checkForUpdates).mockRejectedValue(new Error('update_error:http_status:503'));

    await useUpdateStore.getState().checkForUpdates(true);

    expect(vi.mocked(ipc.checkForUpdates).mock.calls).toEqual([['github'], ['cnb']]);
    expect(ipc.saveSettings).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().settings.system?.updateChannel).toBe('cnb');
    expect(useUpdateStore.getState()).toMatchObject({
      checking: false, modalOpen: false, checkError: null, hasUpdate: true,
    });
  });

  it('启动和定时自动检测都优先 GitHub，恢复可用后从 CNB 切回 GitHub', async () => {
    vi.useFakeTimers();
    const result: UpdateCheckResult = {
      currentVersion: '0.1.0', latestVersion: '0.1.0', updateAvailable: false, releaseUrl: '',
    };
    vi.mocked(ipc.checkForUpdates)
      .mockRejectedValueOnce(new Error('update_error:network:超时'))
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce(result);
    const stop = useUpdateStore.getState().initAutoUpdateTimer();

    await vi.advanceTimersByTimeAsync(3000);
    expect(useSettingsStore.getState().settings.system?.updateChannel).toBe('cnb');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 3000);
    expect(vi.mocked(ipc.checkForUpdates).mock.calls).toEqual([['github'], ['cnb'], ['github']]);
    expect(useSettingsStore.getState().settings.system?.updateChannel).toBe('github');
    expect(useUpdateStore.getState().modalOpen).toBe(false);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('openModal 与 closeModal 能正常切换弹窗显示状态', () => {
    const { openModal, closeModal } = useUpdateStore.getState();
    openModal();
    expect(useUpdateStore.getState().modalOpen).toBe(true);
    closeModal();
    expect(useUpdateStore.getState().modalOpen).toBe(false);
  });
});
