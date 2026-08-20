// NoteBoard 更新 Store 单元测试
// 验证静默检查、主动检查、红点标记以及弹窗开关状态

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useUpdateStore } from '../../src/stores/updateStore';
import * as ipc from '../../src/core/ipc/commands';

// Mock ipc 命令模块
vi.mock('../../src/core/ipc/commands', () => ({
  checkForUpdates: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  openExternalUrl: vi.fn(),
}));

describe('useUpdateStore 状态管理与检查逻辑', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(ipc.checkForUpdates).mockRejectedValueOnce(
      new Error('update_error:network:Connection timed out')
    );

    await useUpdateStore.getState().checkForUpdates(false);

    const state = useUpdateStore.getState();
    expect(state.modalOpen).toBe(true);
    expect(state.checking).toBe(false);
    expect(state.checkError).toContain('网络连接失败');
  });

  it('openModal 与 closeModal 能正常切换弹窗显示状态', () => {
    const { openModal, closeModal } = useUpdateStore.getState();
    openModal();
    expect(useUpdateStore.getState().modalOpen).toBe(true);
    closeModal();
    expect(useUpdateStore.getState().modalOpen).toBe(false);
  });
});
