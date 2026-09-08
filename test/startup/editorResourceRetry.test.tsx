// 真实资源状态机与真实 Host，只在动态模块入口注入可控的失败/成功，不替换订阅实现。
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { EditorHost } from '@/features/editor-host/EditorHost';
import { resetEditorResourcesForTest, getEditorResourceStatus } from '@/features/editor-host/editorLoaders';
import type { Tab } from '@/stores/windowStore';

// 同一入口的两个宿主共享加载；失败后控制第二次请求何时完成。
const control = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/features/editor-host/editorLoaderFactories', () => ({ loaderFactories: { markdown: control.load } }));

beforeEach(() => {
  resetEditorResourcesForTest();
  control.load.mockReset();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

/** 仅提供宿主需要的标签元数据，不访问真实文件。 */
function tab(key: string): Tab {
  return { key, path: key, displayName: key, kind: 'markdown', language: 'markdown', isDirty: false, isPreview: false, viewMode: null, externalStatus: null, isDetached: false };
}

it('同类型两个宿主加载失败后，只重试一次，成功应自动通知两个已有订阅者', async () => {
  let complete!: (value: { default: React.ComponentType<Record<string, unknown>> }) => void;
  control.load.mockRejectedValueOnce(new Error('暂时无法取得模块'))
    .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<><EditorHost tab={tab('a.md')} unsupportedView={null} /><EditorHost tab={tab('b.md')} unsupportedView={null} /></>));
    expect(host.textContent).toContain('暂时无法取得模块');
    // 点击现有错误视图的重试；之后不再触发重渲染或改变标签，排除“切回来才好”的假通过。
    await act(async () => { (host.querySelector('button') as HTMLButtonElement).click(); });
    expect(control.load).toHaveBeenCalledTimes(2);
    await act(async () => { complete({ default: ({ docKey }) => <div>正文 {String(docKey)}</div> }); });
    expect(getEditorResourceStatus('markdown').status).toBe('ready');
    expect(host.textContent).toContain('正文 a.md');
    expect(host.textContent).toContain('正文 b.md');
    expect(host.textContent).not.toContain('正在加载');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
