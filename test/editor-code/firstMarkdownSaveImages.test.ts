// 验证未命名 Markdown 首存后，正文、撤销历史和实际图片地址随着目录一起交接。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { save } from '@tauri-apps/plugin-dialog';
import * as ipc from '@/core/ipc/commands';
import { saveDocument, setSaveAsPathPicker } from '@/features/editor-code/orchestration/saveDocument';
import { useExplorerStore } from '@/features/explorer/explorerStore';
import { clearAllDocumentHistories, recordDocumentChange, redoDocumentHistory, registerDocumentHistoryAdapter, undoDocumentHistory } from '@/features/history/documentHistory';
import { resolveRelativeDocPath } from '@/features/editor-md/linkHandler';
import { scanImageRefs } from '@/features/editor-md/imageRefs';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main' }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@/features/explorer/directoryWatcher', () => ({ noteSelfWrite: vi.fn() }));
vi.mock('@/features/staging/stagingManager', () => ({ onDocumentSaved: vi.fn(), getStagedPath: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({
  writeDocument: vi.fn(), setDocumentDirty: vi.fn(), registerDocument: vi.fn(), unregisterDocument: vi.fn(),
}));

const DRAFT = 'untitled:markdown-images';
const CLIPBOARD_IMAGE = '![截图](./img/1795656247564_image.png)';

/** 创建无磁盘路径的 Markdown 草稿，图片仍按资源管理器根目录解析。 */
function seedDraft(content: string, root: string | null): void {
  useExplorerStore.setState({ root });
  useDocumentStore.getState().upsertFromPayload({ key: DRAFT, displayName: '未命名.md', dirPath: '',
    kind: 'markdown', language: 'markdown', content, encoding: 'utf8', eol: 'lf',
    size: content.length, mtime: 0, readonly: false });
  useWindowStore.getState().openTab({ key: DRAFT, path: null, displayName: '未命名.md', kind: 'markdown',
    language: 'markdown', isDirty: true, isPreview: false, viewMode: 'visual', externalStatus: null, isDetached: false });
}

beforeEach(() => {
  vi.resetAllMocks();
  clearAllDocumentHistories();
  useDocumentStore.setState({ documents: new Map() });
  useWindowStore.setState({ tabs: [], activeKey: null });
  vi.mocked(ipc.registerDocument).mockResolvedValue({ type: 'ok' });
  vi.mocked(ipc.writeDocument).mockResolvedValue({ ok: true, error: null, size: 50, mtime: 1 });
});

afterEach(() => {
  setSaveAsPathPicker(null);
});

describe('Markdown 首存图片引用', () => {
  it('保存到 Windows 子目录时，磁盘正文、当前会话和撤销重做仍指向原图', async () => {
    const target = 'C:\\工作区\\笔记\\记录.md';
    const draft = `# 记录\n\n${CLIPBOARD_IMAGE}\n\n<img src="./img/图 片.png" width="50%">\n\n\`${CLIPBOARD_IMAGE}\``;
    const laterEdit = '\n\n图片说明';
    seedDraft(draft, 'C:\\工作区');
    recordDocumentChange(DRAFT, '', { mode: 'visual', startsNewGroup: true });
    recordDocumentChange(DRAFT, draft, { mode: 'visual', startsNewGroup: true });
    // 保存时当前位于较早的历史节点，后面的重做补丁也应继续指向原图。
    recordDocumentChange(DRAFT, draft + laterEdit, { mode: 'visual', startsNewGroup: true });
    registerDocumentHistoryAdapter(DRAFT, { applyEntry: vi.fn() });
    expect(undoDocumentHistory(DRAFT)).toBe(true);
    vi.mocked(save).mockResolvedValue(target);

    expect(await saveDocument(DRAFT)).toBe(true);
    const saved = `# 记录\n\n${CLIPBOARD_IMAGE.replace('./img/', '../img/')}\n\n<img src="../img/图 片.png" width="50%">\n\n\`${CLIPBOARD_IMAGE}\``;
    expect(ipc.writeDocument).toHaveBeenCalledWith(target, saved, 'utf8', 'lf');
    expect(useDocumentStore.getState().getDocument(target)).toMatchObject({ content: saved, baselineContent: saved, isDirty: false });
    expect(useWindowStore.getState().getTab(target)?.isDirty).toBe(false);
    expect(scanImageRefs(saved).map(({ src }) => resolveRelativeDocPath('C:\\工作区\\笔记', src)))
      .toEqual(['C:\\工作区\\img\\1795656247564_image.png', 'C:\\工作区\\img\\图 片.png']);

    const applyEntry = vi.fn();
    registerDocumentHistoryAdapter(target, { applyEntry });
    expect(undoDocumentHistory(target)).toBe(true);
    expect(applyEntry).toHaveBeenLastCalledWith(expect.objectContaining({ content: '' }), expect.anything());
    expect(redoDocumentHistory(target)).toBe(true);
    expect(applyEntry).toHaveBeenLastCalledWith(expect.objectContaining({ content: saved }), expect.anything());
    expect(redoDocumentHistory(target)).toBe(true);
    expect(applyEntry).toHaveBeenLastCalledWith(expect.objectContaining({ content: saved + laterEdit }), expect.anything());
  });

  it('Windows 跨盘首存时保留真实图片位置，同时保持网络图、内嵌图和绝对引用', async () => {
    const rest = '\n\n![网络](https://example.com/a.png) ![内嵌](data:image/png;base64,AAAA) ![本地](/固定目录/a.png)';
    seedDraft(CLIPBOARD_IMAGE + rest, 'C:\\工作区');
    const target = 'D:\\笔记\\记录.md';
    vi.mocked(save).mockResolvedValue(target);

    expect(await saveDocument(DRAFT)).toBe(true);
    expect(ipc.writeDocument).toHaveBeenCalledWith(target,
      CLIPBOARD_IMAGE.replace('./img/', 'C:/工作区/img/') + rest, 'utf8', 'lf');
  });

  it.each([
    ['C:\\工作区', 'C:\\工作区\\记录.md'],
    [null, 'C:\\工作区\\笔记\\记录.md'],
  ])('同目录或缺少原目录时保留图片引用 (%s)', async (root, target) => {
    const draft = root ? CLIPBOARD_IMAGE : '![内嵌](data:image/png;base64,AAAA)';
    seedDraft(draft, root);
    vi.mocked(save).mockResolvedValue(target);

    expect(await saveDocument(DRAFT)).toBe(true);
    expect(ipc.writeDocument).toHaveBeenCalledWith(target, draft, 'utf8', 'lf');
  });

  it('写入失败时草稿仍保留旧目录下的图片，重试后才切换基准', async () => {
    seedDraft(CLIPBOARD_IMAGE, 'C:\\工作区');
    const target = 'C:\\工作区\\笔记\\记录.md';
    vi.mocked(save).mockResolvedValue(target);
    vi.mocked(ipc.writeDocument).mockResolvedValueOnce({ ok: false, error: { kind: 'disk-full' }, size: 0, mtime: 0 });

    expect(await saveDocument(DRAFT)).toBe(false);
    expect(useDocumentStore.getState().getDocument(DRAFT)?.content).toBe(CLIPBOARD_IMAGE);
    expect(useWindowStore.getState().getTab(DRAFT)).toBeDefined();
    expect(await saveDocument(DRAFT)).toBe(true);
    expect(useDocumentStore.getState().getDocument(target)?.content).toBe(CLIPBOARD_IMAGE.replace('./img/', '../img/'));
  });
});
