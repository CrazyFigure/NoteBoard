// 托盘退出回归：验证连点只执行一次关闭事务，并保留未保存确认、取消和失败重试入口。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// 仅替换原生窗口与持久化边界，关闭协调和文档/窗口状态使用真实实现。
const nativeWindow = vi.hoisted(() => ({
  label: 'nb-main',
  show: vi.fn(),
  unminimize: vi.fn(),
  setFocus: vi.fn(),
  hide: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => nativeWindow }));
vi.mock('@/core/ipc/commands', () => ({
  closeWindow: vi.fn(),
  unregisterDocument: vi.fn(),
  notifyHistoryDocumentClosed: vi.fn(),
}));
vi.mock('@/features/session/closedWindowSession', () => ({
  saveCurrentWindowSnapshot: vi.fn(),
  ensureWritableContent: vi.fn(),
}));
vi.mock('@/features/staging/stagingManager', () => ({
  stashPendingDocuments: vi.fn(),
  onDocumentSaved: vi.fn(),
}));
vi.mock('@/core/perf/reportWebSpans', () => ({ reportWebSpans: vi.fn() }));
vi.mock('@/stores/toastStore', () => ({ showToast: vi.fn() }));

import * as ipc from '@/core/ipc/commands';
import { reportWebSpans } from '@/core/perf/reportWebSpans';
import { saveCurrentWindowSnapshot } from '@/features/session/closedWindowSession';
import { stashPendingDocuments } from '@/features/staging/stagingManager';
import { performWindowClose, requestCurrentWindowClose } from '@/features/window/windowManager';
import { useDocumentStore } from '@/stores/documentStore';
import { showToast } from '@/stores/toastStore';
import { useWindowStore } from '@/stores/windowStore';

/** 可控异步边界，模拟磁盘暂存、会话快照或原生关闭尚未返回。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 建立真实未保存文档，确保测试经过实际关闭保护策略。 */
function openUnsavedDocument(): void {
  const key = 'untitled:markdown:tray-exit';
  useDocumentStore.getState().upsertFromPayload({
    key, displayName: '未命名.md', dirPath: '', kind: 'markdown', language: 'markdown',
    content: '需要保留的正文', encoding: 'utf8', eol: 'lf', size: 21, mtime: 0, readonly: false,
  });
  useWindowStore.getState().openTab({
    key, displayName: '未命名.md', path: null, kind: 'markdown', language: 'markdown',
    isDirty: true, isPreview: false, viewMode: 'visual', externalStatus: null, isDetached: false,
  });
}

describe('托盘退出与窗口关闭协调', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    nativeWindow.show.mockResolvedValue(undefined);
    nativeWindow.unminimize.mockResolvedValue(undefined);
    nativeWindow.setFocus.mockResolvedValue(undefined);
    vi.mocked(ipc.closeWindow).mockResolvedValue(undefined);
    vi.mocked(ipc.unregisterDocument).mockResolvedValue(undefined);
    vi.mocked(saveCurrentWindowSnapshot).mockResolvedValue(true);
    vi.mocked(stashPendingDocuments).mockResolvedValue([]);
    vi.mocked(reportWebSpans).mockResolvedValue(undefined);
    useWindowStore.setState({
      tabs: [], activeKey: null, pendingCloseKeys: [], isWindowClosing: false, transferringKeys: [],
    });
    useDocumentStore.setState({ documents: new Map() });
  });

  it('干净窗口连点退出时只保存一次快照并关闭一次', async () => {
    const snapshot = deferred<boolean>();
    vi.mocked(saveCurrentWindowSnapshot).mockReturnValue(snapshot.promise);
    const requests = Array.from({ length: 20 }, () => requestCurrentWindowClose());
    expect(saveCurrentWindowSnapshot).toHaveBeenCalledTimes(1);
    expect(ipc.closeWindow).not.toHaveBeenCalled();

    snapshot.resolve(true);
    await Promise.all(requests);
    expect(ipc.closeWindow).toHaveBeenCalledExactlyOnceWith('nb-main');
    expect(reportWebSpans).toHaveBeenCalledTimes(1);
  });

  it('未保存窗口在暂存期间连点退出，只恢复和暂存一次，等待用户确认', async () => {
    openUnsavedDocument();
    const staging = deferred<Awaited<ReturnType<typeof stashPendingDocuments>>>();
    vi.mocked(stashPendingDocuments).mockReturnValue(staging.promise);
    const requests = Array.from({ length: 20 }, () => requestCurrentWindowClose());
    await vi.waitFor(() => expect(stashPendingDocuments).toHaveBeenCalledTimes(1));
    expect(nativeWindow.show).toHaveBeenCalledTimes(1);
    expect(nativeWindow.unminimize).toHaveBeenCalledTimes(1);
    expect(nativeWindow.setFocus).toHaveBeenCalledTimes(1);

    staging.resolve([]);
    await Promise.all(requests);
    expect(useWindowStore.getState().isWindowClosing).toBe(true);
    expect(useWindowStore.getState().pendingCloseKeys).toEqual(['untitled:markdown:tray-exit']);
    expect(useDocumentStore.getState().getDocument('untitled:markdown:tray-exit')?.content)
      .toBe('需要保留的正文');
    expect(ipc.closeWindow).not.toHaveBeenCalled();
  });

  it('确认框已打开时再次退出只恢复窗口，取消后仍可重新请求关闭', async () => {
    openUnsavedDocument();
    await requestCurrentWindowClose();
    await requestCurrentWindowClose();
    expect(nativeWindow.show).toHaveBeenCalledTimes(2);
    expect(stashPendingDocuments).toHaveBeenCalledTimes(1);
    expect(ipc.closeWindow).not.toHaveBeenCalled();

    useWindowStore.getState().clearPendingClose();
    await requestCurrentWindowClose();
    expect(stashPendingDocuments).toHaveBeenCalledTimes(2);
    expect(useWindowStore.getState().isWindowClosing).toBe(true);
  });

  it('确认后的实际关闭尚未返回时，托盘退出和重复确认复用同一事务', async () => {
    const closing = deferred<void>();
    vi.mocked(ipc.closeWindow).mockReturnValue(closing.promise);
    const first = performWindowClose('nb-main', true);
    await vi.waitFor(() => expect(ipc.closeWindow).toHaveBeenCalledTimes(1));
    const repeated = performWindowClose('nb-main', true);
    const trayRequest = requestCurrentWindowClose();
    closing.resolve(undefined);
    await Promise.all([first, repeated, trayRequest]);
    expect(ipc.closeWindow).toHaveBeenCalledTimes(1);
    expect(saveCurrentWindowSnapshot).not.toHaveBeenCalled();
    expect(reportWebSpans).toHaveBeenCalledTimes(1);
  });

  it('原生关闭失败时提示错误并允许再次退出', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.mocked(ipc.closeWindow).mockRejectedValueOnce(new Error('原生关闭失败'));
      await requestCurrentWindowClose();
      expect(showToast).toHaveBeenCalledWith('关闭窗口失败，请重试', 'error');
      await requestCurrentWindowClose();
      expect(ipc.closeWindow).toHaveBeenCalledTimes(2);
    } finally {
      errorLog.mockRestore();
    }
  });
});
