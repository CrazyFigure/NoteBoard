// 三轮复审：真实 Drawio 组件和回收调度，iframe 消息由测试提供，不访问远程服务。
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DrawioEditor } from '@/features/drawio/DrawioEditor';
import { getEditorCapabilities, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { resetSuspensionForTest } from '@/features/session/editorSuspension';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/features/export/chartExport', () => ({ exportBlobWithDialog: vi.fn(), buildExportFileName: vi.fn() }));

// 默认 jsdom 不加载 iframe 网络资源，测试只读取其 Window 身份用于 source 校验。
function seed(key: string): void {
  useDocumentStore.getState().upsertFromPayload({ key, displayName: 'review.drawio', dirPath: 'C:/round3', kind: 'drawio', language: 'xml', content: '<mxfile>old-mirror</mxfile>', encoding: 'utf8', eol: 'lf', size: 10, mtime: 0, readonly: false });
  useWindowStore.getState().openTab({ key, path: key, displayName: 'review.drawio', kind: 'drawio', language: 'xml', isDirty: false, isPreview: false, viewMode: null, externalStatus: null, isDetached: false });
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  useDocumentStore.setState({ documents: new Map() }); useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
  resetEditorRegistryForTest(); resetSuspensionForTest(); vi.useFakeTimers();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

// 本地 requestId 未发往引擎，也未从回包读取；测试分别控制 A、B 请求及 A 的迟到响应。
it('D07：Drawio 请求 A 超时后发起 B，A 的迟到回包不能被 B 接纳', async () => {
  const key = 'C:/round4/overlap.drawio'; seed(key);
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<DrawioEditor docKey={key} />));
    const frame = host.querySelector('iframe')!;
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: JSON.stringify(data) }));
    await act(async () => send({ event:'init' }));
    const oldWork = getEditorCapabilities(key)!.flush('evict');
    await act(async () => { await vi.advanceTimersByTimeAsync(3001); });
    expect(await oldWork).toBeNull();
    const newWork = getEditorCapabilities(key)!.flush('evict');
    await act(async () => send({ event:'export', format:'xml', data:'<mxfile>response-from-A</mxfile>' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3001); });
    // B 的回包没有到达，不能返回 A 的旧内容当作 B 捕获成功。
    expect(await newWork).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});