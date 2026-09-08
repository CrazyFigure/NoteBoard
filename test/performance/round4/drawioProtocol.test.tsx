// 真实 Drawio 组件，按官方 export 协议回传原始 message 和 xml；不访问远程 iframe。
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DrawioEditor } from '@/features/drawio/DrawioEditor';
import { getEditorCapabilities, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { useWindowStore } from '@/stores/windowStore';
import { useDocumentStore } from '@/stores/documentStore';

vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/features/export/chartExport', () => ({ exportBlobWithDialog: vi.fn(), buildExportFileName: vi.fn() }));

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  useDocumentStore.setState({ documents: new Map() });
  useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
  resetEditorRegistryForTest();
  vi.useFakeTimers();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([false, true])('XML 回包无需 data；旧请求超时=%s 时新请求仍能独立成功', async timeoutFirst => {
  const key = 'C:/test-only/protocol.drawio';
  useDocumentStore.getState().upsertFromPayload({ key, displayName: 'protocol.drawio', dirPath: 'C:/test-only', kind: 'drawio', language: 'xml', content: '<mxfile>base</mxfile>', encoding: 'utf8', eol: 'lf', size: 21, mtime: 0, readonly: false });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<DrawioEditor docKey={key} />));
    const frame = host.querySelector('iframe')!;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const send = (message: unknown) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: JSON.stringify(message) }));
    await act(async () => send({ event: 'init' }));
    // 直接读取真实出站请求；回包不在测试内另造一个可能与实现不一致的序号。
    const exportRequest = () => JSON.parse(String(post.mock.calls.at(-1)![0]));
    let oldRequest: ReturnType<typeof exportRequest> | undefined;
    if (timeoutFirst) {
      const oldWork = getEditorCapabilities(key)!.flush('evict');
      oldRequest = exportRequest();
      await act(async () => vi.advanceTimersByTimeAsync(3001));
      expect(await oldWork).toBeNull();
    }
    const currentWork = getEditorCapabilities(key)!.flush('evict');
    const currentRequest = exportRequest();
    // B 可先于 A 到达，甚至 A 永远不回；不能让丢弃名额吞掉 B。
    await act(async () => send({ event: 'export', format: 'xml', xml: '<mxfile>latest</mxfile>', message: currentRequest }));
    await act(async () => vi.advanceTimersByTimeAsync(3001));
    expect((await currentWork)?.content).toBe('<mxfile>latest</mxfile>');
    if (oldRequest) {
      await act(async () => send({ event: 'export', format: 'xml', xml: '<mxfile>stale</mxfile>', message: oldRequest }));
      expect(useDocumentStore.getState().getDocument(key)?.content).not.toBe('<mxfile>stale</mxfile>');
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
