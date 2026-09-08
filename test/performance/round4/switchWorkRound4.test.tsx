// 三轮复审宿主反例：保留真实 AppShell 和回收调度，只替换编辑器内核与无关 UI。

import { it, expect, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

// ── 子组件替身（隔离 Tauri IPC 与编辑器内核；记录真实挂载/卸载生命周期） ──
const hostLog: string[] = [];
const flushLog: string[] = [];
vi.mock('@/features/editor-host/EditorHost', async () => {
  const { useEffect } = await import('react');
  const { registerEditorCapabilities } = await import('@/core/editor/editorRegistry');
  return {
    EditorHost: ({ tab }: { tab: { key: string } }) => {
      // 记录真实挂载/卸载（useEffect 生命周期），渲染重入不重复计数
      useEffect(() => {
        hostLog.push(`mount:${tab.key}`);
        // 每个轻量替身可安全回收，真实调度器决定最终保留集合。
        const dispose = registerEditorCapabilities({ docKey: tab.key, instanceId: tab.key, getRevision: () => 0, flush: async () => (flushLog.push(tab.key), { docKey: tab.key, instanceId: tab.key, revision: 0, content: 'text' }), canSuspend: () => true, focus() {}, getSelectedText: () => '' });
        return () => {
          dispose();
          hostLog.push(`unmount:${tab.key}`);
        };
      }, [tab.key]);
      return <div data-host={tab.key} />;
    },
  };
});
vi.mock('@/components/titlebar/TitleBar', () => ({ TitleBar: () => null }));
vi.mock('@/components/statusbar/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('@/components/WelcomeScreen', () => ({
  WelcomeScreen: () => <div data-testid="welcome" />,
}));
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
// AppShell 依赖的编排模块（避免真实 Tauri 调用链）
vi.mock('@/features/welcome/welcomeActions', () => ({
  openFileDialog: vi.fn(), openFolderDialog: vi.fn(), openStagingArea: vi.fn(),
  newMarkdown: vi.fn(), newMindmap: vi.fn(), newDrawio: vi.fn(), newBitable: vi.fn(),
  newBoard: vi.fn(), newMermaid: vi.fn(), newPlantUml: vi.fn(), newInfographic: vi.fn(),
  newJson: vi.fn(), newYaml: vi.fn(), newSql: vi.fn(), newXml: vi.fn(), newText: vi.fn(),
}));
vi.mock('@/features/editor-code/orchestration/saveDocument', () => ({
  saveDocument: vi.fn(), takeLastSaveIdentityMove: vi.fn(() => null),
}));
vi.mock('@/features/window/windowManager', () => ({ performWindowClose: vi.fn() }));
vi.mock('@/features/staging/stagingManager', () => ({
  discardStagedDocuments: vi.fn(), stashPendingDocuments: vi.fn(),
}));
vi.mock('@/features/session/closedWindowSession', () => ({
  saveCurrentWindowSnapshot: vi.fn(),
  loadRestoredTab: vi.fn(),
}));
vi.mock('@/features/external/missingFileGuard', () => ({
  checkActiveDocumentStillExists: vi.fn().mockResolvedValue(undefined),
}));
import { resetSuspensionForTest } from '@/features/session/editorSuspension';

import { AppShell } from '@/components/AppShell';
import { useWindowStore, type Tab } from '@/stores/windowStore';
import { useLayoutStore } from '@/stores/layoutStore';

// react-resizable-panels 在挂载时使用 ResizeObserver（jsdom 缺失，补最小 stub）
class ResizeObserverStub {
  observe(): void { /* jsdom 无布局 */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

function mockTab(key: string): Tab {
  return {
    key,
    displayName: `${key}.md`,
    path: `C:\\t\\${key}.md`,
    kind: 'markdown',
    language: 'markdown',
    isDirty: false,
    isPreview: false,
    viewMode: 'visual',
    externalStatus: null,
    isDetached: false,
  };
}

// 验证活动+最近一个预算，以及单纯脏态更新不应撤销已完成的回收。
// 两个热标签均未卸载时，切换不应反复要求全文 flush。
it('D03：两个未编辑的热标签往返仍会触发无必要全文捕获', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetSuspensionForTest();
  useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [], pendingCloseKeys: [] });
  useLayoutStore.setState({ explorerVisible: false, outlineVisible: false, statusBarVisible: false });
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<AppShell />));
    for (const key of ['warm-a','warm-b']) await act(async () => { useWindowStore.getState().openTab(mockTab(key)); });
    flushLog.length = 0;
    await act(async () => { useWindowStore.getState().activateTab('warm-a'); });
    await act(async () => { useWindowStore.getState().activateTab('warm-b'); });
    expect(host.querySelectorAll('[data-host]').length).toBe(2);
    expect(flushLog).toEqual([]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});