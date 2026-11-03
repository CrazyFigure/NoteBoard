// 私有格式的回归覆盖真实样例、二进制边界、空白页及只读内存副本。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { parsePlist } from '../notability/plist.mjs';
import { openNotability } from '../notability/book.mjs';
import { openGoodnotes } from '../goodnotes/book.mjs';
import { appleLz4, wire, records, field, strokePoints } from '../goodnotes/binary.mjs';
import { openNoteArchive, noteMediaType, NOTE_LIMIT } from '../shared/noteArchive.mjs';
globalThis.DOMParser = new JSDOM().window.DOMParser;
const encoder = new TextEncoder();
const fixture = (name) => fs.readFile(new URL(`./fixtures/${name}`, import.meta.url));
const join = (...items) => Uint8Array.from(items.flatMap((item) => [...item]));
const int = (n) => { const result = []; do { result.push((n & 127) | (n > 127 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Uint8Array.from(result); };
const msg = (n, bytes) => join(int(n * 8 + 2), int(bytes.length), bytes);
const str = (n, value) => msg(n, encoder.encode(value));
const record = (bytes) => join(int(bytes.length), bytes);
const u32 = (n) => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, n, true); return out; };
const float = (n) => { const out = new Uint8Array(4); new DataView(out.buffer).setFloat32(0, n, true); return out; };

/** 确定性的两页 journal：第一页有笔迹，第二页没有 notes 成员但仍应保留。 */
async function goodnotesFixture() {
  const zip = new JSZip(), id1 = '00000000-0000-0000-0000-000000000011', id2 = '00000000-0000-0000-0000-000000000021';
  const signature = encoder.encode('vuA(v)A(S(uu))A(S(uuuu))vA(f)\0');
  const body = join([1, 0], float(2), u32(0), u32(1), float(10), float(20), u32(1), float(10), float(20), float(30), float(40), [1, 0], u32(0));
  const tpl = join(encoder.encode('tpl\0'), u32(8 + signature.length + body.length), signature, body);
  const geometry = join(encoder.encode('bv4-'), u32(tpl.length), tpl, encoder.encode('bv4$'));
  zip.file('schema.pb', new Uint8Array([8, 25]));
  zip.file('index.notes.pb', record(str(1, id1)));
  zip.file(`notes/${id1}`, record(msg(7, join(str(1, 'stroke'), msg(2, geometry)))));
  const page = (entity, order) => record(msg(54, join(str(2, entity), msg(3, str(1, 'paper')), msg(4, str(1, order)))));
  zip.file('index.events.pb', join(record(msg(2, join(str(2, 'paper'), msg(8, join([13], float(600), [21], float(800)))))),
    page(id2.slice(0, -1) + '0', 'b'), page(id1.slice(0, -1) + '0', 'a')));
  return { zip, bytes: await zip.generateAsync({ type: 'uint8array' }) };
}

test('Notability 二进制 plist 的 UID、数据和负数哨兵可读', async () => {
  const bytes = new Uint8Array(await fixture('note-session.plist')), value = parsePlist(bytes);
  assert.equal(value.$objects[1].sentinel, -1);
  assert.deepEqual(value.$objects[1].curvespoints, { uid: 2 });
  assert.equal(value.$objects[2].length, 24);
  assert.throws(() => parsePlist(bytes.slice(0, -8)));
});

test('Notability 以实际 Session 目录定位并保留原始二进制', async () => {
  const zip = new JSZip(); zip.file('内部名称/Session.plist', await fixture('note-session.plist'));
  const bytes = await zip.generateAsync({ type: 'uint8array' }), before = bytes.slice();
  const book = await openNotability(bytes);
  assert.deepEqual(bytes, before);
  assert.equal(book.pages[0].strokes.length, 1);
  assert.deepEqual(book.pages[0].strokes[0].points, [[10, 20, 2], [30, 40, 2], [60, 80, 2]]);
  assert.match(book.warnings[0], /尚未合成/);
});

test('XML plist 不污染原型，损坏笔迹拒绝而非空白成功', async () => {
  const xml = '<plist><dict><key>__proto__</key><string>安全文本</string><key>data</key><data>AQID</data></dict></plist>';
  const value = parsePlist(encoder.encode(xml));
  assert.equal(Object.getPrototypeOf(value), null); assert.deepEqual([...value.data], [1, 2, 3]);
  assert.throws(() => parsePlist(encoder.encode('<plist><dict><key>坏键</key></dict></plist>')));
  const zip = new JSZip(); zip.file('Session.plist', '<plist><dict><key>$objects</key><array><dict><key>curvespoints</key><data>AQ==</data></dict></array></dict></plist>');
  await assert.rejects(openNotability(await zip.generateAsync({ type: 'uint8array' })), /数组/);
});

test('假 .note、Supernote 和任意 ZIP 均不冒充 Notability', async () => {
  await assert.rejects(openNotability(encoder.encode('noteSN_FILE_VER_')));
  const zip = new JSZip(); zip.file('hello.txt', 'not a note');
  await assert.rejects(openNotability(await zip.generateAsync({ type: 'uint8array' })), /Session/);
  await assert.rejects(openGoodnotes(await zip.generateAsync({ type: 'uint8array' })), /index/);
});

test('未知 Notability 版本只回退明确标注的预览，不伪造笔记页', async () => {
  const zip = new JSZip(); zip.file('note/Session.plist', 'unknown'); zip.file('note/thumb3x.png', new Uint8Array([137, 80, 78, 71]));
  const book = await openNotability(await zip.generateAsync({ type: 'uint8array' }));
  assert.equal(book.pages.length, 0); assert.match(book.resources[0].label, /首页/); assert.match(book.warnings[0], /仅为/);
});

test('Goodnotes 按日志排序，保留无文件的空白页与纸张尺寸', async () => {
  const { bytes } = await goodnotesFixture(), before = bytes.slice(), book = await openGoodnotes(bytes);
  assert.deepEqual(bytes, before); assert.equal(book.pages.length, 2);
  assert.equal(book.pages[0].width, 600); assert.equal(book.pages[0].height, 800);
  assert.deepEqual(book.pages[0].strokes[0].points, [[10, 20, 2], [30, 40, 2]]);
  assert.equal(book.pages[1].strokes.length, 0);
});

test('Goodnotes 真实 schema 25 导出可读取六种笔迹并提示未知图形', async () => {
  const book = await openGoodnotes(new Uint8Array(await fixture('gn-mixed-pens.goodnotes')));
  assert.equal(book.pages.length, 1); assert.equal(book.pages[0].strokes.length, 6);
  assert.equal(book.pages[0].strokes.reduce((count, stroke) => count + stroke.points.length, 0), 644);
  assert.ok(Math.abs(book.pages[0].width - 834.24) < .01);
  assert.ok(book.pages[0].strokes.some((stroke) => stroke.opacity === .5));
  assert.match(book.warnings.join(' '), /可能无法还原/); assert.match(book.resources[0].label, /首页/);
});

test('Goodnotes 压感只读取首个 flags 数组，不混用后续段编码', async () => {
  const zip = await JSZip.loadAsync(await fixture('gn-mixed-pens.goodnotes'));
  const entry = Object.values(zip.files).find((entry) => entry.name.startsWith('notes/'));
  const paths = records(await entry.async('uint8array')).map((record) => field(wire(record), 7)).filter(Boolean)
    .map((value) => field(wire(value), 2)).filter((value) => value?.length).map((value) => strokePoints(value));
  assert.equal(paths.filter((points) => points.length).length, 6);
  assert.ok(paths.flat().every(([x, y, width]) => Number.isFinite(x + y + width)));
});

test('LZ4 支持重叠回溯，拒绝越界、缺尾和超预算', () => {
  const frame = join(encoder.encode('bv41'), u32(6), u32(4), [0x11, 97, 1, 0], encoder.encode('bv4$'));
  assert.equal(new TextDecoder().decode(appleLz4(frame)), 'aaaaaa');
  const broken = frame.slice(); broken[14] = 0; assert.throws(() => appleLz4(broken), /回溯/);
  assert.throws(() => appleLz4(frame.slice(0, -4)), /结束/);
  assert.throws(() => appleLz4(join(encoder.encode('bv4-'), u32(NOTE_LIMIT + 1))), /过大/);
  assert.throws(() => wire(new Uint8Array([10, 5, 1])), /越界/);
  assert.throws(() => records(new Uint8Array([255])), /varint/);
});

test('ZIP 解压预算在读取前拒绝且关闭操作立即取消', async () => {
  const zip = new JSZip(); zip.file('large', 'x');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  // 只改中央目录宣告值，不创建真实大文件即可覆盖预检预算。
  const at = Buffer.from(bytes).indexOf(Buffer.from([80, 75, 1, 2]));
  new DataView(bytes.buffer).setUint32(at + 24, NOTE_LIMIT + 1, true);
  await assert.rejects(openNoteArchive(bytes), /64 MB/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(openGoodnotes((await goodnotesFixture()).bytes, controller.signal), /abort/i);
  assert.equal(noteMediaType(encoder.encode('<svg onload="evil()"/>')), null);
  assert.equal(noteMediaType(encoder.encode('%PDF-1.7')), 'application/pdf');
});
