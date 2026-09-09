// NoteBoard 🔴 J2 输入热路径与历史组语义测试（mock 内核执行真实 VisualKernel onUpdate）
// 覆盖：多次输入零全文工作（只暂存引用）、组内合并（同组只序列化组末）、
//       跨组保留（新组开始物化上一组）、undo 前物化钩子（组2 末端不丢）。

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { VisualKernel } from '@/features/editor-md/VisualKernel';
import {
  clearAllDocumentHistories,
  initializeDocumentHistory,
  registerDocumentHistoryAdapter,
  undoDocumentHistory,
} from '@/features/history/documentHistory';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { getBaseline } from '@/features/editor-md/serialize';
import { discardPendingVisualSnapshot } from '@/features/editor-md/visualSnapshot';

// 序列化调用记录（热路径断言：输入期间零全文工作）
const serializeCalls: string[] = [];
const kernel = vi.hoisted(() => ({
  options: null as unknown as { onUpdate: (payload: unknown) => void },
  editor: {
    text: 'base',
    state: { depth: 0, selection: { anchor: 1, head: 1 } },
    storage: { markdown: { manager: {} } },
    schema: {},
  },
}));
vi.mock('@tiptap/react', () => ({
  useEditor: (options: { onUpdate: (payload: unknown) => void }) => {
    kernel.options = options;
    return kernel.editor;
  },
  EditorContent: () => null,
}));
vi.mock('@tiptap/pm/history', () => ({ undoDepth: (state: { depth: number }) => state.depth }));
vi.mock('@/features/editor-md/extensions', () => ({ buildExtensions: () => [] }));
vi.mock('@/features/editor-md/bubbleMenu', () => ({ EditorBubbleMenu: () => null, TableToolbar: () => null }));
vi.mock('@/features/editor-md/blockDragHandle', () => ({ BlockDragHandle: () => null }));
vi.mock('@/features/editor-md/EditorContextMenu', () => ({ EditorContextMenu: () => null }));
vi.mock('@/features/editor-md/LinkModal', () => ({ LinkModal: () => null }));
vi.mock('@/features/editor-md/markdownAutoSave', () => ({ autoSaveDocument: vi.fn() }));
vi.mock('@/features/editor-md/imagePaste', () => ({ handlePastedImageFile: vi.fn() }));
// 🔴 J2：mock 纯适配器按暂存 doc 快照序列化（快照携带其文本），记录调用次数
vi.mock('@/features/editor-md/serialize', async (original) => ({
  ...await original<typeof import('@/features/editor-md/serialize')>(),
  serializeMarkdownFromDoc: (_m: unknown, _s: unknown, doc: { __text: string }) => {
    serializeCalls.push(doc.__text);
    return doc.__text;
  },
}));

const key = 'C:/t/j2-hotpath.md';

beforeEach(() => {
  clearAllDocumentHistories();
  serializeCalls.length = 0;
  kernel.editor.text = 'base';
  kernel.editor.state.depth = 0;
  discardPendingVisualSnapshot(key);
  useWindowStore.setState({ tabs: [], activeKey: null });
  useDocumentStore.setState({ documents: new Map() });
});

it('输入热路径零全文工作：同组多次输入只序列化组末，跨组保留全部组，undo 前物化当前组', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  useDocumentStore.getState().upsertFromPayload({
    key, displayName: 'j2.md', dirPath: 'C:/t', kind: 'markdown', language: 'markdown',
    content: 'base', encoding: 'utf8', eol: 'lf', size: 4, mtime: 0, readonly: false,
  });
  getBaseline(key).updateBaseline('base');
  initializeDocumentHistory(key, 'base', 'visual');
  const applied: string[] = [];
  registerDocumentHistoryAdapter(key, { applyEntry: (entry) => { applied.push(entry.content); } });

  const host = document.createElement('div');
  const root = createRoot(host);
  const storeTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
  const diskTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
  try {
    await act(async () => root.render(
      <VisualKernel
        docKey={key}
        visible
        onReady={() => {}}
        isInitializingRef={{ current: false }}
        visualUndoDepthRef={{ current: 0 }}
        storeTimerRef={storeTimerRef}
        diskTimerRef={diskTimerRef}
      />,
    ));

    const type = (depth: number, text: string) => {
      kernel.editor.text = text;
      kernel.editor.state.depth = depth;
      kernel.options.onUpdate({
        editor: kernel.editor,
        transaction: {
          docChanged: true,
          before: { content: { findDiffStart: () => 1 } },
          doc: { content: {}, __text: text },
        },
      });
    };

    await act(async () => {
      // 组1：同组连续 3 次输入（depth 不变 = 同一原生历史组）
      type(1, 'base-a');
      type(1, 'base-ab');
      type(1, 'base-abc');
      // 组2 开始（depth 2）
      type(2, 'base-abc-xyz');
    });

    // 🔴 热路径断言：4 次输入只发生 1 次序列化（组2 开始时物化组1 末端——
    //    逐键序列化已被消除；组内合并只保留组末）
    expect(serializeCalls).toEqual(['base-abc']);

    // 🔴 跨组保留：undo 前物化钩子提交组2 末端，然后回退到组1 末端
    expect(undoDocumentHistory(key)).toBe(true);
    expect(serializeCalls).toEqual(['base-abc', 'base-abc-xyz']);
    expect(applied.at(-1)).toBe('base-abc');
    // 再退一步回到初始
    expect(undoDocumentHistory(key)).toBe(true);
    expect(applied.at(-1)).toBe('base');
  } finally {
    if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
    if (diskTimerRef.current) clearTimeout(diskTimerRef.current);
    await act(async () => root.unmount());
  }
});

it('防抖物化：500ms 静默后组末自动进历史与镜像（连续输入重置不丢失）', async () => {
  vi.useFakeTimers();
  try {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    useDocumentStore.getState().upsertFromPayload({
      key, displayName: 'j2.md', dirPath: 'C:/t', kind: 'markdown', language: 'markdown',
      content: 'base', encoding: 'utf8', eol: 'lf', size: 4, mtime: 0, readonly: false,
    });
    getBaseline(key).updateBaseline('base');
    initializeDocumentHistory(key, 'base', 'visual');

    const host = document.createElement('div');
    const root = createRoot(host);
    const storeTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
    const diskTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
    try {
      await act(async () => root.render(
        <VisualKernel
          docKey={key}
          visible
          onReady={() => {}}
          isInitializingRef={{ current: false }}
          visualUndoDepthRef={{ current: 0 }}
          storeTimerRef={storeTimerRef}
          diskTimerRef={diskTimerRef}
        />,
      ));

      const type = (depth: number, text: string) => {
        kernel.editor.text = text;
        kernel.editor.state.depth = depth;
        kernel.options.onUpdate({
          editor: kernel.editor,
          transaction: {
            docChanged: true,
            before: { content: { findDiffStart: () => 1 } },
            doc: { content: {}, __text: text },
          },
        });
      };

      // 同组连续输入（每次重置防抖——不无限顺延由组边界/导航物化兜底）
      await act(async () => {
        type(1, 'draft-1');
        type(1, 'draft-2');
        type(1, 'draft-3');
      });
      // 输入期间零序列化
      expect(serializeCalls).toEqual([]);

      // 500ms 静默 → 防抖物化（组末进镜像）
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(serializeCalls).toEqual(['draft-3']);
      expect(useDocumentStore.getState().getDocument(key)?.content).toBe('draft-3');
    } finally {
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      if (diskTimerRef.current) clearTimeout(diskTimerRef.current);
      await act(async () => root.unmount());
    }
  } finally {
    vi.useRealTimers();
  }
});
