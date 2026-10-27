// 首页静置不能自动下载两个编辑器内核或双链搜索弹窗，避免“首屏已出现、后台仍在卡顿”。
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WelcomeScreen } from '@/components/WelcomeScreen';
import { WikiLinkDialogHost } from '@/features/wikilink/WikiLinkDialogHost';
import { prefetchEditor } from '@/features/editor-host/editorLoaders';

const dialogLoads = vi.hoisted(() => vi.fn());
vi.mock('@/features/editor-host/editorLoaders', () => ({ prefetchEditor: vi.fn() }));
vi.mock('@/features/wikilink/WikiLinkDialog', () => {
  dialogLoads();
  return { WikiLinkDialogPortal: () => null };
});
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

it('首页等待五秒及空闲回调都不会加载未使用的编辑器或双链弹窗', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  // 即使浏览器立即获得空闲时间，也不能把页面可见误判成打开文档的意图。
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => { callback(); return 1; });
  vi.stubGlobal('cancelIdleCallback', vi.fn());
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<><WelcomeScreen /><WikiLinkDialogHost /></>));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(prefetchEditor).not.toHaveBeenCalled();
    expect(dialogLoads).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
