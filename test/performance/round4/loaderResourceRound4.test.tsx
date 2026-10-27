// 复查真实 EditorHost 与加载表的可见行为；只替换编辑器正文，不改加载边界与模块缓存。
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { EditorHost } from '@/features/editor-host/EditorHost';
import { EditorStack } from '@/components/shell/EditorStack';
import type { Tab } from '@/stores/windowStore';

const renders = vi.hoisted(() => new Map<string, number>());
vi.mock('@/features/editor-md/TipTapEditor', async () => {
  const { useEditorActive } = await import('@/core/editor/EditorActivityContext');
  return {
    TipTapEditor: ({ docKey }: { docKey: string }) => {
      renders.set(docKey, (renders.get(docKey) ?? 0) + 1);
      return React.createElement('div', { 'data-doc': docKey, 'data-active': String(useEditorActive()) }, `正文 ${docKey}`);
    },
  };
});

// 构造无真实磁盘路径的标签；用 Host 的实际 props 映射验证展示目标没有串到旧标签。
function tabFor(key: string, kind: 'markdown' | 'code' = 'markdown'): Tab {
  return { key, path: key, displayName: key, kind, language: kind === 'markdown' ? 'markdown' : 'plaintext', isDirty: false, isPreview: false, viewMode: null, externalStatus: null, isDetached: false };
}

it('D08：成功模块再次挂载应直接显示目标正文，不重新提交模块加载页', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<EditorHost tab={tabFor('warm-a.md')} unsupportedView={null} />); });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(host.textContent).toBe('正文 warm-a.md');
    // 真实卸载宿主但保留已成功求值的模块，再同步激活另一个同类标签。
    act(() => { root.render(null); });
    act(() => { root.render(<EditorHost tab={tabFor('warm-b.md')} unsupportedView={null} />); });
    expect(host.textContent).toBe('正文 warm-b.md');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('保活宿主隔离外壳重绘，切换只唤醒两个活动状态变化的内核', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const tabs = ['render-a', 'render-b', 'render-c'].map((key) => tabFor(key));
  // 就绪回调与真实外壳相同，按文档保持引用稳定。
  const onReady = () => {};
  const getReady = () => onReady;
  const render = (activeKey: string, transferringKeys: string[] = []) => root.render(
    <EditorStack tabs={tabs} activeKey={activeKey} transferringKeys={transferringKeys} hasActiveTab getMarkdownEditorReadyHandler={getReady} />,
  );
  try {
    await act(async () => render('render-a'));
    await act(async () => { await vi.dynamicImportSettled(); });
    renders.clear();
    // 迁移遮罩仅更新容器，不改变宿主 props，不应重新渲染三个正文。
    await act(async () => render('render-a', ['render-c']));
    expect(renders.size).toBe(0);
    for (const key of ['render-b', 'render-c', 'render-a']) await act(async () => render(key));
    expect(Object.fromEntries(renders)).toEqual({ 'render-a': 2, 'render-b': 2, 'render-c': 2 });
    expect(host.querySelector('[data-doc="render-a"]')?.getAttribute('data-active')).toBe('true');
    expect(host.querySelector('[data-doc="render-c"]')?.getAttribute('data-active')).toBe('false');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
