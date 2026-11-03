// 真实 Draw.io 消息处理链：图片数据由 iframe 回传，网络与系统保存留在测试边界。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DrawioEditor } from '@/features/drawio/DrawioEditor';
import { exportBlobWithDialog } from '@/features/export/chartExport';
import { showToast } from '@/stores/toastStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { resetEditorRegistryForTest } from '@/core/editor/editorRegistry';

vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/features/export/chartExport', () => ({ exportBlobWithDialog: vi.fn(), buildExportFileName: () => '流程图' }));
vi.mock('@/stores/toastStore', () => ({ showToast: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
let frame: HTMLIFrameElement;

beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(exportBlobWithDialog).mockResolvedValue(true);
  // 模拟安装包 CSP 禁止 fetch(data:)；正确流程应完全不调用 fetch。
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('CSP 拦截')));
  useDocumentStore.setState({ documents: new Map() });
  useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
  resetEditorRegistryForTest();
  const key = 'C:/test-only/export.drawio';
  useDocumentStore.getState().upsertFromPayload({ key, displayName: '流程图.drawio', dirPath: 'C:/test-only', kind: 'drawio', language: 'xml', content: '<mxfile/>', encoding: 'utf8', eol: 'lf', size: 9, mtime: 0, readonly: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<DrawioEditor docKey={key} />));
  frame = host.querySelector('iframe')!;
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 只从组件自身 iframe 回传，保留生产代码的消息来源校验。 */
async function sendImage(format: string, data: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: JSON.stringify({ event: 'export', format, data }),
    }));
  });
}

/** 通过浏览器读取接口核对 Blob，而非仅断言保存函数被调用。 */
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

test('PNG 数据地址绕开 CSP 网络限制，原样交给公共保存流程', async () => {
  await sendImage('png', 'data:image/png;base64,iVBORwD/');
  const [blob, filename] = vi.mocked(exportBlobWithDialog).mock.calls[0];
  expect(filename).toBe('流程图.png');
  expect(blob.type).toBe('image/png');
  expect(Array.from(new Uint8Array(await readBlob(blob)))).toEqual([137, 80, 78, 71, 0, 255]);
  expect(fetch).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledWith('绘图已成功导出为 PNG', 'success');
});

test('SVG 数据地址保留中文正文与扩展名', async () => {
  const text = '<svg><text>中文流程图</text></svg>';
  await sendImage('svg', `data:image/svg+xml,${encodeURIComponent(text)}`);
  const [blob, filename] = vi.mocked(exportBlobWithDialog).mock.calls[0];
  expect(filename).toBe('流程图.svg');
  expect(new TextDecoder().decode(await readBlob(blob))).toBe(text);
  expect(fetch).not.toHaveBeenCalled();
});

test('取消保存时不显示导出成功', async () => {
  vi.mocked(exportBlobWithDialog).mockResolvedValue(false);
  await sendImage('png', 'data:image/png;base64,iVBORwD/');
  expect(exportBlobWithDialog).toHaveBeenCalledOnce();
  expect(showToast).not.toHaveBeenCalled();
});

test('写盘失败显示导出错误，避免静默失败', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(exportBlobWithDialog).mockRejectedValue(new Error('磁盘空间不足'));
  await sendImage('png', 'data:image/png;base64,iVBORwD/');
  expect(showToast).toHaveBeenCalledExactlyOnceWith('导出失败：磁盘空间不足', 'error');
});
