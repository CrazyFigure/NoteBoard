// NoteBoard S12 图表双栏编辑器能力测试
// 覆盖：flush 将 CM 文本写入 store 镜像；captureViewState 捕获布局/预览/源码状态；
//       未验证回收的重型类型保留实例（canSuspend=false 契约由各编辑器维持）。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createSplitEditorCapabilities } from '@/features/diagram-preview/splitEditorCapabilities';
import { useDocumentStore } from '@/stores/documentStore';

vi.mock('@/core/ipc/commands', () => ({}));

describe('S12 图表双栏编辑器能力', () => {
  beforeEach(() => {
    useDocumentStore.setState({ documents: new Map() });
  });

  it('flush 把 CM 文本写入 store 镜像并返回快照', async () => {
    const KEY = 'C:\\t\\flow.mmd';
    useDocumentStore.getState().upsertFromPayload({
      key: KEY,
      displayName: 'flow.mmd',
      dirPath: 'C:\\t',
      kind: 'code',
      language: 'mermaid',
      content: 'graph TD; A-->B',
      encoding: 'utf8',
      eol: 'lf',
      size: 14,
      mtime: 0,
      readonly: false,
    });

    // 构造一个真实 CM 视图（jsdom 可运行，附加到测试容器）
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      state: EditorState.create({ doc: 'graph TD; A-->B; B-->C' }),
      parent: host,
    });
    try {
      const caps = createSplitEditorCapabilities({
        docKey: KEY,
        instanceId: 'diag-test',
        getEditorView: () => view,
        captureExtra: () => ({ layoutMode: 'preview', zoom: 1.5, pan: { x: 10, y: 20 } }),
      });
      expect(caps.canSuspend()).toBe(true);

      const captured = await caps.flush('evict');
      expect(captured?.content).toBe('graph TD; A-->B; B-->C');
      // store 镜像已更新
      expect(useDocumentStore.getState().getDocument(KEY)?.content).toBe('graph TD; A-->B; B-->C');

      // 视图状态捕获：布局/预览/源码选区滚动
      const state = caps.captureViewState?.() as {
        kind: string;
        layoutMode: string;
        zoom: number;
        pan: { x: number; y: number };
      };
      expect(state.kind).toBe('split-diagram');
      expect(state.layoutMode).toBe('preview');
      expect(state.zoom).toBe(1.5);
      expect(state.pan).toEqual({ x: 10, y: 20 });
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it('CM 视图未挂载时 flush 返回 null（无实例不产生假快照）', async () => {
    const caps = createSplitEditorCapabilities({
      docKey: 'C:\\t\\x.mmd',
      instanceId: 'diag-test',
      getEditorView: () => null,
      captureExtra: () => ({ layoutMode: 'split', zoom: 1, pan: { x: 0, y: 0 } }),
    });
    expect(await caps.flush('evict')).toBeNull();
    expect(caps.getSelectedText()).toBe('');
  });
});
