// NoteBoard 图片复制与另存测试
// 回归 1：图片查看器「复制图片」实际只复制了路径——本地图片经 asset 协议加载属于跨域资源，
//         画进画布后导出被拒绝，随后回退为复制路径。
// 回归 2：复制大图要约 4 秒——曾在前端解码后经 IPC 传数十 MB 像素、再由原生端编码 PNG。
//         现在本地图片只传路径、网络图片传原始压缩字节，由原生端解码；解不了的格式才传像素。
// 回归 3：发版 CSP 的 connect-src 不含 data: 与 http(s)，内嵌 / 网络图片的 fetch 必被拦截，
//         而测试 stub 了 fetch 察觉不到；这里断言这两类图片不再调用 fetch。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clipboardWriteImageFile = vi.fn((..._args: unknown[]) => Promise.resolve());
const clipboardWriteImageEncoded = vi.fn((..._args: unknown[]) => Promise.resolve());
const clipboardWriteImagePixels = vi.fn((..._args: unknown[]) => Promise.resolve());
const clipboardWriteFiles = vi.fn((..._args: unknown[]) => Promise.resolve());

vi.mock('../../src/core/ipc/commands', () => ({
  clipboardWriteImageFile: (...args: unknown[]) => clipboardWriteImageFile(...args),
  clipboardWriteImageEncoded: (...args: unknown[]) => clipboardWriteImageEncoded(...args),
  clipboardWriteImagePixels: (...args: unknown[]) => clipboardWriteImagePixels(...args),
  clipboardWriteFiles: (...args: unknown[]) => clipboardWriteFiles(...args),
  saveBinaryFile: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
  isTauri: () => true,
}));

import {
  copyImageFileToClipboard,
  copyImageToClipboard,
  suggestImageFileName,
} from '../../src/features/image-viewer/imageClipboard';

/** jsdom 的 Blob 交给 Node 的 Response 会被当成普通对象（类型变为 text/plain），这里直接构造响应 */
function fakeResponse(blob: Blob): Response {
  return { ok: true, status: 200, blob: async () => blob } as unknown as Response;
}

describe('copyImageToClipboard（桌面端）', () => {
  const drawImage = vi.fn();

  beforeEach(() => {
    for (const mock of [clipboardWriteImageFile, clipboardWriteImageEncoded, clipboardWriteImagePixels]) {
      mock.mockReset();
      mock.mockImplementation(() => Promise.resolve());
    }
    drawImage.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2, height: 1, close: vi.fn() })));
    // jsdom 没有画布实现：返回只记录绘制、给出固定像素的上下文
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      drawImage,
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4).fill(7),
      }),
    }) as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('本地图片只把路径交给原生端解码，不在前端读取或传输像素', async () => {
    await copyImageToClipboard({ path: 'C:\\docs\\img\\shot.png', url: 'http://asset.localhost/display' });
    expect(clipboardWriteImageFile).toHaveBeenCalledWith('C:\\docs\\img\\shot.png');
    expect(fetch).not.toHaveBeenCalled();
    expect(clipboardWriteImagePixels).not.toHaveBeenCalled();
  });

  it('内嵌 data 图片直接解码为原始字节，不发起被 connect-src 拦截的 fetch', async () => {
    await copyImageToClipboard({ url: 'data:image/png;base64,AQID' });
    expect(fetch).not.toHaveBeenCalled();
    expect(Array.from(clipboardWriteImageEncoded.mock.calls[0][0] as Uint8Array)).toEqual([1, 2, 3]);
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('网络图片经跨域 <img> 转 PNG，不发起被 connect-src 拦截的 fetch', async () => {
    const loaded: { crossOrigin?: string; referrerPolicy?: string; src?: string } = {};
    vi.stubGlobal('Image', class {
      naturalWidth = 4;
      naturalHeight = 3;
      crossOrigin = '';
      referrerPolicy = '';
      onload: (() => void) | null = null;
      set src(value: string) {
        Object.assign(loaded, { crossOrigin: this.crossOrigin, referrerPolicy: this.referrerPolicy, src: value });
        queueMicrotask(() => this.onload?.());
      }
    });
    // jsdom 没有画布编码实现：固定返回 PNG 字节
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback: BlobCallback) {
      callback(new Blob([new Uint8Array([9, 8])], { type: 'image/png' }));
    });
    await copyImageToClipboard({ url: 'https://example.com/a.jpg' });
    expect(fetch).not.toHaveBeenCalled();
    expect(loaded).toEqual({ crossOrigin: 'anonymous', referrerPolicy: 'no-referrer', src: 'https://example.com/a.jpg' });
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(Array.from(clipboardWriteImageEncoded.mock.calls[0][0] as Uint8Array)).toEqual([9, 8]);
  });

  it('原生端解不了的格式改由前端解码：读取原文件字节（经 asset 地址）后传 RGBA 像素', async () => {
    clipboardWriteImageFile.mockImplementation(() => Promise.reject('无法解码该图片格式：格式不受支持'));
    clipboardWriteImageEncoded.mockImplementation(() => Promise.reject('无法解码该图片格式：格式不受支持'));
    await copyImageToClipboard({ path: 'C:\\docs\\img\\shot.png' });
    expect(fetch).toHaveBeenCalledWith(`http://asset.localhost/${encodeURIComponent('C:\\docs\\img\\shot.png')}`, expect.anything());
    expect(drawImage).toHaveBeenCalledTimes(1);
    const [rgba, width, height] = clipboardWriteImagePixels.mock.calls[0] as [Uint8Array, number, number];
    expect([width, height]).toEqual([2, 1]);
    expect(rgba.length).toBe(8);
  });

  it('SVG 等原生端不支持的格式直接由前端解码，不先调用原生解码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(new Blob(['<svg/>'], { type: 'image/svg+xml' }))));
    vi.stubGlobal('Image', class {
      naturalWidth = 4;
      naturalHeight = 3;
      onload: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    });
    // jsdom 没有 blob 地址实现，临时补上并在结束后还原
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = () => 'blob:svg';
    URL.revokeObjectURL = () => undefined;
    try {
      await copyImageToClipboard({ path: '/docs/diagram.svg' });
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    }
    expect(clipboardWriteImageFile).not.toHaveBeenCalled();
    expect(clipboardWriteImageEncoded).not.toHaveBeenCalled();
    expect(clipboardWriteImagePixels.mock.calls[0].slice(1)).toEqual([4, 3]);
  });

  it('文件不存在、剪贴板被占用等错误直接提示，不再重复尝试前端解码', async () => {
    clipboardWriteImageFile.mockImplementation(() => Promise.reject('图片文件不存在'));
    await expect(copyImageToClipboard({ path: '/docs/missing.png' })).rejects.toBe('图片文件不存在');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('网络图片不允许跨域读取时给出可操作的提示，而不是静默复制路径', async () => {
    vi.stubGlobal('Image', class {
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    });
    await expect(copyImageToClipboard({ url: 'https://example.com/a.png' })).rejects.toThrow('复制图片链接');
    expect(clipboardWriteImageEncoded).not.toHaveBeenCalled();
  });
});

describe('copyImageFileToClipboard', () => {
  it('以文件列表形式写入剪贴板', async () => {
    clipboardWriteFiles.mockClear();
    await copyImageFileToClipboard('/docs/img/a.png');
    expect(clipboardWriteFiles).toHaveBeenCalledWith(['/docs/img/a.png']);
  });
});

describe('suggestImageFileName', () => {
  it('本地图片取原文件名', () => {
    expect(suggestImageFileName({ path: 'C:\\docs\\img\\截图 1.png' })).toBe('截图 1.png');
  });

  it('网络图片去掉查询串并解码文件名', () => {
    expect(suggestImageFileName({ url: 'https://cdn.example.com/a/%E5%9B%BE.jpg?x=1#top' })).toBe('图.jpg');
  });

  it('没有扩展名时按 MIME 补全', () => {
    expect(suggestImageFileName({ url: 'https://example.com/avatar' }, 'image/webp')).toBe('avatar.webp');
  });

  it('data URL 使用通用文件名', () => {
    expect(suggestImageFileName({ url: 'data:image/gif;base64,AAAA' }, 'image/gif')).toBe('image.gif');
  });

  it('替换文件名中不能落盘的字符', () => {
    expect(suggestImageFileName({ url: 'https://example.com/a%3Ab%7C.png' })).toBe('a_b_.png');
  });
});
