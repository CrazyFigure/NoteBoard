// 三轮复审反例（正式迁入自 test-results/performance/review-20260906-round3/）——断言为整改后正确行为。
// 三轮复审宿主反例：保留真实 AppShell 和回收调度，只替换编辑器内核与无关 UI。

import { it, expect, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

// ── 子组件替身（隔离 Tauri IPC 与编辑器内核；记录真实挂载/卸载生命周期） ──
const hostLog: string[] = [];
vi.mock('@/features/editor-host/EditorHost', async () => {
  const { useEffect } = await import('react');
  const { registerEditorCapabilities } = await import('@/core/editor/editorRegistry');
  return {
    EditorHost: ({ tab }: { tab: { key: string } }) => {
      // 记录真实挂载/卸载（useEffect 生命周期），渲染重入不重复计数
      useEffect(() => {
        hostLog.push(`mount:${tab.key}`);
        // 每个轻量替身可安全回收，真实调度器决定最终保留集合。
        const dispose = registerEditorCapabilities({ docKey: tab.key, instanceId: tab.key, getRevision: () => 0, flush: async () => ({ docKey: tab.key, instanceId: tab.key, revision: 0, content: 'text' }), canSuspend: () => true, focus() {}, getSelectedText: () => '' });
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

// 用户已明确改为保活到关闭，原“两实例”要求不再适用；改验切换/脏态不重建、关闭仅释放目标。
it('C15：已打开的四个标签切换及脏态更新均保持实例，关闭只卸载目标', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetSuspensionForTest();
  hostLog.length = 0;
  useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [], pendingCloseKeys: [] });
  useLayoutStore.setState({ explorerVisible: false, outlineVisible: false, statusBarVisible: false });
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(<AppShell />); });
    for (const key of ['a', 'b', 'c', 'd']) {
      await act(async () => { useWindowStore.getState().openTab(mockTab(key)); });
    }
    const afterSwitch = host.querySelectorAll('[data-host]').length;
    await act(async () => { useWindowStore.getState().setTabDirty('d', true); });
    const afterTyping = host.querySelectorAll('[data-host]').length;
    expect({ afterSwitch, afterTyping }).toEqual({ afterSwitch: 4, afterTyping: 4 });
    // 多轮往返不会对热标签执行卸载或重新挂载。
    for (const key of ['a', 'c', 'b', 'd', 'a']) {
      await act(async () => { useWindowStore.getState().activateTab(key); });
    }
    expect(hostLog).toEqual(['mount:a', 'mount:b', 'mount:c', 'mount:d']);
    // 此处验证渲染层移除；真实关闭写屏障与生命周期由 session 测试覆盖。
    await act(async () => { useWindowStore.setState(state => ({ tabs: state.tabs.filter(tab => tab.key !== 'b') })); });
    expect(hostLog).toEqual(['mount:a', 'mount:b', 'mount:c', 'mount:d', 'unmount:b']);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
