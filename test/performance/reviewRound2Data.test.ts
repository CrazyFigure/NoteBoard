// 二轮复审反例（B01–B08/B11，正式迁入）：保存、同路径重开和迁移使用真实编排，IPC 完全替换为内存桩。
// 断言来自《二轮复审意见与整改清单.md》，期望为整改后的正确行为；不随缺陷调整期望。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '@/core/ipc/commands';
import { save } from '@tauri-apps/plugin-dialog';
import { openDocument } from '@/features/editor-code/orchestration/openDocument';
import { saveDocument, saveAs } from '@/features/editor-code/orchestration/saveDocument';
import { syncDocumentContent } from '@/features/editor-code/orchestration/syncDocumentContent';
import { moveToNewWindow } from '@/features/window/windowManager';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore, type Tab } from '@/stores/windowStore';
import { registerEditorCapabilities, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { disposeDocumentSession, enqueueDocumentWrite, queuedAutoSave, writeDocumentWithBarrier } from '@/features/session/documentSession';
import { getBaseline } from '@/features/editor-md/serialize';

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-secondary' }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@/features/editor-code/orchestration/openDocument', () => ({ openDocument: vi.fn() }));
vi.mock('@/features/staging/stagingManager', () => ({ onDocumentSaved: vi.fn().mockResolvedValue(undefined), stashPendingDocuments: vi.fn(), getStagedPath: vi.fn() }));
vi.mock('@/features/explorer/directoryWatcher', () => ({ noteSelfWrite: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({
  writeDocument: vi.fn().mockResolvedValue({ ok: true, mtime: 1, size: 10 }),
  registerDocument: vi.fn().mockResolvedValue({ type: 'registered' }),
  unregisterDocument: vi.fn().mockResolvedValue(undefined),
  setDocumentDirty: vi.fn().mockResolvedValue(undefined),
  beginDocumentTransfer: vi.fn().mockResolvedValue({ transferId: 'round2-transfer', targetLabel: 'nb-target' }),
  queryTransfer: vi.fn().mockResolvedValue({ state: 'preparing' }),
  abortTransfer: vi.fn().mockResolvedValue({ state: 'aborted' }),
}));

// 每个反例使用不同的假路径，避免版本、队列或基线相互污染。
function seed(key: string, content: string | null, extra: Partial<Tab> = {}): void {
  useDocumentStore.getState().upsertFromPayload({ key, displayName: 'review.md', dirPath: 'C:/round2', kind: 'markdown', language: 'markdown', content, encoding: 'utf8', eol: 'lf', size: 10, mtime: 0, readonly: false });
  useWindowStore.getState().openTab({ key, displayName: 'review.md', path: key, kind: 'markdown', language: 'markdown', isDirty: false, isPreview: false, viewMode: 'visual', externalStatus: null, isDetached: false, ...extra });
  getBaseline(key).updateBaseline(content ?? 'disk-original');
}

// 把微任务推进到可观察状态，不访问文件系统或启动窗口。
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

describe('二轮复审：内容与生命周期', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [], pendingCloseKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
    resetEditorRegistryForTest();
    vi.mocked(ipc.registerDocument).mockResolvedValue({ type: 'registered' } as never);
  });
  afterEach(async () => { await settleMicrotasks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('B01：懒恢复读取失败后保存必须中止，不能写空串到原文件', async () => {
    const key = 'C:/round2/lazy-failure.md';
    seed(key, null, { lazySource: key });
    vi.mocked(openDocument).mockResolvedValue('failed');
    const result = await saveDocument(key);
    expect({ result, writes: vi.mocked(ipc.writeDocument).mock.calls }).toEqual({ result: false, writes: [] });
  });

  it('B02：另存为目标被另一窗口占用时必须在任何写盘前中止', async () => {
    const key = 'C:/round2/save-source.md';
    seed(key, 'source-text');
    vi.mocked(save).mockResolvedValue('C:/round2/occupied.md');
    vi.mocked(ipc.registerDocument).mockResolvedValue({ type: 'already-open', ownerLabel: 'nb-other' } as never);
    expect(await saveAs(key, 'source-text')).toBe(false);
    expect(ipc.writeDocument).not.toHaveBeenCalled();
  });

  it('B03：对话框期间用户清空正文，另存为必须保留这一合法编辑', async () => {
    const key = 'C:/round2/empty-edit-source.md';
    const target = 'C:/round2/empty-edit-target.md';
    seed(key, 'before-dialog');
    let liveText = 'before-dialog';
    registerEditorCapabilities({ docKey: key, instanceId: 'empty-edit', getRevision: () => 1, flush: async () => ({ docKey: key, instanceId: 'empty-edit', revision: 1, content: liveText }), focus() {}, getSelectedText: () => '', canSuspend: () => true });
    vi.mocked(save).mockImplementation(async () => {
      liveText = '';
      useDocumentStore.getState().setContent(key, '');
      return target;
    });
    expect(await saveAs(key, 'before-dialog')).toBe(true);
    expect(useDocumentStore.getState().getDocument(target)?.content).toBe('');
    expect(vi.mocked(ipc.writeDocument).mock.calls.at(-1)?.[1]).toBe('');
  });

  it('B04：同路径新会话的编辑器注册空窗不能接纳旧会话迟到快照', async () => {
    const key = 'C:/round2/reopen-gap.md';
    seed(key, 'old-base');
    let finishOld!: (value: never) => void;
    const unregister = registerEditorCapabilities({ docKey: key, instanceId: 'old-session', getRevision: () => 8, flush: () => new Promise(resolve => { finishOld = resolve; }), focus() {}, getSelectedText: () => '', canSuspend: () => true });
    const pending = syncDocumentContent(key);
    unregister();
    disposeDocumentSession(key);
    useDocumentStore.getState().remove(key);
    seed(key, 'new-session-content');
    finishOld({ docKey: key, instanceId: 'old-session', revision: 8, content: 'stale-old-content' } as never);
    await pending;
    expect(useDocumentStore.getState().getDocument(key)?.content).toBe('new-session-content');
  });

  it('B05：会话关闭重开后旧自动保存不得越过新会话写盘', async () => {
    const key = 'C:/round2/queued-reopen.md';
    seed(key, 'old-base');
    useDocumentStore.setState(state => ({ documents: new Map(state.documents).set(key, { ...state.documents.get(key)!, savePolicy: 'auto' }) }));
    let unblock!: () => void;
    const gate = enqueueDocumentWrite(key, () => new Promise<void>(resolve => { unblock = resolve; }));
    const oldSave = queuedAutoSave(key, 'old-queued-text');
    await settleMicrotasks();
    disposeDocumentSession(key);
    useDocumentStore.getState().remove(key);
    seed(key, 'new-session-text');
    useDocumentStore.setState(state => ({ documents: new Map(state.documents).set(key, { ...state.documents.get(key)!, savePolicy: 'auto' }) }));
    // 新会话写任务排队（N04 语义：串接在旧队列之后，不越过未完成的旧 I/O），
    // 但不在放行旧 I/O 前 await（那会循环等待）；行为断言不变——最终写盘只有新会话内容。
    const newWrite = writeDocumentWithBarrier(key, 'new-session-text');
    unblock();
    await Promise.all([gate, oldSave, newWrite]);
    expect(vi.mocked(ipc.writeDocument).mock.calls.map(call => call[1])).toEqual(['new-session-text']);
  });

  it('B06：第二窗口关闭标签必须注销第二窗口的真实归属', async () => {
    // WebView 的 ESM 不提供 CommonJS require；Tauri 的正式窗口 API 仍可用。
    vi.stubGlobal('require', undefined);
    const key = 'C:/round2/secondary-close.md';
    seed(key, 'text');
    useWindowStore.getState().closeTab(key);
    // 🔴 N05 接线适配：统一关闭协调中注销在排空写队列之后异步发出（正确顺序）
    await settleMicrotasks();
    expect(ipc.unregisterDocument).toHaveBeenCalledWith('nb-secondary', key);
  });

  it('B07：批量关闭每个标签只能执行一次生命周期清理', async () => {
    const keep = 'C:/round2/keep.md';
    seed(keep, 'keep');
    seed('C:/round2/close-a.md', 'a');
    seed('C:/round2/close-b.md', 'b');
    useWindowStore.getState().closeOtherTabs(keep);
    await settleMicrotasks(); // 注销在排空写队列后异步发出
    expect(ipc.unregisterDocument).toHaveBeenCalledTimes(2);
  });

  it('B08：迁移超时且后端成功 aborted，源必须保留唯一未保存正文', async () => {
    vi.useFakeTimers();
    const key = 'C:/round2/transfer-abort.md';
    seed(key, 'only-unsaved-copy', { isDirty: true });
    useDocumentStore.getState().setDirty(key, true);
    const pending = moveToNewWindow(key);
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(30000);
    const result = await pending;
    expect(ipc.abortTransfer).toHaveBeenCalled();
    expect({ result, content: useDocumentStore.getState().getDocument(key)?.content }).toEqual({ result: false, content: 'only-unsaved-copy' });
  });

  it('B11：关闭的异步清理不得删除同路径新建的文档会话', async () => {
    const key = 'C:/round2/late-cleanup.md';
    seed(key, 'old-text');
    useWindowStore.getState().closeTab(key);
    seed(key, 'reopened-text');
    // 等真实动态 import 的清理执行完，断言新会话仍与标签对应。
    await vi.dynamicImportSettled();
    expect(useWindowStore.getState().getTab(key)).not.toBeNull();
    expect(useDocumentStore.getState().getDocument(key)?.content).toBe('reopened-text');
  });
});
