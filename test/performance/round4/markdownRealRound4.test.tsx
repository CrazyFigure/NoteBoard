// 真实 React、TipTapEditor、VisualKernel、TipTap 内核及 Markdown 解析；无用户数据/文件 I/O。
// 只把扩展装配缩到正文所需集合，隔离图表、拖动和菜单，以定位协调器初始化时序。
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TipTapEditor } from '@/features/editor-md/TipTapEditor';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { getMdTipTapEditor, getMdSourceView } from '@/features/editor-md/editorInstances';
import { resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { clearAllDocumentHistories } from '@/features/history/documentHistory';
vi.mock('@/features/editor-md/extensions', async () => {
  const { default: StarterKit } = await import('@tiptap/starter-kit');
  const { Markdown } = await import('@tiptap/markdown');
  return { buildExtensions: () => [StarterKit, Markdown] };
});
vi.mock('@/features/editor-md/bubbleMenu', () => ({ EditorBubbleMenu: () => null, TableToolbar: () => null }));
vi.mock('@/features/editor-md/blockDragHandle', () => ({ BlockDragHandle: () => null }));
vi.mock('@/features/editor-md/EditorContextMenu', () => ({ EditorContextMenu: () => null }));
vi.mock('@/features/editor-md/LinkModal', () => ({ LinkModal: () => null }));
vi.mock('@/features/editor-md/MarkdownModeToggle', () => ({ MarkdownModeToggle: () => null }));
vi.mock('@/features/editor-md/ExternalChangeBanner', () => ({ ExternalChangeBanner: () => null }));
vi.mock('@/features/editor-md/imagePaste', () => ({ handlePastedImageFile: vi.fn() }));
vi.mock('@/features/editor-md/markdownAutoSave', () => ({ autoSaveDocument: vi.fn() }));
vi.mock('@/core/shortcuts', () => ({ registerShortcut: () => () => {} }));

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  useDocumentStore.setState({ documents: new Map() }); useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
  resetEditorRegistryForTest(); clearAllDocumentHistories();
});
afterEach(() => { vi.restoreAllMocks(); });

it.each([false, true])('D01：真实 Markdown 首开应自动显示正文，StrictMode=%s', async strict => {
  const key = `C:/round4/real-${strict}.md`, text = 'first-open-visible-content';
  useDocumentStore.getState().upsertFromPayload({ key, displayName: 'real.md', dirPath: 'C:/round4', kind: 'markdown', language: 'markdown', content: text, encoding: 'utf8', eol: 'lf', size: text.length, mtime: 0, readonly: false });
  useWindowStore.getState().openTab({ key, path: key, displayName: 'real.md', kind: 'markdown', language: 'markdown', isDirty: false, isPreview: false, viewMode: 'visual', externalStatus: null, isDetached: false });
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(strict ? <StrictMode><TipTapEditor docKey={key} /></StrictMode> : <TipTapEditor docKey={key} />); });
    // 等待真实 useEditor 的内部调度，未模拟 tab 切走/切回。
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(getMdTipTapEditor(key)?.getText()).toBe(text);
    expect(host.textContent).toContain(text);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('D02：大文档携带 visual 标签模式时不能既无 visual 又无 source 内核', async () => {
  const key = 'C:/round4/large-visual.md', text = 'x'.repeat(210001);
  useDocumentStore.getState().upsertFromPayload({ key, displayName: 'large.md', dirPath: 'C:/round4', kind: 'markdown', language: 'markdown', content: text, encoding: 'utf8', eol: 'lf', size: text.length, mtime: 0, readonly: false });
  useWindowStore.getState().openTab({ key, path: key, displayName: 'large.md', kind: 'markdown', language: 'markdown', isDirty: false, isPreview: false, viewMode: 'visual', externalStatus: null, isDetached: false });
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<TipTapEditor docKey={key} />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    const loadedLength = getMdSourceView(key)?.state.doc.length ?? getMdTipTapEditor(key)?.getText().length ?? 0;
    expect(loadedLength).toBe(text.length);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
