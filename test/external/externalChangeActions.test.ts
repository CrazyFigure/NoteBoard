// 磁盘冲突必须真正更新编辑器内核，另存与取消均不得覆盖原文件。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { save } from '@tauri-apps/plugin-dialog';
import * as ipc from '@/core/ipc/commands';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { registerEditorCapabilities, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { initializeDocumentHistory, registerDocumentHistoryAdapter } from '@/features/history/documentHistory';
import { reloadFromDisk } from '@/features/external/externalChangeActions';
import { saveAs, saveDocument } from '@/features/editor-code/orchestration/saveDocument';
import { migrateDocumentSession } from '@/features/session/documentSession';

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main' }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@/features/staging/stagingManager', () => ({ onDocumentSaved: vi.fn(), getStagedPath: vi.fn() }));
vi.mock('@/features/explorer/directoryWatcher', () => ({ noteSelfWrite: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({
  readDocument: vi.fn(), writeDocument: vi.fn(), setDocumentDirty: vi.fn(),
  registerDocument: vi.fn(), unregisterDocument: vi.fn(),
}));

const KEY = 'C:\\notes\\conflict.md';
const TARGET = 'C:\\notes\\copy.md';
/** 构造磁盘基线与编辑内容不同的冲突会话。 */
function seed() {
  const payload = { key: KEY, displayName: 'conflict.md', dirPath: 'C:\\notes', kind: 'markdown' as const,
    language: 'markdown' as const, content: 'base', encoding: 'utf8' as const, eol: 'lf' as const, size: 4, mtime: 1, readonly: false };
  useDocumentStore.getState().upsertFromPayload(payload);
  useDocumentStore.getState().setContent(KEY, 'my edits');
  useDocumentStore.getState().setExternalStatus(KEY, 'modified');
  useWindowStore.getState().openTab({ key: KEY, path: KEY, displayName: 'conflict.md', kind: 'markdown', language: 'markdown',
    isDirty: true, isPreview: false, viewMode: 'source', externalStatus: 'modified', isDetached: false });
  vi.mocked(ipc.readDocument).mockResolvedValue({ ...payload, content: 'disk edits', eol: 'crlf', encoding: 'gbk', mtime: 9, size: 10 });
}

describe('磁盘冲突处理事务', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetEditorRegistryForTest();
    useDocumentStore.getState().clear();
    useWindowStore.setState({ tabs: [], activeKey: null });
    vi.mocked(ipc.registerDocument).mockResolvedValue({ type: 'ok' });
    vi.mocked(ipc.writeDocument).mockResolvedValue({ ok: true, error: null, size: 8, mtime: 10 });
    seed();
  });

  it('重载同时应用到已挂载内核、正文、基线、文件属性和标签脏态', async () => {
    let kernelContent = 'my edits';
    initializeDocumentHistory(KEY, kernelContent, 'source');
    registerDocumentHistoryAdapter(KEY, { applyEntry: (entry) => { kernelContent = entry.content; } });
    registerEditorCapabilities({ docKey: KEY, instanceId: 'source', getRevision: () => 0, flush: async () => null,
      focus: () => {}, getSelectedText: () => '', canSuspend: () => false });
    expect(await reloadFromDisk(KEY)).toBe(true);
    expect(kernelContent).toBe('disk edits');
    expect(useDocumentStore.getState().getDocument(KEY)).toMatchObject({ content: 'disk edits', baselineContent: 'disk edits',
      encoding: 'gbk', eol: 'crlf', mtime: 9, size: 10, isDirty: false, externalStatus: 'clean' });
    expect(useWindowStore.getState().getTab(KEY)).toMatchObject({ isDirty: false, externalStatus: 'clean' });
    expect(ipc.writeDocument).not.toHaveBeenCalled();
  });

  it('没有内核的后台文档可直接接受磁盘内容', async () => {
    expect(await reloadFromDisk(KEY)).toBe(true);
    expect(useDocumentStore.getState().getDocument(KEY)?.content).toBe('disk edits');
  });

  it('内核尚未就绪或读盘失败时不解除冲突，不丢失编辑内容', async () => {
    registerEditorCapabilities({ docKey: KEY, instanceId: 'loading', getRevision: () => 0, flush: async () => null,
      replaceContent: () => false, focus: () => {}, getSelectedText: () => '', canSuspend: () => false });
    expect(await reloadFromDisk(KEY, { silent: true })).toBe(false);
    vi.mocked(ipc.readDocument).mockRejectedValueOnce(new Error('permission denied'));
    expect(await reloadFromDisk(KEY, { silent: true })).toBe(false);
    expect(useDocumentStore.getState().getDocument(KEY)).toMatchObject({ content: 'my edits', baselineContent: 'base', externalStatus: 'modified' });
  });

  it('重载读取期间会话换代时丢弃旧结果', async () => {
    let finish!: (value: Awaited<ReturnType<typeof ipc.readDocument>>) => void;
    const payload = await ipc.readDocument(KEY);
    vi.mocked(ipc.readDocument).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const work = reloadFromDisk(KEY);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    migrateDocumentSession(KEY, KEY);
    finish(payload);
    expect(await work).toBe(false);
    expect(useDocumentStore.getState().getDocument(KEY)?.content).toBe('my edits');
  });

  it('取消另存和选择原路径均不写盘；普通保存也不绕过冲突', async () => {
    vi.mocked(save).mockResolvedValueOnce(null).mockResolvedValueOnce('c:/NOTES/conflict.md');
    expect(await saveAs(KEY, '')).toBe(false);
    expect(await saveAs(KEY, '')).toBe(false);
    expect(await saveDocument(KEY)).toBe(false);
    expect(ipc.writeDocument).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().getDocument(KEY)?.externalStatus).toBe('modified');
  });

  it('另存成功只写新路径，迁移后的正文保留未保存编辑', async () => {
    vi.mocked(save).mockResolvedValue(TARGET);
    expect(await saveAs(KEY, 'stale content')).toBe(true);
    expect(ipc.writeDocument).toHaveBeenCalledExactlyOnceWith(TARGET, 'my edits', 'utf8', 'lf');
    expect(useDocumentStore.getState().getDocument(TARGET)).toMatchObject({ content: 'my edits', externalStatus: 'clean' });
  });
});
