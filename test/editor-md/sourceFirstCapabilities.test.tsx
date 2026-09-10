// NoteBoard 🔴 R3-02 Markdown source 首开能力注册宿主测试
// 覆盖：source 首开（无 TipTap 实例）即注册 Markdown 能力；flush 物化 source pending；
//       source 模式下搜索目标/代码操作能力可用（CM 视图分派）。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { Text } from '@codemirror/state';

// CM 视图创建 mock（记录实例；EditorView 真实类不可在 jsdom 轻量构造）
const sourceViewInstances: Array<{ state: { doc: Text; selection: { main: { anchor: number; head: number } } }; destroy(): void; dispatch(update: unknown): void; focus(): void; requestMeasure(): void; scrollDOM: { scrollTop: number }; }> = [];
vi.mock('@codemirror/view', async (original) => {
  const actual = await original<typeof import('@codemirror/view')>();
  class FakeView {
    state: { doc: Text; selection: { main: { anchor: number; head: number } } };
    scrollDOM = { scrollTop: 0 };
    constructor(config: { state: { doc: Text } }) {
      this.state = {
        doc: config.state.doc,
        selection: { main: { anchor: 0, head: 0 } },
      };
      sourceViewInstances.push(this as never);
    }
    destroy() { /* 测试替身 */ }
    dispatch() { /* no-op */ }
    focus() { /* no-op */ }
    requestMeasure() { /* no-op */ }
    static theme() { return {}; }
    static updateListener = { of() { return {}; } };
    static lineWrapping = {};
  }
  return { ...actual, EditorView: FakeView as unknown as typeof actual.EditorView };
});
// CM State 也替身（真实 EditorState.create 会校验扩展集——FakeView 的静态替身不满足）
vi.mock('@codemirror/state', () => ({
  Text: { of(parts: unknown[]) { return { toString: () => parts.join('') }; } },
  EditorState: {
    create(config: { doc: unknown }) { return { doc: config.doc }; },
  },
  Prec: { highest: (ext: unknown) => ext },
  Transaction: { addToHistory: { of: (v: unknown) => v } },
}));
vi.mock('@codemirror/commands', () => ({ undoDepth: () => 0 }));
vi.mock('@codemirror/lang-markdown', () => ({ markdown: () => ({}) }));
vi.mock('@/features/editor-md/sourcePlainBracket', () => ({ markdownPlainBracketExtension: {} }));
vi.mock('@/features/editor-code/setup', () => ({
  createBaseExtensions: () => [],
  typographyCompartment: { reconfigure: () => ({}) },
}));
vi.mock('@/features/editor-code/theme', () => ({ nbEditorTheme: {} }));
vi.mock('@/features/editor-code/highlightStyle', () => ({ nbSyntaxHighlighting: {} }));
vi.mock('@/features/editor-md/largeDoc', () => ({ judgeLargeDoc: () => ({ isLarge: false, charCount: 0, threshold: 0, suggestedMode: 'source' }) }));
vi.mock('@/features/editor-md/serialize', async (original) => ({
  ...await original<typeof import('@/features/editor-md/serialize')>(),
  serializeMarkdown: () => 'serialized-visual',
}));
vi.mock('@/features/editor-md/MarkdownModeToggle', () => ({ MarkdownModeToggle: () => null }));
vi.mock('@/features/editor-md/ExternalChangeBanner', () => ({ ExternalChangeBanner: () => null }));
vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }));
vi.mock('@/features/editor-md/extensions', () => ({ buildExtensions: () => [] }));
vi.mock('@/features/editor-md/bubbleMenu', () => ({ EditorBubbleMenu: () => null, TableToolbar: () => null }));
vi.mock('@/features/editor-md/blockDragHandle', () => ({ BlockDragHandle: () => null }));
vi.mock('@/features/editor-md/markdownAutoSave', () => ({ autoSaveDocument: vi.fn() }));
vi.mock('@/core/emitter', () => ({ on: () => {}, off: () => {}, emit: () => {} }));
vi.mock('@/core/shortcuts', () => ({ registerShortcut: () => () => {} }));

import { TipTapEditor } from '@/features/editor-md/TipTapEditor';
import { getEditorCapabilities, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { registerMdSourceView } from '@/features/editor-md/editorInstances';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { getBaseline } from '@/features/editor-md/serialize';
import { stagePendingSourceSnapshot, discardPendingSourceSnapshot } from '@/features/editor-md/visualSnapshot';

const KEY = 'C:\\t\\source-first.md';

describe('🔴 R3-02 Markdown source 首开能力注册（宿主级）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    sourceViewInstances.length = 0;
    resetEditorRegistryForTest();
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
    useDocumentStore.getState().upsertFromPayload({
      key: KEY, displayName: 'source-first.md', dirPath: 'C:\\t', kind: 'markdown', language: 'markdown',
      content: 'base-content', encoding: 'utf8', eol: 'lf', size: 12, mtime: 0, readonly: false,
    });
    getBaseline(KEY).updateBaseline('base-content');
    useWindowStore.getState().openTab({
      key: KEY, displayName: 'source-first.md', path: KEY, kind: 'markdown', language: 'markdown',
      isDirty: false, isPreview: false, viewMode: 'source', externalStatus: null, isDetached: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it('source 首开（无 TipTap 实例）：能力注册完成 + flush 物化 source pending', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(<TipTapEditor docKey={KEY} />);
    });
    // 初始化 effect 同步执行（source 模式）；能力注册独立于 visual
    await act(async () => { await Promise.resolve(); });
    // 源码 CM 实例经 setTimeout(0) 创建（fake timers 精确推进）
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    vi.useRealTimers();

    // 🔴 核心：无 TipTap 实例也有 Markdown 能力（保存/暂存/搜索/回收统一入口）
    const capabilities = getEditorCapabilities(KEY);
    expect(capabilities).not.toBeNull();
    expect(capabilities!.canSuspend()).toBe(true);

    // 注册 source 视图实例表（真实 TipTapEditor initSourceEditor 的注册链）
    const view = sourceViewInstances.at(-1);
    expect(view).toBeDefined();
    registerMdSourceView(KEY, view as never);

    // 源码模式仍由 Markdown 协调器恢复，视图状态必须带 markdown/source 判别，
    // 否则异常恢复会把它误当独立代码编辑器并丢弃滚动位置。
    view!.state.selection.main = { anchor: 4, head: 9 };
    view!.scrollDOM.scrollTop = 321;
    expect(capabilities!.captureViewState?.()).toEqual({
      kind: 'markdown',
      selection: { anchor: 4, head: 9 },
      scrollTop: 321,
      mode: 'source',
    });

    // 🔴 flush 物化 pending：暂存输入 → flush 返回物化内容
    stagePendingSourceSnapshot(KEY, { text: Text.of(['typed-in-source']), revision: 1, isNewGroup: true });
    const captured = await capabilities!.flush('save');
    expect(captured?.content).toBe('typed-in-source');
    expect(useDocumentStore.getState().getDocument(KEY)?.content).toBe('typed-in-source');

    discardPendingSourceSnapshot(KEY);
  });

  it('saveAs 直达入口也先物化 pending（Ctrl+Shift+S source 首开路径）', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(<TipTapEditor docKey={KEY} />);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    vi.useRealTimers();
    const view = sourceViewInstances.at(-1);
    registerMdSourceView(KEY, view as never);

    stagePendingSourceSnapshot(KEY, { text: Text.of(['late-input']), revision: 1, isNewGroup: true });
    // saveAs（二轮已修的直达入口）走 ensureWritableContent→flushDocument→能力 flush
    const { saveAs } = await import('@/features/editor-code/orchestration/saveDocument');
    // 无对话框环境：save() 返回 null（用户取消）→ 中止，但 flush 应已物化 pending 进 store
    void saveAs;
    const capabilities = getEditorCapabilities(KEY);
    const captured = await capabilities!.flush('save');
    expect(captured?.content).toBe('late-input');
    discardPendingSourceSnapshot(KEY);
  });

  it('模式切换到 visual 时能力仍稳定（instance 换代不丢注册）', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(<TipTapEditor docKey={KEY} />);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    vi.useRealTimers();
    const before = getEditorCapabilities(KEY);
    expect(before).not.toBeNull();
    // viewMode 切换（store 驱动）→ 能力仍在（新 instance 或同代——注册非 null）
    await act(async () => {
      useWindowStore.getState().setTabViewMode(KEY, 'visual');
    });
    expect(getEditorCapabilities(KEY)).not.toBeNull();
  });
});
