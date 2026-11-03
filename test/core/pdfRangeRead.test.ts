// 桌面二进制 IPC 与网页 Range 协议都不能意外读取整文件。
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { readPdfFileRange } from '@/core/ipc/commands';
import { invoke as webInvoke } from '@/web/runtime';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('桌面只传递请求的分块和预期文件大小', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  vi.mocked(invoke).mockResolvedValue(bytes.buffer);
  expect(await readPdfFileRange('C:/大文件.PDF', 0, 4, 300 * 1024 * 1024)).toEqual(bytes);
  expect(invoke).toHaveBeenCalledWith('read_pdf_file_range', { path:'C:/大文件.PDF', begin:0, end:4, size:300 * 1024 * 1024 });
});

it('网页仅接受正确范围的 206，忽略 Range 的整文件响应立即取消', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70]), size=300 * 1024 * 1024;
  const arrayBuffer=vi.fn().mockResolvedValue(bytes.buffer), cancel=vi.fn();
  const response={status:206,headers:new Headers({'Content-Range':`bytes 0-3/${size}`}),arrayBuffer,body:{cancel}};
  const fetchFile=vi.fn().mockResolvedValue(response);vi.stubGlobal('fetch',fetchFile);
  const args={path:'/workspace/大文件.PDF',begin:0,end:4,size};
  expect(new Uint8Array(await webInvoke<ArrayBuffer>('read_pdf_file_range',args))).toEqual(bytes);
  expect(fetchFile).toHaveBeenCalledWith(`/api/file?path=%2Fworkspace%2F%E5%A4%A7%E6%96%87%E4%BB%B6.PDF&pdfRange=1&size=${size}`,{credentials:'same-origin',headers:{Range:'bytes=0-3'}});
  response.status=200;arrayBuffer.mockClear();
  await expect(webInvoke('read_pdf_file_range',args)).rejects.toThrow('分块读取失败');
  expect(arrayBuffer).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledOnce();
  response.status=206;arrayBuffer.mockResolvedValue(new ArrayBuffer(1));
  await expect(webInvoke('read_pdf_file_range',args)).rejects.toThrow('长度不完整');
});
