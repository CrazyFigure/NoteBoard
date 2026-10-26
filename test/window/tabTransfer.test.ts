// 标签迁移回归：使用真实窗口/文档 store，只替换 IPC 与原生边界。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentKind, TransferredDocument } from '@/core/ipc/types';

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-src', setFocus: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock('@/app/bootCoordinator', () => ({ markBusinessReady: vi.fn(), requestDrain: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({
  beginDocumentTransfer: vi.fn(), queryTransfer: vi.fn(), abortTransfer: vi.fn(),
  closeWindow: vi.fn(), unregisterDocument: vi.fn().mockResolvedValue(undefined),
  listIncomingTransfers: vi.fn(), takeTransferPayload: vi.fn(), prepareTransferComplete: vi.fn(),
  windowShellReady: vi.fn().mockResolvedValue(undefined),
  writeDocument: vi.fn(),
}));
vi.mock('@/features/session/closedWindowSession', () => ({ ensureWritableContent: vi.fn(), loadRestoredTab: vi.fn() }));
vi.mock('@/features/staging/stagingManager', () => ({ onDocumentSaved: vi.fn().mockResolvedValue(undefined) }));

import * as ipc from '@/core/ipc/commands';
import { ensureWritableContent } from '@/features/session/closedWindowSession';
import { moveTabToWindow, pendingTransferWaitsForTest, requestCurrentWindowClose, requestShellReadyAndDrain } from '@/features/window/windowManager';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore, type Tab } from '@/stores/windowStore';
import { registerEditorCapabilities, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { registerTextDiffCapture } from '@/features/textdiff/textDiffTransfer';
import { enqueueDocumentWrite, queuedAutoSave, writeDocumentWithBarrier } from '@/features/session/documentSession';

const key = 'untitled:tab-transfer';
const tab = (kind: DocumentKind = 'markdown'): Tab => ({ key, displayName: '未命名.md', path: null,
  kind, language: 'markdown', isDirty: true, isPreview: false, viewMode: 'visual', externalStatus: 'modified', isDetached: false });

/** 模拟未保存的真实内容和不同的磁盘基线，防止把脏正文当基线交接。 */
function seed(kind: DocumentKind = 'markdown', content: string | null = '未保存正文') {
  useDocumentStore.getState().upsertFromPayload({ key, displayName: '未命名.md', dirPath: '', kind,
    language: 'markdown', content, encoding: 'gbk', eol: 'crlf', size: 30, mtime: 7, readonly: false });
  useDocumentStore.getState().updateBaseline(key, '磁盘基线', 7, 30);
  useDocumentStore.getState().setDirty(key, true);
  useWindowStore.getState().openTab(tab(kind));
}

/** 用真实迁移等待注册表送达权威终态，不依赖超时推进。 */
async function settleTransfer(outcome: 'committed' | 'aborted') {
  await vi.waitFor(() => expect(pendingTransferWaitsForTest().has('tx-tab')).toBe(true));
  pendingTransferWaitsForTest().get('tx-tab')!(outcome);
}

describe('桌面标签迁移', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [], pendingCloseKeys: [], isWindowClosing: false });
    useDocumentStore.setState({ documents: new Map() });
    resetEditorRegistryForTest();
    vi.mocked(ensureWritableContent).mockResolvedValue('未保存正文');
    vi.mocked(ipc.beginDocumentTransfer).mockResolvedValue({ transferId: 'tx-tab', targetLabel: 'nb-target' });
    vi.mocked(ipc.closeWindow).mockResolvedValue(undefined);
    vi.mocked(ipc.listIncomingTransfers).mockResolvedValue([]);
  });
  afterEach(() => { pendingTransferWaitsForTest().get('tx-tab')?.('aborted'); });

  it('合并到指定窗口，携带插入锚点、脏正文、原基线与编码；确认前不移除源', async () => {
    seed();
    const target = { targetLabel: 'nb-target', beforeKey: 'other.md' };
    const pending = moveTabToWindow(key, target);
    await vi.waitFor(() => expect(ipc.beginDocumentTransfer).toHaveBeenCalledTimes(1));
    expect(ipc.beginDocumentTransfer).toHaveBeenCalledWith('nb-src', expect.objectContaining({
      content: '未保存正文', baseline: '磁盘基线', isDirty: true, encoding: 'gbk', eol: 'crlf',
      insertBefore: 'other.md', tabMeta: { path: null, externalStatus: 'modified', isDetached: false },
    }), 0, target);
    expect(useWindowStore.getState().getTab(key)).not.toBeNull();
    await settleTransfer('committed');
    expect(await pending).toBe(true);
    expect(useWindowStore.getState().getTab(key)).toBeNull();
    expect(ipc.closeWindow).toHaveBeenCalledWith('nb-src');
  });

  it.each(['image', 'preview', 'unsupported'] as const)('%s 没有文本正文时仍可迁移，保持 null', async (kind) => {
    seed(kind, null);
    const pending = moveTabToWindow(key, { targetLabel: 'nb-target' });
    await vi.waitFor(() => expect(ipc.beginDocumentTransfer).toHaveBeenCalledTimes(1));
    expect(ensureWritableContent).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.beginDocumentTransfer).mock.calls[0][1].content).toBeNull();
    await settleTransfer('committed');
    expect(await pending).toBe(true);
  });

  it('工具标签无 documentStore 时仍交接快照，不创建伪正文', async () => {
    useWindowStore.getState().openTab({ ...tab('code'), toolKind: 'textdiff' });
    const snapshot = { a: { doc: '左侧' }, b: { doc: '右侧' }, leftName: '', rightName: '',
      collapseOn: false, softWrap: true, leftWidth: '', scrollA: { top: 0, left: 0 }, scrollB: { top: 0, left: 0 } };
    const unregister = registerTextDiffCapture(key, () => snapshot);
    const pending = moveTabToWindow(key, { targetLabel: 'nb-target' });
    await vi.waitFor(() => expect(ipc.beginDocumentTransfer).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.beginDocumentTransfer).mock.calls[0][1]).toMatchObject({ content: null, toolState: snapshot });
    await settleTransfer('committed');
    expect(await pending).toBe(true);
    unregister();
  });

  it('flush 异常后保留源正文并解除保护，可以重新尝试', async () => {
    seed();
    registerEditorCapabilities({ docKey: key, instanceId: 'flush-fail', getRevision: () => 0,
      flush: async () => { throw new Error('编辑器拒绝导出'); }, focus() {}, getSelectedText: () => '', canSuspend: () => false });
    expect(await moveTabToWindow(key)).toBe(false);
    expect(useWindowStore.getState().isTransferring(key)).toBe(false);
    expect(useDocumentStore.getState().getDocument(key)?.content).toBe('未保存正文');
    expect(ipc.beginDocumentTransfer).not.toHaveBeenCalled();
  });

  it('迁移等待期间禁止关闭窗口，目标中止后保留内容与源窗口', async () => {
    seed();
    const pending = moveTabToWindow(key, { targetLabel: 'nb-target' });
    await vi.waitFor(() => expect(ipc.beginDocumentTransfer).toHaveBeenCalledTimes(1));
    await requestCurrentWindowClose();
    expect(ipc.closeWindow).not.toHaveBeenCalled();
    expect(await moveTabToWindow(key)).toBe(false);
    await settleTransfer('aborted');
    expect(await pending).toBe(false);
    expect(useWindowStore.getState().getTab(key)).not.toBeNull();
    expect(useWindowStore.getState().isTransferring(key)).toBe(false);
  });

  it('目标按插入锚点合并，保留已有预览页与未保存状态', async () => {
    useWindowStore.getState().openTab({ ...tab(), key: 'other.md', isPreview: true });
    const payload: TransferredDocument = { key, content: '未保存正文', baseline: '磁盘基线', boardScene: null,
      isDirty: true, viewMode: 'visual', viewState: { selection: null, scrollTop: 0, boardViewport: null, foldedRanges: [] },
      displayName: '未命名.md', kind: 'markdown', insertBefore: 'other.md',
      tabMeta: { path: null, externalStatus: 'modified', isDetached: true } };
    vi.mocked(ipc.listIncomingTransfers).mockResolvedValue(['incoming', 'incoming']);
    vi.mocked(ipc.takeTransferPayload).mockResolvedValue(payload);
    vi.mocked(ipc.prepareTransferComplete).mockResolvedValue({ transferId: 'incoming', state: 'committed', key });
    await requestShellReadyAndDrain();
    expect(useWindowStore.getState().tabs.map((item) => item.key)).toEqual([key, 'other.md']);
    expect(useWindowStore.getState().getTab('other.md')?.isPreview).toBe(false);
    expect(useWindowStore.getState().getTab(key)).toMatchObject({ path: null, isDirty: true, isDetached: true });
    expect(useDocumentStore.getState().getDocument(key)).toMatchObject({ content: '未保存正文', baselineContent: '磁盘基线', isDirty: true });
    expect(ipc.takeTransferPayload).toHaveBeenCalledTimes(1);
  });

  it('源保存尚未完成时等待落盘，携带完成后的真实磁盘基线', async () => {
    seed();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const write = enqueueDocumentWrite(key, async () => {
      await blocked;
      useDocumentStore.getState().updateBaseline(key, '本窗口刚保存的内容', 8, 42);
    });
    const pending = moveTabToWindow(key, { targetLabel: 'nb-target' });
    await Promise.resolve();
    expect(ipc.beginDocumentTransfer).not.toHaveBeenCalled();
    release();
    await write;
    await vi.waitFor(() => expect(ipc.beginDocumentTransfer).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.beginDocumentTransfer).mock.calls[0][1].baseline).toBe('本窗口刚保存的内容');
    await settleTransfer('committed');
    expect(await pending).toBe(true);
  });

  it('保护期拒绝新自动保存和手动保存，不让迟到写入跨过迁移快照', async () => {
    seed();
    const doc = useDocumentStore.getState().getDocument(key)!;
    useDocumentStore.setState({ documents: new Map([[key, { ...doc, savePolicy: 'auto' }]]) });
    useWindowStore.getState().enterTransfer(key);
    await queuedAutoSave(key, '迟到自动保存');
    expect(await writeDocumentWithBarrier(key, '迟到手动保存')).toBe(false);
    expect(ipc.writeDocument).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().getDocument(key)?.content).toBe('未保存正文');
    useWindowStore.getState().exitTransfer(key);
  });

  it('干净文件迁移也恢复磁盘 CRLF 基线，不用内核 LF 快照替代', async () => {
    vi.mocked(ipc.listIncomingTransfers).mockResolvedValue(['clean-incoming']);
    vi.mocked(ipc.takeTransferPayload).mockResolvedValue({ key, content: '第一行\n第二行\n', baseline: '第一行\r\n第二行\r\n',
      boardScene: null, isDirty: false, kind: 'code', viewMode: null,
      viewState: { selection: null, scrollTop: 0, boardViewport: null, foldedRanges: [] } });
    vi.mocked(ipc.prepareTransferComplete).mockResolvedValue({ transferId: 'clean-incoming', state: 'committed', key });
    await requestShellReadyAndDrain();
    expect(useDocumentStore.getState().getDocument(key)).toMatchObject({
      content: '第一行\n第二行\n', baselineContent: '第一行\r\n第二行\r\n', isDirty: false,
    });
  });
});
