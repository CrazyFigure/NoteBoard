// 同名更新必须由用户明确决定；验证方向展示、默认焦点、取消、重复点击和错误重试。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../src/components/Tooltip';
import { SyncUpdateDialog } from '../../src/features/sync/SyncUpdateDialog';
import * as ipc from '../../src/core/ipc/commands';
import { useSyncStore } from '../../src/stores/syncStore';
import type { SyncStatus } from '../../src/core/ipc/types';

/** 后台产生的两个方向，使用稳定时间，避免依赖系统时钟。 */
function status(): SyncStatus {
  return {
    syncing: false, backingUp: false, lastSync: null, lastBackup: null, nextSyncAt: 0, nextBackupAt: 0, syncPaused: true,
    updateConfirmation: { id: 'confirmation-id', files: [
      { path: '项目/本机较新.md', direction: 'upload', localMtime: 1792886460000, remoteMtime: 1792886400000, localSize: 1024, remoteSize: 900, fingerprint: 'up' },
      { path: '远端较新.md', direction: 'download', localMtime: 1792886400000, remoteMtime: 1792886460000, localSize: 900, remoteSize: 1024, fingerprint: 'down' },
    ] },
  };
}

describe('同步文件更新确认', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useSyncStore.setState({ status: status() });
    vi.spyOn(ipc, 'syncResolveUpdates').mockResolvedValue(undefined);
    vi.spyOn(ipc, 'syncGetStatus').mockResolvedValue({ ...status(), updateConfirmation: null });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<TooltipProvider><SyncUpdateDialog /></TooltipProvider>));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useSyncStore.setState({ status: null });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const button = (label: string) => Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label)!;

  it('展示内容不同的文件、两端时间和更新方向，默认聚焦取消', () => {
    expect(host.textContent).toContain('项目/本机较新.md');
    expect(host.textContent).toContain('本机 → 远端');
    expect(host.textContent).toContain('远端 → 本机');
    expect(host.textContent).not.toContain('覆盖');
    expect(document.activeElement).toBe(button('暂不同步'));
    expect(ipc.syncResolveUpdates).not.toHaveBeenCalled();
  });
  it('确认调用一次性接口，快速重复点击只执行一次', async () => {
    await act(async () => { button('确认更新并同步').click(); button('确认更新并同步').click(); });
    expect(ipc.syncResolveUpdates).toHaveBeenCalledExactlyOnceWith('confirmation-id', true);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it('Escape 取消并暂停，不自动批准更新', async () => {
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(ipc.syncResolveUpdates).toHaveBeenCalledExactlyOnceWith('confirmation-id', false);
  });
  it('失败时保留文件列表并允许重试', async () => {
    vi.mocked(ipc.syncResolveUpdates).mockRejectedValueOnce(new Error('网络暂不可用'));
    await act(async () => button('确认更新并同步').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('网络暂不可用');
    expect(button('确认更新并同步').disabled).toBe(false);
    await act(async () => button('确认更新并同步').click());
    expect(ipc.syncResolveUpdates).toHaveBeenCalledTimes(2);
  });

  it('旧决定返回时不能清除后台新推送的确认列表', async () => {
    let finish!: () => void;
    vi.mocked(ipc.syncResolveUpdates).mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    act(() => button('确认更新并同步').click());
    const next = status();
    next.updateConfirmation!.id = 'new-confirmation';
    act(() => useSyncStore.setState({ status: next }));
    await act(async () => finish());
    expect(useSyncStore.getState().status?.updateConfirmation?.id).toBe('new-confirmation');
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
