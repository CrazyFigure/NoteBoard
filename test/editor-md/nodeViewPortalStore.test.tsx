// 节点视图门户登记表：接管官方 EditorContent 的登记表后，React 节点视图照常挂载、更新与移除
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Editor, Node } from '@tiptap/core';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { createNodeViewPortalStore, installNodeViewPortalStore } from '../../src/features/editor-md/nodeViewPortalStore';

// 最小文档节点（项目未单独依赖 @tiptap/extension-document）
const Document = Node.create({ name: 'doc', topNode: true, content: 'block+' });

/** 带 React 节点视图的原子块：显示自身 label 属性 */
function Badge({ node }: NodeViewProps) {
  return <NodeViewWrapper className="badge">{String(node.attrs.label)}</NodeViewWrapper>;
}
const BadgeNode = Node.create({
  name: 'badge',
  group: 'block',
  atom: true,
  addAttributes: () => ({ label: { default: '' } }),
  parseHTML: () => [{ tag: 'div[data-badge]' }],
  renderHTML: () => ['div', { 'data-badge': '' }],
  addNodeView: () => ReactNodeViewRenderer(Badge),
});

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function renderEditor(count: number): Promise<{ editor: Editor; host: HTMLElement }> {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text, BadgeNode],
    content: { type: 'doc', content: Array.from({ length: count }, (_, index) => ({ type: 'badge', attrs: { label: `第${index}个` } })) },
    onBeforeCreate: installNodeViewPortalStore,
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<EditorContent editor={editor} />); });
  cleanups.push(async () => {
    await act(async () => root.unmount());
    editor.destroy();
    host.remove();
  });
  return { editor, host };
}

const labels = (host: HTMLElement) => [...host.querySelectorAll('.badge')].map((node) => node.textContent);

describe('节点视图门户登记表', () => {
  it('接管官方登记表（接口与当前 @tiptap/react 一致），节点视图全部渲染', async () => {
    const { editor, host } = await renderEditor(300);
    const store = (editor as unknown as { contentComponent: object }).contentComponent;
    // 已换成本模块的实现：其 getServerSnapshot 与 getSnapshot 是同一函数
    expect(store).toBeTruthy();
    const { getSnapshot, getServerSnapshot } = store as { getSnapshot: unknown; getServerSnapshot: unknown };
    expect(getServerSnapshot).toBe(getSnapshot);
    expect(labels(host)).toEqual(Array.from({ length: 300 }, (_, index) => `第${index}个`));
  });

  it('更新属性、删除与新增节点后门户同步变化', async () => {
    const { editor, host } = await renderEditor(5);
    await act(async () => {
      editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { label: '改过' }));
    });
    expect(labels(host)[0]).toBe('改过');
    await act(async () => {
      const second = editor.state.doc.child(0).nodeSize;
      editor.view.dispatch(editor.state.tr.delete(second, second + editor.state.doc.child(1).nodeSize));
    });
    expect(labels(host)).toEqual(['改过', '第2个', '第3个', '第4个']);
    await act(async () => {
      editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, editor.schema.nodes.badge.create({ label: '新' })));
    });
    expect(labels(host)).toEqual(['改过', '第2个', '第3个', '第4个', '新']);
    // 登记数与界面一致（删除的节点视图已移除）
    const snapshot = (editor as unknown as { contentComponent: { getSnapshot(): Record<string, unknown> } }).contentComponent.getSnapshot();
    expect(Object.keys(snapshot)).toHaveLength(5);
  });

  it('快照在无变化时保持同一引用，变化后按微任务合并通知一次', async () => {
    const store = createNodeViewPortalStore();
    let notified = 0;
    store.subscribe(() => { notified += 1; });
    const element = document.createElement('div');
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.setRenderer('a', { reactElement: null, element });
    store.setRenderer('b', { reactElement: null, element });
    store.setRenderer('a', { reactElement: null, element });
    const second = store.getSnapshot();
    expect(second).not.toBe(first);
    expect(store.getSnapshot()).toBe(second);
    // 重复登记同一 id 不改变键顺序（与对象展开一致）
    expect(Object.keys(second)).toEqual(['a', 'b']);
    await Promise.resolve();
    expect(notified).toBe(1);
    store.removeRenderer('a');
    expect(Object.keys(store.getSnapshot())).toEqual(['b']);
  });
});
