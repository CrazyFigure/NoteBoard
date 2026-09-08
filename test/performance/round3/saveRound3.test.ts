// 三轮复审反例（正式迁入自 test-results/performance/review-20260906-round3/）——断言为整改后正确行为。
// 三轮复审：真实另存为和关闭编排；所有文件 I/O、对话框、暂存副作用均在内存替身中。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { save } from '@tauri-apps/plugin-dialog';
import * as ipc from '@/core/ipc/commands';
import { saveAs } from '@/features/editor-code/orchestration/saveDocument';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore, disposeTabLifecycleAsync } from '@/stores/windowStore';
import { enqueueDocumentWrite, writeDocumentWithBarrier } from '@/features/session/documentSession';
import { resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { Text } from '@codemirror/state';
import { stagePendingSourceSnapshot, discardPendingSourceSnapshot } from '@/features/editor-md/visualSnapshot';
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main' }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@/features/staging/stagingManager', () => ({ onDocumentSaved: vi.fn().mockResolvedValue(undefined), getStagedPath: vi.fn() }));
vi.mock('@/features/explorer/directoryWatcher', () => ({ noteSelfWrite: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({ registerDocument: vi.fn(), unregisterDocument: vi.fn(), writeDocument: vi.fn(), setDocumentDirty: vi.fn() }));

// 后端真实语义：同窗口已经注册的目标也返回 ok；不能用不存在的 already-open(self) 掩盖。
function seed(key: string, content: string): void {
  useDocumentStore.getState().upsertFromPayload({ key, displayName: 'review.md', dirPath: 'C:/round3', kind: 'markdown', language: 'markdown', content, encoding: 'utf8', eol: 'lf', size: content.length, mtime: 0, readonly: false });
  useWindowStore.getState().openTab({ key, path: key, displayName: 'review.md', kind: 'markdown', language: 'markdown', isDirty: false, isPreview: false, viewMode: 'visual', externalStatus: null, isDetached: false });
}
async function microtasks(): Promise<void> { for (let i = 0; i < 100; i++) await Promise.resolve(); }

describe('三轮复审：另存为与关闭事务', () => {
  beforeEach(() => {
    vi.resetAllMocks(); resetEditorRegistryForTest();
    useWindowStore.setState({ tabs: [], activeKey: null }); useDocumentStore.setState({ documents: new Map() });
    vi.mocked(ipc.registerDocument).mockResolvedValue({ type: 'ok' });
    vi.mocked(ipc.unregisterDocument).mockResolvedValue(undefined);
    vi.mocked(ipc.writeDocument).mockResolvedValue({ ok: true, size: 10, mtime: 1 } as never);
  });

  it('C04：另存为目标已在同窗口打开，不能覆盖目标正文或产生重复 key 标签', async () => {
    const source = 'C:/round3/source.md', target = 'C:/round3/occupied.md';
    seed(source, 'source-text'); seed(target, 'target-unsaved');
    vi.mocked(save).mockResolvedValue(target);
    const result = await saveAs(source, 'source-text');
    expect({ result, writes: vi.mocked(ipc.writeDocument).mock.calls.length, content: useDocumentStore.getState().getDocument(target)?.content }).toEqual({ result: false, writes: 0, content: 'target-unsaved' });
  });

  it('C05：目标写盘失败必须释放另存为刚取得的目标归属', async () => {
    const source = 'C:/round3/failure-source.md', target = 'C:/round3/failure-target.md';
    seed(source, 'source-text'); vi.mocked(save).mockResolvedValue(target);
    vi.mocked(ipc.writeDocument).mockResolvedValue({ ok: false, error: { kind: 'io', message: 'test disk failure' } } as never);
    expect(await saveAs(source, 'source-text')).toBe(false);
    expect(ipc.unregisterDocument).toHaveBeenCalledWith('nb-main', target);
  });

  it('C06：对话框期间源关闭重开，旧另存为不能迁走新的同路径会话', async () => {
    const source = 'C:/round3/reopen-source.md', target = 'C:/round3/reopen-target.md';
    seed(source, 'old-session');
    let finishDialog!: (value: string) => void;
    vi.mocked(save).mockImplementation(() => new Promise(resolve => { finishDialog = resolve; }));
    const work = saveAs(source, 'old-session'); await microtasks();
    useWindowStore.getState().closeTab(source); await microtasks(); seed(source, 'new-session');
    finishDialog(target); const result = await work;
    expect({ result, source: useDocumentStore.getState().getDocument(source)?.content, writes: vi.mocked(ipc.writeDocument).mock.calls.length }).toEqual({ result: false, source: 'new-session', writes: 0 });
  });

  it('C07：捕获后等待注销期间的新编辑必须保留在另存后的会话', async () => {
    const source = 'C:/round3/late-source.md', target = 'C:/round3/late-target.md';
    seed(source, 'before'); vi.mocked(save).mockResolvedValue(target);
    let finishUnregister!: () => void;
    vi.mocked(ipc.unregisterDocument).mockImplementation(() => new Promise(resolve => { finishUnregister = resolve; }));
    const work = saveAs(source, 'before'); await microtasks();
    useDocumentStore.getState().setContent(source, 'typed-during-unregister');
    finishUnregister(); await work;
    expect(useDocumentStore.getState().getDocument(target)?.content).toBe('typed-during-unregister');
  });

  it('C08：旧关闭等待写盘后不能注销已重开的同路径新会话', async () => {
    const key = 'C:/round3/close-reopen.md'; seed(key, 'old');
    let unblock!: () => void;
    const gate = enqueueDocumentWrite(key, () => new Promise<void>(resolve => { unblock = resolve; }));
    await microtasks(); useWindowStore.getState().closeTab(key); seed(key, 'new');
    // 模拟重新打开已兑现了后端归属；旧关闭此后才结束 drain。
    await ipc.registerDocument('nb-main', key, 'markdown'); vi.mocked(ipc.unregisterDocument).mockClear();
    unblock(); await gate; await microtasks();
    expect(ipc.unregisterDocument).not.toHaveBeenCalled();
  });

  it('C09：直接 await 统一关闭协调器必须先停止该会话接纳任务', async () => {
    const key = 'C:/round3/async-close.md'; seed(key, 'text');
    await disposeTabLifecycleAsync(key);
    // 窗口整体关闭调用的是此公开接口，不能依赖另一个未调用的同步前置函数。
    const result = await writeDocumentWithBarrier(key, 'late-callback');
    expect({ result, writes: vi.mocked(ipc.writeDocument).mock.calls.length }).toEqual({ result: false, writes: 0 });
  });

  it('C14：Markdown source 首开尚无 visual 能力时，立即保存必须物化 source pending', async () => {
    const key = 'C:/round3/source-first.md'; seed(key, 'base');
    // 对应真实 TipTapEditor 的 source 首开：只建 CM，无 editor，能力注册 effect 未注册。
    useWindowStore.getState().setTabViewMode(key, 'source');
    stagePendingSourceSnapshot(key, { text: Text.of(['source-new-input']), revision: 1, isNewGroup: true });
    try {
      const { saveDocument } = await import('@/features/editor-code/orchestration/saveDocument');
      expect(await saveDocument(key)).toBe(true);
      expect(vi.mocked(ipc.writeDocument).mock.calls[0]?.[1]).toBe('source-new-input');
    } finally { discardPendingSourceSnapshot(key); }
  });
});
