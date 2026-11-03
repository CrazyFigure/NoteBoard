// 数据地址解码不依赖 fetch，覆盖原生 CSP 下的图片导出及中文 / 原始二进制保真。
import { describe, expect, test } from 'vitest';
import { dataUrlToBlob } from '@/core/dataUrl';

/** jsdom 的 Blob 没有 arrayBuffer，使用浏览器 FileReader 验证实际存储的字节。 */
function bytesOf(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe('导出数据地址解码', () => {
  test('Base64 PNG 保留零字节及高位字节', async () => {
    const blob = dataUrlToBlob('data:image/png;base64,iVBORwD/');
    expect(blob.type).toBe('image/png');
    expect(await bytesOf(blob)).toEqual([137, 80, 78, 71, 0, 255]);
  });

  test('百分号编码的 PNG 不强制按 UTF-8 解码', async () => {
    const blob = dataUrlToBlob('data:image/png,%89PNG%00%FF');
    expect(await bytesOf(blob)).toEqual([137, 80, 78, 71, 0, 255]);
  });

  test.each(['<svg><text>中文 😀,100%</text></svg>', '名称,数量\n测试,1'])('UTF-8 文字与百分号编码均保留原文', async (text) => {
    const expected = Array.from(new TextEncoder().encode(text));
    expect(await bytesOf(dataUrlToBlob(`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`))).toEqual(expected);
    expect(await bytesOf(dataUrlToBlob(`data:text/plain;charset=utf-8,${text}`))).toEqual(expected);
  });

  test('Base64 SVG 支持中文及编码后的 Base64 字符', async () => {
    const text = '<svg>中文</svg>';
    const bytes = new TextEncoder().encode(text);
    const base64 = btoa(String.fromCharCode(...bytes));
    const blob = dataUrlToBlob(`data:image/svg+xml;charset=utf-8;base64,${encodeURIComponent(base64)}`);
    expect(blob.type).toBe('image/svg+xml;charset=utf-8');
    expect(await bytesOf(blob)).toEqual(Array.from(bytes));
  });

  test('省略 MIME 时使用默认文本类型，空正文仍可导出', async () => {
    const empty = dataUrlToBlob('data:,');
    expect(empty.size).toBe(0);
    expect(empty.type).toBe('text/plain;charset=us-ascii');
    expect(dataUrlToBlob('data:;charset=utf-8,test').type).toBe('text/plain;charset=utf-8');
  });

  test.each(['https://example.com/test.png', 'data:image/png', 'data:image/png;base64,***'])('无效数据报告失败：%s', (url) => {
    expect(() => dataUrlToBlob(url)).toThrow();
  });
});
