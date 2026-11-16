// 使用真实 CodeMirror / TipTap 验证改后缀时的保稿与卸载，I/O 使用替身。
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/core/ipc/commands';
import { CodeEditor } from '@/features/editor-code/CodeEditor';
import { TipTapEditor } from '@/features/editor-md/TipTapEditor';
import { ExternalChangeDialog } from '@/features/external/ExternalChangeDialog';
import { TooltipProvider } from '@/components/Tooltip';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { getMdSourceView, getMdTipTapEditor } from '@/features/editor-md/editorInstances';
import { renameOpenFile } from '@/features/explorer/renameOpenFile';

vi.mock('@/features/external/useExternalFileChanges', () => ({ useExternalFileChanges: () => {} }));
vi.mock('@/core/ipc/commands', async (original) => ({
  ...await original<typeof import('@/core/ipc/commands')>(),
  readDocument: vi.fn(), renamePath: vi.fn().mockResolvedValue(undefined),
  writeDocument: vi.fn(), setDocumentDirty: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/features/editor-md/markdownAutoSave', () => ({ autoSaveDocument: vi.fn() }));
vi.mock('@/features/editor-md/extensions', async () => {
  const { buildCoreExtensions } = await import('@/features/editor-md/extensions/core');
  return { buildExtensions: buildCoreExtensions };
});

const originalRect = Range.prototype.getBoundingClientRect;
const originalRects = Range.prototype.getClientRects;

/** 跟随生产标签元数据选择真实编辑器，保持与桌面/移动共用堆栈相同的 key 生命周期。 */
function Editors() {
  const tab = useWindowStore((state) => state.tabs[0]);
  return <TooltipProvider>{tab && <div key={tab.key}>{tab.kind === 'markdown'
    ? <TipTapEditor docKey={tab.key} /> : <CodeEditor docKey={tab.key} />}</div>}<ExternalChangeDialog /></TooltipProvider>;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
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

it.each(['text', 'visual', 'source'] as const)('%s：未防抖输入在改名后保留，重载换编辑器不被旧卸载覆盖', async (mode) => {
  const markdown = mode !== 'text';
  const key = `C:\\notes\\切换.${markdown ? 'md' : 'txt'}`;
  const newName = `切换.${markdown ? 'txt' : 'md'}`;
  const newKey = `C:\\notes\\${newName}`;
  const payload = { key, displayName: key.split('\\').pop()!, dirPath: 'C:\\notes',
    kind: markdown ? 'markdown' as const : 'code' as const,
    language: markdown ? 'markdown' as const : 'plaintext' as const,
    content: '# 磁盘版本\n', encoding: 'utf8' as const, eol: 'lf' as const, size: 12, mtime: 1, readonly: false };
  useDocumentStore.getState().upsertFromPayload(payload);
  useWindowStore.getState().openTab({ key, path: key, displayName: payload.displayName, kind: payload.kind,
    language: payload.language, viewMode: mode === 'text' ? null : mode,
    isDirty: false, isPreview: false, externalStatus: 'clean', isDetached: false });
  vi.mocked(ipc.readDocument).mockResolvedValue({ ...payload, key: newKey, displayName: newName,
    kind: markdown ? 'code' : 'markdown', language: markdown ? 'plaintext' : 'markdown' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Editors />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    await act(async () => {
      if (mode === 'visual') getMdTipTapEditor(key)!.commands.insertContent('尚未保存');
      else {
        const view = mode === 'source' ? getMdSourceView(key)!
          : EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
        view.dispatch({ changes: { from: 0, insert: '尚未保存' } });
      }
      await renameOpenFile(key, newKey, newName);
    });
    expect(useDocumentStore.getState().getDocument(newKey)?.content).toContain('尚未保存');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('文件后缀已更改');
    await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === '重新加载')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    expect(useDocumentStore.getState().getDocument(newKey)).toMatchObject({ content: payload.content,
      baselineContent: payload.content, externalStatus: 'clean', isDirty: false });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const content = markdown ? EditorView.findFromDOM(host.querySelector('.cm-editor')!)!.state.doc.toString()
      : getMdTipTapEditor(newKey)!.getText();
    expect(content).toContain('磁盘版本');
    expect(content).not.toContain('尚未保存');
    expect(ipc.writeDocument).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
