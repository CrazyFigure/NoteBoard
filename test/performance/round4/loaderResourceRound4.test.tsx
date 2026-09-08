// 复查真实 EditorHost 与加载表的可见行为；只替换编辑器正文，不改加载边界与模块缓存。
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { EditorHost } from '@/features/editor-host/EditorHost';
import type { Tab } from '@/stores/windowStore';

vi.mock('@/features/editor-md/TipTapEditor', () => ({
  TipTapEditor: ({ docKey }: { docKey: string }) => React.createElement('div', null, `正文 ${docKey}`),
}));

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
