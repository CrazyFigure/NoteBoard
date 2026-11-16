// 文件树改后缀的完整会话链：覆盖平台路径、未保存输入、重载类型和保存保护。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main' }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@/features/staging/stagingManager', () => ({ onDocumentSaved: vi.fn(), getStagedPath: vi.fn() }));
vi.mock('@/features/wikilink/renameLinks', () => ({ planWikiLinkRenameSafely: vi.fn().mockResolvedValue(null) }));
vi.mock('@/core/ipc/commands', () => ({
  renamePath: vi.fn(), readDocument: vi.fn(), writeDocument: vi.fn(), pathExists: vi.fn(),
  registerDocument: vi.fn(), unregisterDocument: vi.fn(), setDocumentDirty: vi.fn(), readDir: vi.fn(),
}));

/** 每个平台使用独立模块实例，真实执行统一的路径、会话和重载实现。 */
async function setup(platform = 'windows', from = '笔记.txt', to = '笔记.md') {
  vi.stubGlobal('__NB_TARGET_PLATFORM__', platform);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.resetModules();
  const ipc = await import('@/core/ipc/commands');
  const { useDocumentStore: docs } = await import('@/stores/documentStore');
  const { useWindowStore: windows } = await import('@/stores/windowStore');
  const { useSettingsStore } = await import('@/stores/settingsStore');
  useSettingsStore.setState((state) => ({ settings: { ...state.settings,
    file: { ...state.settings.file, autoSaveMarkdown: true, autoSaveOther: false } } }));
  const { kindFromPath, languageFromPath } = await import('@/core/docKind');
  const { joinPath } = await import('@/features/explorer/pathUtils');
  const { renameOpenFile } = await import('@/features/explorer/renameOpenFile');
  const { reloadFromDisk } = await import('@/features/external/externalChangeActions');
  const { recheckDocument } = await import('@/features/explorer/directoryWatcher');
  const { queuedAutoSave } = await import('@/features/session/documentSession');
  const { saveDocument } = await import('@/features/editor-code/orchestration/saveDocument');
  const registry = await import('@/core/editor/editorRegistry');
  const dir = platform === 'windows' ? 'C:\\notes.with.dot' : '/notes.with.dot/中文目录';
  const oldPath = joinPath(dir, from);
  const newPath = joinPath(dir, to);
  const payload = { key: oldPath, displayName: from, dirPath: dir, kind: kindFromPath(from), language: languageFromPath(from),
    content: '# 磁盘原文\n', encoding: 'utf8' as const, eol: 'lf' as const, size: 14, mtime: 1, readonly: false };
  docs.getState().upsertFromPayload(payload);
  windows.getState().openTab({ key: oldPath, path: oldPath, displayName: from, kind: payload.kind, language: payload.language,
    viewMode: null, isDirty: false, isPreview: false, externalStatus: 'clean', isDetached: false });
  vi.mocked(ipc.readDocument).mockResolvedValue({ ...payload, key: newPath, displayName: to,
    kind: kindFromPath(to), language: languageFromPath(to) });
  vi.mocked(ipc.renamePath).mockResolvedValue();
  return { ipc, docs, windows, registry, oldPath, newPath, dir, payload, renameOpenFile, reloadFromDisk, recheckDocument, queuedAutoSave, saveDocument };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('文件树改后缀', () => {
  it.each(['windows', 'darwin', 'linux', 'android', 'ios', 'web'])('%s：改后缀立即激活提示，保留输入，确认后切换类型与策略', async (platform) => {
    const s = await setup(platform);
    // 编辑器内核领先于镜像，改名必须主动捕获这部分未保存输入。
    s.registry.registerEditorCapabilities({ docKey: s.oldPath, instanceId: 'old-editor', getRevision: () => 0,
      flush: vi.fn(async () => ({ docKey: s.oldPath, instanceId: 'old-editor', revision: 0, content: '# 尚未保存\n' })),
      canSuspend: () => false, focus: () => {}, getSelectedText: () => '' });
    s.windows.setState({ activeKey: null });
    await s.renameOpenFile(s.oldPath, s.newPath, '笔记.md');
    expect(s.ipc.renamePath).toHaveBeenCalledExactlyOnceWith(s.oldPath, s.newPath);
    expect(s.docs.getState().getDocument(s.oldPath)).toBeUndefined();
    const { getSessionGeneration } = await import('@/features/session/documentSession');
    expect(getSessionGeneration(s.oldPath)).toBe(0);
    expect(s.docs.getState().getDocument(s.newPath)).toMatchObject({ kind: 'code', language: 'plaintext',
      content: '# 尚未保存\n', isDirty: true, externalStatus: 'renamed' });
    expect(s.windows.getState().activeKey).toBe(s.newPath);
    expect(s.windows.getState().getTab(s.newPath)?.externalStatus).toBe('renamed');
    expect(s.windows.getState().transferringKeys).toEqual([]);
    // 后台读到同一份正文，也不能清除改后缀提示；自动与手动保存均被拦截。
    await s.recheckDocument(s.newPath);
    expect(s.docs.getState().getDocument(s.newPath)?.externalStatus).toBe('renamed');
    await s.queuedAutoSave(s.newPath, '# 尚未保存\n');
    expect(await s.saveDocument(s.newPath)).toBe(false);
    expect(s.ipc.writeDocument).not.toHaveBeenCalled();
    expect(await s.reloadFromDisk(s.newPath, { silent: true })).toBe(true);
    expect(s.docs.getState().getDocument(s.newPath)).toMatchObject({ kind: 'markdown', language: 'markdown',
      content: s.payload.content, baselineContent: s.payload.content, savePolicy: 'auto', isDirty: false, externalStatus: 'clean' });
    expect(s.windows.getState().getTab(s.newPath)).toMatchObject({ kind: 'markdown', language: 'markdown', viewMode: null, isDirty: false, externalStatus: 'clean' });
  });

  it.each([['原文.md', '新名字.md'], ['原文.md', '原文.MD'], ['README', '说明']])('仅改名字或后缀大小写不弹重载：%s → %s', async (from, to) => {
    const s = await setup('windows', from, to);
    await s.renameOpenFile(s.oldPath, s.newPath, to);
    expect(s.docs.getState().getDocument(s.newPath)?.externalStatus).toBe('clean');
    expect(s.ipc.readDocument).not.toHaveBeenCalled();
  });

  it.each([['原文.md', '原文.txt', 'code', 'plaintext'], ['配置.json', '配置.yaml', 'code', 'yaml'],
    ['说明', '说明.md', 'markdown', 'markdown']])('支持反向、代码语言和无后缀切换：%s → %s', async (from, to, kind, language) => {
    const s = await setup('linux', from, to);
    await s.renameOpenFile(s.oldPath, s.newPath, to);
    expect(s.docs.getState().getDocument(s.newPath)?.externalStatus).toBe('renamed');
    expect(await s.reloadFromDisk(s.newPath, { silent: true })).toBe(true);
    expect(s.windows.getState().getTab(s.newPath)).toMatchObject({ kind, language });
  });

  it('重载切换解析器时不调用旧内核，读取失败保留正文和提示并可重试', async () => {
    const s = await setup('linux', '笔记.md', '笔记.txt');
    await s.renameOpenFile(s.oldPath, s.newPath, '笔记.txt');
    const replace = vi.fn(() => false);
    s.registry.registerEditorCapabilities({ docKey: s.newPath, instanceId: 'markdown', getRevision: () => 0,
      flush: async () => null, replaceContent: replace, canSuspend: () => false, focus: () => {}, getSelectedText: () => '' });
    vi.mocked(s.ipc.readDocument).mockRejectedValueOnce(new Error('permission denied'));
    expect(await s.reloadFromDisk(s.newPath, { silent: true })).toBe(false);
    expect(s.docs.getState().getDocument(s.newPath)).toMatchObject({ content: s.payload.content, externalStatus: 'renamed' });
    expect(await s.reloadFromDisk(s.newPath, { silent: true })).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });

  it('重命名失败保留旧会话并解除迁移锁', async () => {
    const s = await setup();
    vi.mocked(s.ipc.renamePath).mockRejectedValueOnce(new Error('目标已存在'));
    await expect(s.renameOpenFile(s.oldPath, s.newPath, '笔记.md')).rejects.toThrow('目标已存在');
    expect(s.docs.getState().getDocument(s.oldPath)?.externalStatus).toBe('clean');
    expect(s.docs.getState().getDocument(s.newPath)).toBeUndefined();
    expect(s.windows.getState().transferringKeys).toEqual([]);
  });

  it('未加载恢复标签更新实际来源路径，不误读旧路径', async () => {
    const s = await setup('darwin');
    s.docs.setState({ documents: new Map() });
    s.windows.setState((state) => ({ tabs: state.tabs.map((tab) => ({ ...tab, lazySource: s.oldPath })) }));
    await s.renameOpenFile(s.oldPath, s.newPath, '笔记.md');
    expect(s.windows.getState().getTab(s.newPath)?.lazySource).toBe(s.newPath);
  });

  it.each(['image', 'preview', 'unsupported'] as const)('改后缀为 %s 查看器时允许空正文并切换只读边界', async (kind) => {
    const s = await setup('linux');
    await s.renameOpenFile(s.oldPath, s.newPath, '笔记.md');
    vi.mocked(s.ipc.readDocument).mockResolvedValueOnce({ ...s.payload, key: s.newPath, kind,
      language: 'plaintext', content: null, readonly: true });
    expect(await s.reloadFromDisk(s.newPath, { silent: true })).toBe(true);
    expect(s.docs.getState().getDocument(s.newPath)).toMatchObject({ kind, content: null,
      baselineContent: null, readonly: true, savePolicy: 'manual', isDirty: false, externalStatus: 'clean' });
    expect(s.windows.getState().getTab(s.newPath)?.kind).toBe(kind);
    expect(s.ipc.writeDocument).not.toHaveBeenCalled();
  });

  it('已有写盘未结束时先等待完成，避免重命名后旧路径被写回', async () => {
    const s = await setup();
    const { enqueueDocumentWrite } = await import('@/features/session/documentSession');
    let finish!: () => void;
    const pending = enqueueDocumentWrite(s.oldPath, () => new Promise<void>((resolve) => { finish = resolve; }));
    const renamed = s.renameOpenFile(s.oldPath, s.newPath, '笔记.md');
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(s.ipc.renamePath).not.toHaveBeenCalled();
    finish();
    await pending;
    await renamed;
    expect(s.ipc.renamePath).toHaveBeenCalledExactlyOnceWith(s.oldPath, s.newPath);
  });

  it('移动端文件列表使用同一改后缀流程，标签与文档同时受保护', async () => {
    const s = await setup('android');
    const { renameEntry } = await import('@/mobile/mobileFiles');
    vi.mocked(s.ipc.readDir).mockResolvedValue([]);
    const node = { path: s.oldPath, name: '笔记.txt', isDir: false, kind: 'code' as const,
      size: 14, mtime: 1, isHidden: false, isSymlink: false };
    expect(await renameEntry(node, '笔记.md')).toBe(true);
    expect(s.docs.getState().getDocument(s.newPath)?.externalStatus).toBe('renamed');
    expect(s.windows.getState().getTab(s.newPath)?.externalStatus).toBe('renamed');
  });
});
