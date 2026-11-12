// 真实 Markdown 内核与冲突弹窗联动：保留跨表格选区时，外部更新及重载不能抢焦点或产生事务循环。
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TipTapEditor } from '@/features/editor-md/TipTapEditor';
import { ExternalChangeDialog } from '@/features/external/ExternalChangeDialog';
import { getMdSourceView, getMdTipTapEditor } from '@/features/editor-md/editorInstances';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { getDocumentRevision, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { flushPendingSourceSnapshot, flushPendingVisualSnapshot, hasPendingSnapshot } from '@/features/editor-md/visualSnapshot';
import { undoDocumentHistory } from '@/features/history/documentHistory';
import { autoSaveDocument } from '@/features/editor-md/markdownAutoSave';
import { TooltipProvider } from '@/components/Tooltip';
import * as ipc from '@/core/ipc/commands';

// 仅替换原生 I/O，解析、编辑器、历史应用和模态焦点约束全部使用生产实现。
vi.mock('@/features/external/useExternalFileChanges', () => ({ useExternalFileChanges: () => {} }));
vi.mock('@/core/ipc/commands', async (original) => ({
  ...await original<typeof import('@/core/ipc/commands')>(),
  readDocument: vi.fn(),
}));
vi.mock('@/features/editor-md/markdownAutoSave', () => ({ autoSaveDocument: vi.fn() }));
// jsdom 中只装配真实文档 schema，隔离第三方建议插件的 CJS/ESM 装饰类身份差异。
vi.mock('@/features/editor-md/extensions', async () => {
  const { buildCoreExtensions } = await import('@/features/editor-md/extensions/core');
  return { buildExtensions: buildCoreExtensions };
});

const KEY = 'C:/external-reload/selected.md';
const originalRect = Range.prototype.getBoundingClientRect;
const originalRects = Range.prototype.getClientRects;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  // 撤销会滚动到历史落点，jsdom 没有原生窗口滚动实现。
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  // jsdom 无文字布局，用固定矩形覆盖真实菜单与滚动逻辑。
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 200, 20);
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  resetEditorRegistryForTest();
  useDocumentStore.getState().clear();
  useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
});

afterEach(() => {
  Range.prototype.getBoundingClientRect = originalRect;
  Range.prototype.getClientRects = originalRects;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ['visual', false], ['source', false], ['visual', true], ['source', true],
] as const)('%s，存在待保存输入=%s：框选后重载不产生输入快照、自动保存或模态焦点竞争', async (mode, pendingInput) => {
  const content = Array.from({ length: 90 }, (_, index) => (
    `## 第 ${index} 节\n\n说明段落：${'外部程序正在更新接口文档。'.repeat(8)}\n\n| 场景 | 说明 |\n| --- | --- |\n| 参数错误 | 保留当前内容 |\n| 应用管理 | 点击查看详情 |\n`
  )).join('\n');
  const payload = { key: KEY, displayName: 'selected.md', dirPath: 'C:/external-reload', kind: 'markdown' as const,
    language: 'markdown' as const, content, encoding: 'utf8' as const, eol: 'lf' as const,
    size: content.length, mtime: 1, readonly: false };
  useDocumentStore.getState().upsertFromPayload(payload);
  useWindowStore.getState().openTab({ key: KEY, path: KEY, displayName: 'selected.md', kind: 'markdown',
    language: 'markdown', isDirty: false, isPreview: false, viewMode: mode, externalStatus: 'clean', isDetached: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<TooltipProvider><TipTapEditor docKey={KEY} /><ExternalChangeDialog /></TooltipProvider>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    const editor = getMdTipTapEditor(KEY);
    const source = getMdSourceView(KEY);
    const view = mode === 'visual' ? editor!.view : source!;
    expect(view).toBeDefined();
    await act(async () => {
      if (pendingInput) {
        if (editor) editor.commands.insertContent('尚未自动保存的编辑');
        else source!.dispatch({ changes: { from: 0, insert: '尚未自动保存的编辑' } });
      }
      if (editor) editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
      else source!.dispatch({ selection: { anchor: 1, head: source!.state.doc.length - 1 } });
      view.focus();
    });
    await act(async () => useDocumentStore.getState().setExternalStatus(KEY, 'modified'));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
    // 记录模态层尚未关闭时的错误聚焦；这会与焦点陷阱竞争，WebKit 尤其容易长时间卡住。
    const focusWhileModal = vi.spyOn(view, 'focus');
    const revision = getDocumentRevision(KEY);
    const diskContent = content.replaceAll('保留当前内容', '磁盘更新内容');
    vi.mocked(ipc.readDocument).mockResolvedValue({ ...payload, content: diskContent, mtime: 2 });
    await act(async () => {
      const button = [...dialog.querySelectorAll('button')].find((item) => item.textContent === '重新加载')!;
      button.click();
    });
    expect(useDocumentStore.getState().getDocument(KEY)).toMatchObject({ content: diskContent, baselineContent: diskContent,
      isDirty: false, externalStatus: 'clean' });
    expect(editor?.getText() ?? source!.state.doc.toString()).toContain('磁盘更新内容');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(focusWhileModal).not.toHaveBeenCalled();
    expect(getDocumentRevision(KEY)).toBe(revision);
    expect(hasPendingSnapshot(KEY)).toBe(false);
    // 等待超过自动保存默认间隔，程序重载不得再被当作用户输入重新写盘。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    expect(autoSaveDocument).not.toHaveBeenCalled();
    // 同步锁必须已释放，重载后的第一笔真实输入照常受快照和脏态保护。
    await act(async () => {
      if (editor) editor.commands.insertContent('重载后编辑');
      else source!.dispatch({ changes: { from: 0, insert: '重载后编辑' } });
    });
    expect(getDocumentRevision(KEY)).toBe(revision + 1);
    expect(hasPendingSnapshot(KEY)).toBe(true);
    expect(useDocumentStore.getState().getDocument(KEY)?.isDirty).toBe(true);
    // 重载后的新编辑必须能撤销回磁盘版本，普通历史导航仍更新镜像与脏态。
    await act(async () => {
      expect(undoDocumentHistory(KEY)).toBe(true);
      flushPendingSourceSnapshot(KEY);
      flushPendingVisualSnapshot(KEY);
    });
    expect(useDocumentStore.getState().getDocument(KEY)).toMatchObject({ content: diskContent, isDirty: false });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}, 20_000);
