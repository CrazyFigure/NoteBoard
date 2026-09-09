// NoteBoard 🔴 N01 迁移终态判别测试
// 覆盖：超时 abort 返回 committed（抢占失败按提交处理）、abort 失败后二次查询
//       committed/失败、双方查询失败（unknown 保守：保留数据且保持迁移保护）、
//       committed/aborted 事件驱动收尾。断言正文、所有权调用与迁移保护状态。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '@/core/ipc/commands';

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-src' }) }));
vi.mock('@/core/ipc/events', () => ({
  onTransferCommitted: vi.fn().mockResolvedValue(() => {}),
  onTransferAborted: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock('@/core/ipc/commands', () => ({
  beginDocumentTransfer: vi.fn().mockResolvedValue({ transferId: 'tx-1', targetLabel: 'nb-tgt' }),
  queryTransfer: vi.fn(),
  abortTransfer: vi.fn(),
  unregisterDocument: vi.fn().mockResolvedValue(undefined),
  readDocument: vi.fn(),
  readDir: vi.fn().mockResolvedValue([]),
  pathExists: vi.fn(),
}));
// 依赖边界替身（正文出口屏障按已加载返回真实镜像内容）
vi.mock('@/features/session/closedWindowSession', async () => {
  const actual = await vi.importActual<typeof import('@/features/session/closedWindowSession')>(
    '@/features/session/closedWindowSession',
  );
  return {
    ...actual,
    ensureWritableContent: async (key: string) => {
      const { useDocumentStore } = await import('@/stores/documentStore');
      return useDocumentStore.getState().getDocument(key)?.content ?? null;
    },
  };
});
vi.mock('@/features/staging/stagingManager', () => ({
  onDocumentSaved: vi.fn().mockResolvedValue(undefined),
  stashPendingDocuments: vi.fn(),
  getStagedPath: vi.fn(),
  registerRestoredStagedPath: vi.fn(),
}));
vi.mock('@/features/explorer/directoryWatcher', () => ({ noteSelfWrite: vi.fn() }));

import { moveToNewWindow } from '@/features/window/windowManager';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { resetEditorRegistryForTest } from '@/core/editor/editorRegistry';

const KEY = 'C:\\t\\transfer.md';

function seed(content: string): void {
  useDocumentStore.getState().upsertFromPayload({
    key: KEY, displayName: 'transfer.md', dirPath: 'C:\\t', kind: 'markdown',
    language: 'markdown', content, encoding: 'utf8', eol: 'lf', size: content.length,
    mtime: 1, readonly: false,
  });
  useDocumentStore.getState().updateBaseline(KEY, content, 1, content.length);
  useWindowStore.getState().openTab({
    key: KEY, displayName: 'transfer.md', path: KEY, kind: 'markdown', language: 'markdown',
    isDirty: true, isPreview: false, viewMode: 'visual', externalStatus: null, isDetached: false,
  });
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

describe('🔴 N01 迁移终态判别（waitForTransferOutcome）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [], pendingCloseKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
    resetEditorRegistryForTest();
  });
  afterEach(async () => {
    await settleMicrotasks();
    vi.useRealTimers();
  });

  it('超时 abort 被 committed 抢占拒绝（返回 committed）→ 按提交成功清理源', async () => {
    seed('only-copy');
    const pending = moveToNewWindow(KEY);
    await settleMicrotasks();
    // 超时：query 仍 preparing；abort 返回 committed（迁移已提交，中止失败）
    vi.mocked(ipc.queryTransfer).mockResolvedValue({ state: 'preparing', transferId: 'tx-1', key: KEY });
    vi.mocked(ipc.abortTransfer).mockResolvedValue({ state: 'committed', transferId: 'tx-1', key: KEY });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    // 🔴 以权威 committed 为准：源清理（不能因为"中止尝试"误删或误留）
    expect(result).toBe(true);
    expect(useDocumentStore.getState().getDocument(KEY)).toBeUndefined();
    expect(useWindowStore.getState().getTab(KEY)).toBeNull();
  });

  it('超时 abort IPC 失败 + 二次查询 committed → 按提交成功处理（不保守误判失败）', async () => {
    seed('only-copy');
    const pending = moveToNewWindow(KEY);
    await settleMicrotasks();
    vi.mocked(ipc.queryTransfer)
      .mockResolvedValueOnce({ state: 'preparing', transferId: 'tx-1', key: KEY })   // 超时首查：仍在准备
      .mockResolvedValueOnce({ state: 'committed', transferId: 'tx-1', key: KEY });  // abort 失败后的二次查询：已提交
    vi.mocked(ipc.abortTransfer).mockRejectedValue(new Error('IPC unavailable'));
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result).toBe(true);
    expect(useDocumentStore.getState().getDocument(KEY)).toBeUndefined();
  });

  it('双方查询失败（unknown）→ 保留正文与历史且保持迁移保护（源不恢复写入）', async () => {
    seed('only-copy');
    const pending = moveToNewWindow(KEY);
    await settleMicrotasks();
    vi.mocked(ipc.queryTransfer).mockRejectedValue(new Error('backend unreachable'));
    vi.mocked(ipc.abortTransfer).mockRejectedValue(new Error('backend unreachable'));
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    // 🔴 保守失败：返回 false、正文保留、迁移保护不解除（对账回调负责收尾）
    expect(result).toBe(false);
    expect(useDocumentStore.getState().getDocument(KEY)?.content).toBe('only-copy');
    expect(useWindowStore.getState().getTab(KEY)).not.toBeNull();
    expect(useWindowStore.getState().isTransferring(KEY)).toBe(true);
    // 权威 abort 事件迟到 → 对账解锁源恢复编辑
    vi.useRealTimers();
  });

  it('committed 事件驱动：无超时直接成功清理源（transferred 语义）', async () => {
    seed('only-copy');
    const pending = moveToNewWindow(KEY);
    await settleMicrotasks();
    // 事件到达（startEventListeners 注册的处理器在此模拟直达）
    const { pendingTransferWaitsForTest } = await import('@/features/window/windowManager');
    pendingTransferWaitsForTest().get('tx-1')?.('committed');
    const result = await pending;
    expect(result).toBe(true);
    expect(useDocumentStore.getState().getDocument(KEY)).toBeUndefined();
    expect(useWindowStore.getState().getTab(KEY)).toBeNull();
    expect(useWindowStore.getState().isTransferring(KEY)).toBe(false);
  });

  it('aborted 事件驱动：源解锁且正文保留', async () => {
    seed('only-copy');
    const pending = moveToNewWindow(KEY);
    await settleMicrotasks();
    const { pendingTransferWaitsForTest } = await import('@/features/window/windowManager');
    pendingTransferWaitsForTest().get('tx-1')?.('aborted');
    const result = await pending;
    // 🔴 B08 核心断言：aborted 绝不能被当成 committed（布尔混淆）——
    //    源保留唯一未保存正文
    expect(result).toBe(false);
    expect(useDocumentStore.getState().getDocument(KEY)?.content).toBe('only-copy');
    expect(useWindowStore.getState().getTab(KEY)).not.toBeNull();
    expect(useWindowStore.getState().isTransferring(KEY)).toBe(false);
  });
});
