// 文本对比（textdiff）功能测试
// 覆盖：newTextDiff 工具 tab 创建、resolveEditorKind 工具视图分派、TextDiffView 挂载/卸载冒烟

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// 隔离 Tauri dialog 与 IPC（TextDiffView 打开文件链路不进真实 Tauri）
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({
  readDocument: vi.fn(),
  invoke: vi.fn(),
}));

import { newTextDiff } from '@/features/welcome/welcomeActions';
import { resolveEditorKind } from '@/features/editor-host/editorLoaders';
import { TextDiffView } from '@/features/textdiff/TextDiffView';
import { EditorToolbar } from '@/features/toolbar/EditorToolbar';
import { TooltipProvider } from '@/components/Tooltip';
import { useWindowStore } from '@/stores/windowStore';
import { useDocumentStore } from '@/stores/documentStore';

// jsdom 无布局：stub ResizeObserver（组件内已判空，stub 保证行为一致）
class ResizeObserverStub {
  observe(): void { /* jsdom 无布局 */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

describe('newTextDiff 文本对比 tab 创建', () => {
  beforeEach(() => {
    // 重置 store 初始状态
    useWindowStore.setState({
      tabs: [],
      activeKey: null,
      pendingCloseKeys: [],
      isWindowClosing: false,
    });
  });

  it('创建 toolKind=textdiff 的未落盘工具 tab 并激活', () => {
    newTextDiff();
    const state = useWindowStore.getState();
    expect(state.tabs).toHaveLength(1);
    const tab = state.tabs[0]!;
    expect(tab.toolKind).toBe('textdiff');
    expect(tab.displayName).toBe('文本对比');
    expect(tab.path).toBeNull();
    expect(tab.kind).toBe('code');
    expect(tab.isDirty).toBe(false);
    expect(state.activeKey).toBe(tab.key);
    expect(tab.key.startsWith('untitled:textdiff:')).toBe(true);
  });

  it('不写入 documentStore（纯前端工具视图，无文档模型）', () => {
    const before = useDocumentStore.getState().documents.size;
    newTextDiff();
    expect(useDocumentStore.getState().documents.size).toBe(before);
  });

  it('多次调用创建相互独立的 tab', () => {
    newTextDiff();
    newTextDiff();
    const state = useWindowStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0]!.key).not.toBe(state.tabs[1]!.key);
  });
});

describe('resolveEditorKind 工具视图分派', () => {
  it('toolKind=textdiff 优先分派到 textdiff 入口', () => {
    expect(
      resolveEditorKind({ kind: 'code', language: 'plaintext', toolKind: 'textdiff' }),
    ).toBe('textdiff');
  });

  it('无 toolKind 时保持原有 kind+language 分派', () => {
    expect(resolveEditorKind({ kind: 'code', language: 'plaintext' })).toBe('code');
    expect(resolveEditorKind({ kind: 'code', language: 'mermaid' })).toBe('diagram');
    expect(resolveEditorKind({ kind: 'mindmap', language: 'json' })).toBe('mindmap');
  });
});

describe('EditorToolbar 在文本对比工具视图下的表现', () => {
  it('toolKind=textdiff 时不渲染通用操作栏', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const textdiffTab = {
      key: 'untitled:textdiff:test',
      displayName: '文本对比',
      path: null,
      kind: 'code' as const,
      language: 'plaintext',
      isDirty: false,
      isPreview: false,
      viewMode: null,
      externalStatus: null,
      isDetached: false,
      toolKind: 'textdiff' as const,
    };
    await act(async () => {
      root.render(
        <TooltipProvider>
          <EditorToolbar activeTab={textdiffTab} activeEditor={null} />
        </TooltipProvider>,
      );
    });
    expect(container.innerHTML).toBe('');
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe('TextDiffView 挂载冒烟', () => {
  it('挂载创建左右两个编辑器与中缝按钮层，操作栏包含清空与自动换行，卸载后清理 DOM', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      // Tooltip 需全局 Provider（真实应用由 App.tsx 提供）
      root.render(
        <TooltipProvider>
          <TextDiffView docKey="untitled:textdiff:test" />
        </TooltipProvider>,
      );
    });
    // 左右两个 CodeMirror 编辑器 + 中缝按钮层 + 工具栏
    expect(container.querySelectorAll('.cm-mergeViewEditor')).toHaveLength(2);
    expect(container.querySelector('.nb-diff-chunkbar')).not.toBeNull();
    const toolbar = container.querySelector('.nb-diff-toolbar');
    expect(toolbar).not.toBeNull();
    // 包含操作按钮（打开文件、复制、清空、交换、差异导航、折叠、自动换行等）
    const buttons = toolbar?.querySelectorAll('button') ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(10);
    await act(async () => {
      root.unmount();
    });
    expect(container.innerHTML).toBe('');
    container.remove();
  });
});
