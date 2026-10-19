// 桌面原始 IPC 与网页受限文件端点都必须保留压缩包字节，不能退回文本解码。
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { readXmindFile } from '@/core/ipc/commands';
import { invoke as webInvoke } from '@/web/runtime';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('桌面从应用二进制命令取得原始字节', async () => {
  const bytes = new Uint8Array([80, 75, 0, 255, 128]);
  vi.mocked(invoke).mockResolvedValue(bytes.buffer);
  expect(await readXmindFile('C:/导图/test.xmind')).toEqual(bytes);
  expect(invoke).toHaveBeenCalledWith('read_xmind_file', { path: 'C:/导图/test.xmind' });
});

it('网页沿用同源文件端点，扩展名错误或读取失败时拒绝转换', async () => {
  const bytes = new Uint8Array([80, 75, 0, 255, 128]);
  const fetchFile = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer });
  vi.stubGlobal('fetch', fetchFile);
  const buffer = await webInvoke<ArrayBuffer>('read_xmind_file', { path: '/workspace/导图.XMIND' });
  expect(new Uint8Array(buffer)).toEqual(bytes);
  expect(fetchFile).toHaveBeenCalledWith('/api/file?path=%2Fworkspace%2F%E5%AF%BC%E5%9B%BE.XMIND', { credentials: 'same-origin' });
  await expect(webInvoke('read_xmind_file', { path: '/workspace/other.txt' })).rejects.toThrow('仅支持');
  expect(fetchFile).toHaveBeenCalledTimes(1);
  fetchFile.mockResolvedValue({ ok: false });
  await expect(webInvoke('read_xmind_file', { path: '/workspace/failed.xmind' })).rejects.toThrow('读取文件失败');
});
