// 三轮复审反例（正式迁入自 test-results/performance/review-20260906-round3/）——断言为整改后正确行为。
// 三轮复审：真实 Drawio 组件和回收调度，iframe 消息由测试提供，不访问远程服务。
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DrawioEditor } from '@/features/drawio/DrawioEditor';
import { getEditorCapabilities, registerEditorCapabilities, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { suspendEditorInstance, resetSuspensionForTest } from '@/features/session/editorSuspension';
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

it('C10：Drawio 导出超时未确认最新 XML 时不得批准回收', async () => {
  const key = 'C:/round3/export-timeout.drawio'; seed(key);
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<DrawioEditor docKey={key} />));
    const frame = host.querySelector('iframe')!;
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: JSON.stringify({ event: 'init' }) })));
    expect(getEditorCapabilities(key)!.canSuspend()).toBe(true);
    const suspension = suspendEditorInstance(key);
    await act(async () => { await vi.advanceTimersByTimeAsync(3001); });
    expect(await suspension).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('C11：Drawio 已超时请求的迟到 XML 不得覆盖后来的 autosave 正文', async () => {
  const key = 'C:/round3/late-export.drawio'; seed(key);
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<DrawioEditor docKey={key} />));
    const frame = host.querySelector('iframe')!;
    const message = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: JSON.stringify(data) }));
    await act(async () => message({ event: 'init' }));
    const pending = getEditorCapabilities(key)!.flush('evict');
    await act(async () => { await vi.advanceTimersByTimeAsync(3001); }); await pending;
    await act(async () => message({ event: 'autosave', xml: '<mxfile>new-edit</mxfile>' }));
    await act(async () => message({ event: 'export', format: 'xml', data: '<mxfile>old-export</mxfile>' }));
    expect(useDocumentStore.getState().getDocument(key)?.content).toBe('<mxfile>new-edit</mxfile>');
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('C12：回收等待 flush 时旧实例被新实例接管，旧回收必须失效', async () => {
  const key = 'C:/round3/suspend-generation.drawio'; seed(key);
  let finishOld!: (value: never) => void;
  const common = { docKey: key, getRevision: () => 1, focus() {}, getSelectedText: () => '', canSuspend: () => true };
  registerEditorCapabilities({ ...common, instanceId: 'old', flush: () => new Promise(resolve => { finishOld = resolve; }) });
  const pending = suspendEditorInstance(key);
  registerEditorCapabilities({ ...common, instanceId: 'new', flush: async () => ({ docKey: key, instanceId: 'new', revision: 1, content: 'new' }) });
  finishOld({ docKey: key, instanceId: 'old', revision: 1, content: 'old' } as never);
  expect(await pending).toBe(false);
});
