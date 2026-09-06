// NoteBoard 🔴 N08 宿主级卸载断言
// 覆盖：进入 Home（activeKey=null）不卸载已打开文档的编辑器实例——
//       Home 与编辑器容器并存；不可回收类型的实例保持挂载（display:none 不卸载组件）。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// ── 子组件替身（隔离 Tauri IPC 与编辑器内核；记录真实挂载/卸载生命周期） ──
const hostLog: string[] = [];
vi.mock('@/features/editor-host/EditorHost', async () => {
  const { useEffect } = await import('react');
  return {
    EditorHost: ({ tab }: { tab: { key: string } }) => {
      // 记录真实挂载/卸载（useEffect 生命周期），渲染重入不重复计数
      useEffect(() => {
        hostLog.push(`mount:${tab.key}`);
        return () => {
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
vi.mock('@/features/session/editorSuspension', () => ({
  suspendEditorInstance: vi.fn().mockResolvedValue(false),
  markClosed: vi.fn(),
  getKeepAliveKey: vi.fn(() => null),
}));

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

describe('🔴 N08 Home 不卸载已打开编辑器（宿主级断言）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    hostLog.length = 0;
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [], pendingCloseKeys: [] });
    useLayoutStore.setState({ explorerVisible: false, outlineVisible: false, statusBarVisible: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it('打开标签 → 进入 Home（activeKey=null）→ 返回：编辑器实例全程未卸载', async () => {
    // 1. 打开 Markdown 标签（不可回收类型 canSuspend=false，S12 保留实例）
    const tab = mockTab('doc-a');
    act(() => {
      useWindowStore.setState({ tabs: [tab], activeKey: 'doc-a' });
    });
    await act(async () => {
      root.render(<AppShell />);
    });
    expect(hostLog).toContain('mount:doc-a');
    const mountedCount = hostLog.length;

    // 2. 进入 Home：activeKey 置 null（用户点击 Home/关闭活动标签语义）
    await act(async () => {
      useWindowStore.setState({ activeKey: null });
    });
    // Home 可见（WelcomeScreen 渲染）
    expect(container.querySelector('[data-testid="welcome"]')).not.toBeNull();
    // 🔴 核心断言：已打开文档的编辑器未卸载（无 unmount 记录、无重复挂载）
    expect(hostLog.filter((entry) => entry.startsWith('unmount:'))).toEqual([]);
    expect(hostLog.length).toBe(mountedCount);
    // 编辑器容器仍然在 DOM 中（display:none 视觉隐藏，不是卸载）
    expect(container.querySelector('[data-host="doc-a"]')).not.toBeNull();

    // 3. 返回文档：Home 消失，编辑器仍挂载（没有重建）
    await act(async () => {
      useWindowStore.setState({ activeKey: 'doc-a' });
    });
    expect(container.querySelector('[data-testid="welcome"]')).toBeNull();
    expect(hostLog.filter((entry) => entry.startsWith('unmount:'))).toEqual([]);
    expect(hostLog.filter((entry) => entry === 'mount:doc-a')).toHaveLength(1);

    act(() => {
      root.unmount();
    });
  });

  it('多标签混合场景：Home 期间全部已打开编辑器保持挂载', async () => {
    const tabs = [mockTab('md-a'), mockTab('code-b'), mockTab('code-c')];
    act(() => {
      useWindowStore.setState({ tabs, activeKey: 'code-c' });
    });
    await act(async () => {
      root.render(<AppShell />);
    });
    expect(hostLog.filter((e) => e.startsWith('mount:')).length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      useWindowStore.setState({ activeKey: null });
    });
    expect(container.querySelector('[data-testid="welcome"]')).not.toBeNull();
    // 🔴 Home 期间零卸载
    expect(hostLog.filter((entry) => entry.startsWith('unmount:'))).toEqual([]);

    act(() => {
      root.unmount();
    });
  });
});
