// NoteBoard 二进制文件保存的传输方式
// 回归：粘贴图片慢且卡界面——图片字节曾转成 JSON 数字数组并在主线程反序列化（3 MB 约 0.7 秒），
// 现以原始字节正文传输、路径放在请求头（百分号编码，支持中文路径），约快 14 倍。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true, mtime: 0, size: 2, error: null }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { saveBinaryFile } from '../../src/core/ipc/commands';

describe('saveBinaryFile', () => {
  beforeEach(() => invoke.mockClear());

  it('以原始字节正文调用异步保存命令，路径经请求头传递', async () => {
    const bytes = new Uint8Array([1, 2]);
    await saveBinaryFile('C:\\笔记\\img\\截图 1.png', bytes);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, body, options] = invoke.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
    expect(command).toBe('save_binary_file_raw');
    // 直接传 Uint8Array，不再转换为数字数组
    expect(body).toBe(bytes);
    expect(decodeURIComponent(options.headers['x-nb-path'])).toBe('C:\\笔记\\img\\截图 1.png');
    // 请求头只能是 ASCII
    expect(/^[\x20-\x7e]+$/.test(options.headers['x-nb-path'])).toBe(true);
  });

  it('兼容数字数组参数', async () => {
    await saveBinaryFile('/notes/a.bin', [7, 8, 9]);
    const body = invoke.mock.calls[0][1] as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(Array.from(body)).toEqual([7, 8, 9]);
  });
});
