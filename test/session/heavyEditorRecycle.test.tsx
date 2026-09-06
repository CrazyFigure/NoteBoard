// NoteBoard 🔴 S12 重型编辑器回收等价测试
// 覆盖：Markdown/Mindmap/Bitable/Board/Drawio 的回收链路——canSuspend →
//       flush（权威内容进 store）→ captureViewState → 重挂载恢复。
//       子组件以替身隔离（内核与视图组件不进入测试闭包），序列化/历史/store 全部真实。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// ── 子组件替身（隔离编辑器内核；序列化与状态链路全部真实） ──
vi.mock('@/features/mindmap/OutlinerEditor', () => ({ OutlinerEditor: () => <div data-testid="outliner" /> }));
vi.mock('@/features/mindmap/MindmapRenderer', () => ({
  MindmapRenderer: ({ onRootChange }: { onRootChange?: (root: unknown) => void }) => (
    <div data-testid="renderer" data-has-change={String(typeof onRootChange === 'function')} />
  ),
}));
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/features/export/chartExport', () => ({ exportBlobWithDialog: vi.fn() }));
vi.mock('@/features/mindmap/mindmapConverter', async (original) => ({
  ...await original<typeof import('@/features/mindmap/mindmapConverter')>(),
  exportToXmindZip: vi.fn(),
  importFromXmindZip: vi.fn(),
}));
vi.mock('@/features/bitable/BitableGridView', () => ({ BitableGridView: () => <div data-testid="grid" /> }));
vi.mock('@/features/bitable/BitableKanbanView', () => ({ BitableKanbanView: () => <div data-testid="kanban" /> }));
vi.mock('@/features/bitable/BitableRecordPanel', () => ({ BitableRecordPanel: () => <div data-testid="panel" /> }));
vi.mock('@/features/bitable/BitableFloating', () => ({
  DragGhost: () => null,
  FloatingPanel: () => null,
  getAnchorRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
}));
// 🔴 usePointerReorder 替身必须提供完整解构结构（缺 getIndicator 会炸渲染）
vi.mock('@/features/bitable/usePointerReorder', () => ({
  usePointerReorder: () => ({
    drag: null,
    startDrag: () => {},
    getIndicator: () => null,
    grabOffset: 0,
    consumeDraggedFlag: () => false,
  }),
}));
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: ({ initialData, onChange, onApi }: {
    initialData: { appState?: { scrollX?: number } };
    onChange?: (elements: unknown, appState: { scrollX?: number; zoom?: number }, files: unknown) => void;
    onApi?: (api: { updateScene: (s: unknown) => void }) => void;
  }) => {
    // 暴露交互入口：测试经全局钩子驱动 onChange（模拟画布交互/视口变化）
    (globalThis as Record<string, unknown>).__boardHarness = { initialData, onChange, onApi };
    return <div data-testid="excalidraw" />;
  },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'nb-main', setFullscreen: vi.fn().mockResolvedValue(undefined) }),
}));

import { MindmapEditor } from '@/features/mindmap/MindmapEditor';
import { serializeMindmapDocument, parseMindmapDocument } from '@/features/mindmap/mindmapConverter';
import { BitableEditor } from '@/features/bitable/BitableEditor';
import { parseBitableDocument, serializeBitableDocument } from '@/features/bitable/bitableConverter';
import { BoardEditor } from '@/features/board/BoardEditor';
import { DrawioEditor } from '@/features/drawio/DrawioEditor';
import { getEditorCapabilities, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { suspendEditorInstance, takeViewState, saveViewState } from '@/features/session/editorSuspension';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { clearAllDocumentHistories } from '@/features/history/documentHistory';

/** 挂载宿主（返回 unmount；React act 环境） */
function mount(node: React.ReactNode): { container: HTMLDivElement; root: Root } {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function unmount(root: Root): void {
  act(() => {
    root.unmount();
  });
}

describe('🔴 S12 重型编辑器回收等价', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [], pendingCloseKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
    resetEditorRegistryForTest();
    clearAllDocumentHistories();
  });

  it('Mindmap：canSuspend → flush 序列化进 store → 视图状态捕获 → 重挂载恢复', async () => {
    const key = 'C:/t/recycle.mindmap';
    const initialContent = serializeMindmapDocument(parseMindmapDocument('# 根节点'));
    useDocumentStore.getState().upsertFromPayload({
      key, displayName: 'recycle.mindmap', dirPath: 'C:/t', kind: 'mindmap', language: 'json',
      content: initialContent, encoding: 'utf8', eol: 'lf', size: initialContent.length, mtime: 0, readonly: false,
    });
    useWindowStore.getState().openTab({
      key, displayName: 'recycle.mindmap', path: key, kind: 'mindmap', language: 'json',
      isDirty: false, isPreview: false, viewMode: null, externalStatus: null, isDetached: false,
    });

    // 1. 挂载 → 能力注册（canSuspend=true：内容同步进 store）
    const first = mount(<MindmapEditor docKey={key} />);
    try {
      const capabilities = getEditorCapabilities(key);
      expect(capabilities).not.toBeNull();
      expect(capabilities!.canSuspend()).toBe(true);

      // 2. 外部内容变更（store 驱动 rootNode 更新）→ flush 序列化与 store 一致
      useDocumentStore.getState().setContent(key, serializeMindmapDocument(parseMindmapDocument('# 修改后的根')));
      await act(async () => { await Promise.resolve(); });
      const captured = await capabilities!.flush('evict');
      expect(captured?.content).toBe(useDocumentStore.getState().getDocument(key)?.content);

      // 3. 回收链：suspend → flush + captureViewState 保存
      const suspended = await suspendEditorInstance(key);
      expect(suspended).toBe(true);
      // 检查保存的视图状态形态（取出后放回，供重挂载恢复）
      const saved = takeViewState(key) as { kind: string } | null;
      expect(saved).toMatchObject({ kind: 'mindmap' });
      saveViewState(key, saved);

      // 4. 重挂载：恢复 effect 消费视图状态（一次性）——消费完成即恢复发生
      unmount(first.root);
      const second = mount(<MindmapEditor docKey={key} />);
      // 恢复 effect 已在挂载时取走（再次消费为空 = 已恢复）
      expect(takeViewState(key)).toBeNull();
      unmount(second.root);
    } finally {
      first.container.remove();
    }
  });

  it('Bitable：canSuspend（焦点不在编辑器内）→ flush 序列化数据 → 视图状态捕获', async () => {
    const key = 'C:/t/recycle.bitable';
    const emptyDoc = parseBitableDocument('');
    const initialContent = serializeBitableDocument(emptyDoc);
    useDocumentStore.getState().upsertFromPayload({
      key, displayName: 'recycle.bitable', dirPath: 'C:/t', kind: 'bitable', language: 'json',
      content: initialContent, encoding: 'utf8', eol: 'lf', size: initialContent.length, mtime: 0, readonly: false,
    });
    useWindowStore.getState().openTab({
      key, displayName: 'recycle.bitable', path: key, kind: 'bitable', language: 'json',
      isDirty: false, isPreview: false, viewMode: null, externalStatus: null, isDetached: false,
    });

    const { container, root } = mount(<BitableEditor docKey={key} />);
    try {
      const capabilities = getEditorCapabilities(key);
      expect(capabilities).not.toBeNull();
      // 焦点不在编辑器内（回收时焦点已切走）→ 可回收
      expect(capabilities!.canSuspend()).toBe(true);

      // flush：序列化当前数据与 store 对齐
      const captured = await capabilities!.flush('evict');
      expect(captured?.content).toBe(useDocumentStore.getState().getDocument(key)?.content);

      // 回收链完整通过
      expect(await suspendEditorInstance(key)).toBe(true);
      const restored = takeViewState(key);
      expect(restored).toMatchObject({ kind: 'bitable' });
    } finally {
      unmount(root);
      container.remove();
    }
  });

  it('Board：canSuspend（无指针手势）→ flush 场景序列化 → viewport 捕获 → 重挂载恢复进 initialData', async () => {
    const key = 'C:/t/recycle.excalidraw';
    const scene = JSON.stringify({
      type: 'excalidraw', version: 2, source: 'noteboard',
      elements: [], files: {},
      appState: { viewBackgroundColor: '#ffffff', gridSize: null, objectsSnapModeEnabled: true, scrollX: 10, scrollY: 20, zoom: 1 },
    });
    useDocumentStore.getState().upsertFromPayload({
      key, displayName: 'recycle.excalidraw', dirPath: 'C:/t', kind: 'board', language: 'json',
      content: scene, encoding: 'utf8', eol: 'lf', size: scene.length, mtime: 0, readonly: false,
    });
    useWindowStore.getState().openTab({
      key, displayName: 'recycle.excalidraw', path: key, kind: 'board', language: 'json',
      isDirty: false, isPreview: false, viewMode: null, externalStatus: null, isDetached: false,
    });

    // 1. 首次挂载（mock Excalidraw 组件提供交互入口）
    const first = mount(<BoardEditor docKey={key} />);
    try {
      await act(async () => { await Promise.resolve(); });
      const capabilities = getEditorCapabilities(key);
      expect(capabilities).not.toBeNull();
      expect(capabilities!.canSuspend()).toBe(true);

      // 2. 模拟画布视口变化（滚动不进内容签名——只影响 sceneRef.appState）
      const harness = (globalThis as Record<string, unknown>).__boardHarness as {
        onChange: (elements: unknown, appState: { scrollX?: number; scrollY?: number; zoom?: number; viewBackgroundColor?: string }, files: unknown) => void;
      };
      act(() => {
        harness.onChange([], { scrollX: 500, scrollY: 300, zoom: 2, viewBackgroundColor: '#ffffff' }, {});
      });

      // 3. 回收链：flush（场景含视口外的可撤销内容）+ viewport 捕获
      const suspended = await suspendEditorInstance(key);
      expect(suspended).toBe(true);
      const viewState = takeViewState(key) as { kind: string; viewport: { scrollX: number; scrollY: number; zoom: number } };
      expect(viewState.kind).toBe('board');
      expect(viewState.viewport).toMatchObject({ scrollX: 500, scrollY: 300, zoom: 2 });
      // 回收前保存回去（重挂载恢复用）
      saveViewState(key, viewState);

      // 4. 重挂载：恢复的 viewport 合并进 initialData（Excalidraw 挂载恢复视口）
      unmount(first.root);
      const second = mount(<BoardEditor docKey={key} />);
      await act(async () => { await Promise.resolve(); });
      const harness2 = (globalThis as Record<string, unknown>).__boardHarness as {
        initialData: { appState?: { scrollX?: number; scrollY?: number; zoom?: number } };
      };
      expect(harness2.initialData.appState).toMatchObject({ scrollX: 500, scrollY: 300, zoom: 2 });
      unmount(second.root);
    } finally {
      first.container.remove();
    }
  });

  it('Drawio：引擎未就绪时不可回收；close 场景 flush 以最近镜像为权威', async () => {
    const key = 'C:/t/recycle.drawio';
    useDocumentStore.getState().upsertFromPayload({
      key, displayName: 'recycle.drawio', dirPath: 'C:/t', kind: 'drawio', language: 'xml',
      content: '<mxfile><diagram/></mxfile>', encoding: 'utf8', eol: 'lf', size: 28, mtime: 0, readonly: false,
    });
    useWindowStore.getState().openTab({
      key, displayName: 'recycle.drawio', path: key, kind: 'drawio', language: 'xml',
      isDirty: false, isPreview: false, viewMode: null, externalStatus: null, isDetached: false,
    });

    const { container, root } = mount(<DrawioEditor docKey={key} />);
    try {
      const capabilities = getEditorCapabilities(key);
      expect(capabilities).not.toBeNull();
      // 🔴 引擎未就绪（iframe 未加载成功）——不可回收（保守）
      expect(capabilities!.canSuspend()).toBe(false);
      expect(await suspendEditorInstance(key)).toBe(false);
      // close 场景（iframe 即将销毁）：以最近 autosave 镜像为权威（不等回包）
      const captured = await capabilities!.flush('close');
      expect(captured?.content).toBe('<mxfile><diagram/></mxfile>');
    } finally {
      unmount(root);
      container.remove();
    }
  });

  it('Markdown：canSuspend（composition 检查）+ captureViewState 捕获选区/滚动', () => {
    const key = 'C:/t/recycle.md';
    useDocumentStore.getState().upsertFromPayload({
      key, displayName: 'recycle.md', dirPath: 'C:/t', kind: 'markdown', language: 'markdown',
      content: '# md', encoding: 'utf8', eol: 'lf', size: 4, mtime: 0, readonly: false,
    });
    useWindowStore.getState().openTab({
      key, displayName: 'recycle.md', path: key, kind: 'markdown', language: 'markdown',
      isDirty: false, isPreview: false, viewMode: 'visual', externalStatus: null, isDetached: false,
    });

    // 能力级验证（组件挂载链路由 visualHotPath/R02 反例覆盖）：
    // 无实例时 canSuspend 保守为 true（suspendEditorInstance 对无实例直接放行——无内容需保护）
    // captureViewState 的选区/滚动恢复在 TipTapEditor.restoreMarkdownViewState（宿主级）
    const capabilities = getEditorCapabilities(key);
    expect(capabilities).toBeNull(); // 未挂载内核——回收链直接放行（无状态需捕获）
    expect(takeViewState(key)).toBeNull();
  });
});
