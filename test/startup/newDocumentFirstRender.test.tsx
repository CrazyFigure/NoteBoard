// NoteBoard 🔴 P0-1 新建 MD 首次挂载即应显示（用户真机反馈：新建后须切走再切回才能打开）
// 真实 TipTapEditor/VisualKernel/TipTap 内核 + 真实新建数据形态（untitled key、
// content=''、viewMode=null——与 welcomeActions.createUntitledDocument 完全一致）。
// 覆盖：新建后正文区立即可输入（无需切换）；新建后再开第二个文档两者都正常。

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TipTapEditor } from '@/features/editor-md/TipTapEditor';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { getMdTipTapEditor } from '@/features/editor-md/editorInstances';
import { resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { clearAllDocumentHistories } from '@/features/history/documentHistory';
import { resetSuspensionForTest, saveViewState } from '@/features/session/editorSuspension';
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
vi.mock('@/core/shortcuts', () => ({ registerShortcut: () => () => {}, formatShortcut: (text: string) => text }));

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom 未实现 Range 几何 API；TipTap 的 focus().scrollIntoView() 会异步读取它。
  // 补齐稳定空矩形，确保测试覆盖真实聚焦链路且不会在用例结束后留下未处理异常。
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  }
  useDocumentStore.setState({ documents: new Map() }); useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
  resetEditorRegistryForTest(); clearAllDocumentHistories(); resetSuspensionForTest();
});
afterEach(() => { vi.restoreAllMocks(); });

// 与 welcomeActions.createUntitledDocument 相同的数据形态（content=''、viewMode=null）
function seedUntitled(n: number, content = ''): string {
  const key = `untitled:markdown-${n}`;
  useDocumentStore.getState().upsertFromPayload({
    key, displayName: '未命名.md', dirPath: '', kind: 'markdown', language: 'markdown',
    content, encoding: 'utf8', eol: 'lf', size: content.length, mtime: 0, readonly: false,
  });
  useWindowStore.getState().openTab({
    key, displayName: '未命名.md', path: null, kind: 'markdown', language: 'markdown',
    isDirty: false, isPreview: false, viewMode: null, externalStatus: null, isDetached: false,
  });
  return key;
}

describe('🔴 P0-1 新建 MD 首次挂载即显示', () => {
  it.each([false, true])('长文首次打开从头开始，存在恢复点时保留选区和滚动（恢复=%s）', async (restore) => {
    const content = Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 段正文`).join('\n\n');
    const key = seedUntitled(3, content);
    // 回收后的旧光标可能在当前阅读视口之外，自动聚焦不能再次滚动到该光标。
    if (restore) saveViewState(key, {
      kind: 'markdown', mode: 'visual', selection: { anchor: 400, head: 420 }, scrollTop: 321,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<TipTapEditor docKey={key} />); });
      const editor = getMdTipTapEditor(key)!;
      expect(editor).not.toBeNull();
      // 捕获真正的 ProseMirror 滚动请求，覆盖 20ms 聚焦定时器及后续动画帧。
      const handleScrollToSelection = vi.fn(() => true);
      editor.view.setProps({ handleScrollToSelection });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
      expect(editor.state.selection.anchor).toBe(restore ? 400 : 1);
      expect(editor.state.selection.head).toBe(restore ? 420 : 1);
      expect(host.querySelector('.nb-md-visual-scroller')?.scrollTop).toBe(restore ? 321 : 0);
      expect(handleScrollToSelection).not.toHaveBeenCalled();
      expect(useDocumentStore.getState().getDocument(key)?.isDirty).toBe(false);
      expect(useDocumentStore.getState().getDocument(key)?.content).toBe(content);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('新建文档（空正文、viewMode=null）：挂载后无需切换即可输入', async () => {
    const key = seedUntitled(1);
    const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
    try {
      await act(async () => { root.render(<TipTapEditor docKey={key} />); });
      // 等待真实 useEditor 的内部调度（与 D01 相同等待方式）
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
      // 🔴 用户契约：新建后编辑器立即可用（可输入）——不须切走再切回
      const editor = getMdTipTapEditor(key);
      expect(editor).not.toBeNull();
      expect(editor!.isDestroyed).toBe(false);
      expect(editor!.isEditable).toBe(true);
      // 首笔输入立即生效（isInitializingRef 已解锁）
      let typed = false;
      await act(async () => {
        typed = editor!.chain().focus().insertContent('首笔输入').run();
      });
      expect(typed).toBe(true);
      expect(editor!.getText()).toContain('首笔输入');
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it('新建后再新建第二个：两个文档挂载都正常（各自独立实例）', async () => {
    const key1 = seedUntitled(1);
    const key2 = seedUntitled(2);
    const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          <div>
            <TipTapEditor docKey={key1} />
            <TipTapEditor docKey={key2} />
          </div>,
        );
      });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
      expect(getMdTipTapEditor(key1)?.isEditable).toBe(true);
      expect(getMdTipTapEditor(key2)?.isEditable).toBe(true);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});
