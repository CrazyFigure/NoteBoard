// 验证真实另存为编排把文首标题传给桌面、网页和移动端原有窗口，不改变正文或取消语义。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Text } from '@codemirror/state';
import { save } from '@tauri-apps/plugin-dialog';
import * as ipc from '@/core/ipc/commands';
import { registerEditorCapabilities, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { saveAs, saveDocument, setSaveAsPathPicker } from '@/features/editor-code/orchestration/saveDocument';
import { discardPendingSourceSnapshot, stagePendingSourceSnapshot } from '@/features/editor-md/visualSnapshot';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { mobileSaveAsPicker, cancelSaveAs, resolveSaveAs, useMobileSaveAsStore } from '@/mobile/mobileSaveAs';
import { useMobileStore } from '@/mobile/mobileStore';
import { PromptDialog } from '@/mobile/components';

// 移动与网页的文件窗口使用 POSIX 路径；桌面分支只核对传入系统窗口的建议名称。
vi.mock('@/core/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/core/platform')>(),
  USES_WINDOWS_PATHS: false,
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main' }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@/features/staging/stagingManager', () => ({ onDocumentSaved: vi.fn(), getStagedPath: vi.fn() }));
vi.mock('@/features/explorer/directoryWatcher', () => ({ noteSelfWrite: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({
  writeDocument: vi.fn(), setDocumentDirty: vi.fn(), registerDocument: vi.fn(), unregisterDocument: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const KEY = 'C:/notes/原文.md';
let root: Root | undefined;

/** 建立真实 store 会话；仅替换磁盘、系统窗口等外部副作用。 */
function seed(content: string, key = KEY, kind: 'markdown' | 'code' = 'markdown', displayName = '原文.md'): void {
  useDocumentStore.getState().upsertFromPayload({ key, displayName, dirPath: 'C:/notes', kind,
    language: kind === 'markdown' ? 'markdown' : 'plaintext', content, encoding: 'utf8', eol: 'lf',
    size: content.length, mtime: 0, readonly: false });
  useWindowStore.getState().openTab({ key, path: key, displayName, kind,
    language: kind === 'markdown' ? 'markdown' : 'plaintext', isDirty: false, isPreview: false,
    viewMode: 'source', externalStatus: null, isDetached: false });
}

beforeEach(() => {
  vi.resetAllMocks();
  resetEditorRegistryForTest();
  setSaveAsPathPicker(null);
  useDocumentStore.setState({ documents: new Map() });
  useWindowStore.setState({ tabs: [], activeKey: null });
  useMobileStore.setState({ currentFolder: '/workspace/notes', overlays: [] });
  vi.mocked(save).mockResolvedValue(null);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  cancelSaveAs();
  setSaveAsPathPicker(null);
  discardPendingSourceSnapshot(KEY);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Markdown 另存为建议名称', () => {
  it.each([
    ['# 项目计划\n正文', '项目计划.md'],
    ['\uFEFF   # **项目** 与 `计划`、[链接](https://example.com) ###\r\n正文', '项目 与 计划、链接.md'],
    ['项目计划\n===\n正文', '项目计划.md'],
    ['# README.md', 'README.md'],
    ['# 笔记.markdown', '笔记.markdown'],
    ['# 项目: 第一/二\\三? <方案> | "草稿"\u0001', '项目_ 第一_二_三_  _ _草稿__.md'],
    ['# CON', '_CON.md'],
    ['# AUX.记录', '_AUX.记录.md'],
    ['# 项目计划...  ', '项目计划.md'],
  ])('桌面窗口从文首生成名称：%s', async (content, expected) => {
    seed(content);
    expect(await saveAs(KEY, '过时的调用参数')).toBe(false);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: expected }));
    expect(ipc.writeDocument).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().getDocument(KEY)?.content).toBe(content);
  });

  it.each(['', '\n# 后续标题', '正文\n# 后续标题', '## 二级标题', '#没有空格', '#', '#  ###',
    '    # 缩进代码', '> # 引用标题', '```md\n# 代码中的标题\n```', '---\ntitle: 前置信息\n---\n# 标题', '# ...'])(
    '首行没有可用一级标题时保留原名：%s', async (content) => {
      seed(content);
      await saveAs(KEY, '');
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: '原文.md' }));
    });

  it.each(['原文.txt', 'markdown.txt'])('非 Markdown 文档即使以井号开头也保留原名：%s', async (name) => {
    const key = `C:/notes/${name}`;
    seed('# 这是文本', key, 'code', name);
    await saveAs(key, '');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: name }));
  });

  it('未命名 Markdown 首次保存同样预填标题，取消后仍保留原会话', async () => {
    const key = 'untitled:markdown-title';
    seed('# 首次保存', key, 'markdown', '未命名.md');
    expect(await saveDocument(key)).toBe(false);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: '首次保存.md' }));
    expect(useDocumentStore.getState().getDocument(key)?.content).toBe('# 首次保存');
  });

  it('编辑器尚未写回镜像时使用最新捕获标题', async () => {
    seed('# 旧标题');
    registerEditorCapabilities({ docKey: KEY, instanceId: 'editor', getRevision: () => 1,
      flush: async () => ({ docKey: KEY, instanceId: 'editor', revision: 1, content: '# 最新标题' }),
      focus: () => {}, getSelectedText: () => '', canSuspend: () => false });
    await saveAs(KEY, '# 错误标题');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: '最新标题.md' }));
  });

  it('源码首开时立即另存为也先读取尚未物化的输入', async () => {
    seed('# 旧标题');
    stagePendingSourceSnapshot(KEY, { text: Text.of(['# 刚输入的标题', '正文']), revision: 1, isNewGroup: true });
    await saveAs(KEY, '');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: '刚输入的标题.md' }));
    expect(useDocumentStore.getState().getDocument(KEY)?.content).toBe('# 刚输入的标题\n正文');
  });

  it('长标题生成的文件名不超出 UTF-8 长度限制，也不截断 emoji', async () => {
    seed(`# ${'😀'.repeat(100)}`);
    await saveAs(KEY, '');
    const name = vi.mocked(save).mock.calls[0][0]?.defaultPath ?? '';
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name).toMatch(/^😀+\.md$/u);
  });

  it('网页保存窗口实际显示建议名称，并允许修改后取消', async () => {
    seed('# 网页项目计划');
    const { save: webSave } = await import('@/web/runtime');
    // jsdom 缺少原生模态方法，保留实际文件窗口 DOM，仅替换模态显示能力。
    const dialog = document.createElement('dialog');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag, options) =>
      tag === 'dialog' ? dialog : createElement(tag, options));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ result: [] }) }));
    vi.mocked(save).mockImplementation(webSave);
    const work = saveAs(KEY, '');
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>('input[aria-label="文件名"]')!;
    expect(input.value).toBe('网页项目计划.md');
    input.value = '用户指定名称.md';
    const cancel = [...document.querySelectorAll('dialog button')].find((button) => button.textContent === '取消')!;
    (cancel as HTMLButtonElement).click();
    expect(await work).toBe(false);
    expect(document.querySelector('dialog')).toBeNull();
    expect(ipc.writeDocument).not.toHaveBeenCalled();
  });

  it('移动端命名窗口实际预填标题，用户可改名后保存到当前文件夹', async () => {
    seed('# 手机项目计划');
    setSaveAsPathPicker(mobileSaveAsPicker);
    vi.mocked(ipc.registerDocument).mockResolvedValue({ type: 'ok' });
    vi.mocked(ipc.writeDocument).mockResolvedValue({ ok: true, error: null, size: 20, mtime: 1 });
    const work = saveAs(KEY, '');
    await vi.waitFor(() => expect(useMobileSaveAsStore.getState().request).not.toBeNull());
    const request = useMobileSaveAsStore.getState().request!;
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<PromptDialog open title="保存文档" initialValue={request.defaultName}
      selectBaseName confirmLabel="保存" onClose={cancelSaveAs} onConfirm={resolveSaveAs} />));
    const input = document.querySelector<HTMLInputElement>('.nb-m-input')!;
    expect(input.value).toBe('手机项目计划.md');
    await vi.waitFor(() => expect(input.selectionEnd).toBe('手机项目计划'.length));
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '手动改名.md');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '保存')!;
    await act(async () => { confirm.click(); await work; });
    expect(await work).toBe(true);
    expect(ipc.writeDocument).toHaveBeenCalledWith('/workspace/notes/手动改名.md', '# 手机项目计划', 'utf8', 'lf');
    expect(save).not.toHaveBeenCalled();
  });
});
