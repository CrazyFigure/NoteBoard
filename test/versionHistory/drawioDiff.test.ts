// @vitest-environment jsdom
// NoteBoard Draw.io 差异测试：明文与压缩页面解码、按图形 id 统计改动、逐行文本

import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { decodeDrawio, diffDrawio, drawioText } from '../../src/features/versionHistory/diff/drawioDiff';

const model = (cells: string) => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
const box = (id: string, value: string, x = 0) =>
  `<mxCell id="${id}" value="${value}" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="${x}" y="0" width="120" height="60" as="geometry"/></mxCell>`;

describe('drawioDiff', () => {
  it('明文页面：识别新增、修改与删除的图形', async () => {
    const base = await decodeDrawio(`<mxfile><diagram id="p1" name="架构">${model(box('a', '前端') + box('b', '后端') + box('c', '缓存'))}</diagram></mxfile>`);
    const next = await decodeDrawio(`<mxfile><diagram id="p1" name="架构">${model(box('a', '前端') + box('b', '后端', 80) + box('d', '数据库'))}</diagram></mxfile>`);
    expect(base).not.toBeNull();
    const pages = diffDrawio(base, next!);
    expect(pages).toEqual([{ name: '架构', ins: ['数据库'], mod: ['后端'], del: ['缓存'] }]);
    const text = drawioText(next!);
    expect(text).toContain('# 页面：架构');
    expect(text.split('\n').filter((l) => l.startsWith('<cell')).length).toBe(3);
  });

  it.skipIf(typeof DecompressionStream === 'undefined')('压缩页面先解码再比较', async () => {
    const raw = encodeURIComponent(model(box('a', 'Hello')));
    const compressed = deflateRawSync(Buffer.from(raw)).toString('base64');
    const pages = await decodeDrawio(`<mxfile><diagram id="p" name="页1">${compressed}</diagram></mxfile>`);
    expect(pages?.[0].cells.find((c) => c.id === 'a')?.label).toBe('Hello');
  });

  it('不是 Draw.io 内容时返回 null；新增和删除的页面单独列出', async () => {
    expect(await decodeDrawio('<html></html>')).toBeNull();
    const a = await decodeDrawio(`<mxfile><diagram id="p1" name="一">${model(box('x', 'X'))}</diagram></mxfile>`);
    const b = await decodeDrawio(`<mxfile><diagram id="p2" name="二">${model('')}</diagram></mxfile>`);
    const pages = diffDrawio(a, b!);
    expect(pages.map((p) => p.name)).toEqual(['二（新页面）', '一（已删除）']);
  });
});
