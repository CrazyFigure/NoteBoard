// NoteBoard 🔴 P0-1 AppShell 级新建 MD：真实顺序（先渲染空壳 → 点击新建 → 首次挂载即显示）
// 真实 AppShell + 真实 EditorHost/TipTapEditor/VisualKernel/TipTap 内核 + 真实 welcomeActions.newMarkdown；
// 只隔离 Tauri IPC（内存替身）与无关 UI 组件。对应用户真机反馈：新建后须切走再切回才能打开。

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getMdTipTapEditor } from '@/features/editor-md/editorInstances';
import { resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { resetSuspensionForTest } from '@/features/session/editorSuspension';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { useLayoutStore } from '@/stores/layoutStore';

// Tauri IPC 内存替身（不访问正式数据/磁盘）
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'review' }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({
  loadSettings: vi.fn().mockResolvedValue(null),
  setDocumentDirty: vi.fn().mockResolvedValue(undefined),
  writeDocument: vi.fn().mockResolvedValue({ ok: true, size: 0, mtime: 1 }),
  unregisterDocument: vi.fn().mockResolvedValue(undefined),
  registerDocument: vi.fn().mockResolvedValue({ type: 'ok' }),
  readTextFile: vi.fn(),
  pathExists: vi.fn(),
  isPerfSpansEnabled: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/features/staging/stagingManager', () => ({ onDocumentSaved: vi.fn().mockResolvedValue(undefined), getStagedPath: vi.fn(), discardStagedDocuments: vi.fn(), stashPendingDocuments: vi.fn() }));
vi.mock('@/features/explorer/directoryWatcher', () => ({ noteSelfWrite: vi.fn() }));

// 无关 UI 组件替身（保持 AppShell 结构）
vi.mock('@/components/titlebar/TitleBar', () => ({ TitleBar: () => null }));
vi.mock('@/components/statusbar/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('@/components/WelcomeScreen', () => ({ WelcomeScreen: ({ onNewMarkdown }: { onNewMarkdown: () => void }) => <button data-testid="new-md" onClick={onNewMarkdown}>新建</button> }));
vi.mock('@/components/UnsupportedView', () => ({ UnsupportedView: () => null }));
vi.mock('@/components/Toast', () => ({ ToastContainer: () => null }));
vi.mock('@/components/rail/RailToggle', () => ({ RailToggle: () => null }));
vi.mock('@/components/FileDropOverlay', () => ({ FileDropOverlay: () => null }));
vi.mock('@/features/outline/OutlinePanel', () => ({ OutlinePanel: () => null }));
vi.mock('@/features/editor-code/UnsavedGuardDialog', () => ({ UnsavedGuardDialog: () => null }));
vi.mock('@/features/explorer/Explorer', () => ({ Explorer: () => null }));
vi.mock('@/features/search/SearchReplaceBar', () => ({ SearchReplaceBar: () => null }));
vi.mock('@/features/toolbar/EditorToolbar', () => ({ EditorToolbar: () => null }));
vi.mock('@/features/external/MissingFileDialog', () => ({ MissingFileDialog: () => null }));
vi.mock('@/features/window/windowManager', () => ({ performWindowClose: vi.fn() }));
vi.mock('@/features/session/closedWindowSession', () => ({
  saveCurrentWindowSnapshot: vi.fn(),
  loadRestoredTab: vi.fn(),
}));
vi.mock('@/features/external/missingFileGuard', () => ({
  checkActiveDocumentStillExists: vi.fn().mockResolvedValue(undefined),
}));
// Markdown 专属 UI 替身（内核真实）
vi.mock('@/features/editor-md/extensions', async () => {
  const { default: StarterKit } = await import('@tiptap/starter-kit');
  const { Markdown } = await import('@tiptap/markdown');
  // 🔴 与真实 buildExtensions 一致：每次调用创建新扩展实例（不共享对象——
  //    共享实例会被并发渲染/多实例共享 plugin 状态，属测试假差异）
  return { buildExtensions: () => [StarterKit.configure({}), Markdown.configure({})] };
});
vi.mock('@/features/editor-md/bubbleMenu', () => ({ EditorBubbleMenu: () => null, TableToolbar: () => null }));
vi.mock('@/features/editor-md/blockDragHandle', () => ({ BlockDragHandle: () => null }));
vi.mock('@/features/editor-md/EditorContextMenu', () => ({ EditorContextMenu: () => null }));
vi.mock('@/features/editor-md/LinkModal', () => ({ LinkModal: () => null }));
vi.mock('@/features/editor-md/imagePaste', () => ({ handlePastedImageFile: vi.fn() }));
vi.mock('@/features/editor-md/markdownAutoSave', () => ({ autoSaveDocument: vi.fn() }));

import { AppShell } from '@/components/AppShell';

import { resetEditorResourcesForTest, getEditorLoadDiagnostics, getEditorResourceStatus, prefetchEditor } from '@/features/editor-host/editorLoaders';

class ResizeObserverStub {
  observe(): void { /* jsdom 无布局 */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  resetSuspensionForTest(); resetEditorRegistryForTest(); resetEditorResourcesForTest();
  useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [], pendingCloseKeys: [] });
  useDocumentStore.setState({ documents: new Map() });
  useLayoutStore.setState({ explorerVisible: false, outlineVisible: false, statusBarVisible: false });
});
afterEach(() => { vi.restoreAllMocks(); });

it('新建 MD（真实顺序：空壳渲染 → 点击新建）：首次挂载即可编辑，无须切换', { timeout: 30000 }, async () => {
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<AppShell />));
    // 🔴 真实用户操作顺序：应用已渲染（空 tabs）→ 点击"新建 Markdown"
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="new-md"]')!.click();
    });
    // 等待真实模块加载 + useEditor 调度
    await act(async () => { await vi.dynamicImportSettled(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });

    const activeKey = useWindowStore.getState().activeKey;
    expect(activeKey).toBeTruthy();
    // 🔴 用户契约：新建后立即可输入（无需切换）
    const editor = activeKey ? getMdTipTapEditor(activeKey) : null;
    expect(editor).not.toBeNull();
    expect(editor!.isEditable).toBe(true);
    // 正文区 contenteditable 已在 DOM 中（活动标签可见）
    const editable = host.querySelector('[contenteditable="true"]');
    expect(editable).not.toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('🔴 P0-1b 预取后新建：资源已 ready 的挂载不提交模块加载 fallback（1s 内目标的机制保障）', { timeout: 30000 }, async () => {
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  try {
    // 本文件的 WelcomeScreen 是替身（无预取 effect）——直接调用预取模拟
    // "欢迎页空闲预取已完成"（真实组件的预取行为由 src 代码保证）
    prefetchEditor('markdown');
    await act(async () => root.render(<AppShell />));
    await vi.waitFor(() => {
      expect(getEditorResourceStatus('markdown').status).toBe('ready');
    }, { timeout: 10000 });
    const fallbacksBefore = getEditorLoadDiagnostics().fallbacks;
    // 点击新建：资源 ready 的挂载同步渲染——fallback 计数不增长
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="new-md"]')!.click();
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(getEditorLoadDiagnostics().fallbacks).toBe(fallbacksBefore);
    const activeKey = useWindowStore.getState().activeKey;
    expect(getMdTipTapEditor(activeKey ?? '')?.isEditable).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
