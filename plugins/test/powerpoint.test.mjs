// 组合缩放必须保持物理几何与字号独立，验证嵌套、位置、图像与图形的边界行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { normalizeGroupCoordinates, normalizePowerPointGroups } from '../powerpoint/groupGeometry.mjs';
import { cleanOpenXml } from '../shared/openXml.mjs';

const dom = new JSDOM('');
// 本地解析器用于断言；全局接口供 OpenXML 安全清理与格式适配使用。
const { DOMParser, XMLSerializer } = dom.window;
for (const key of ['DOMParser', 'XMLSerializer']) globalThis[key] = dom.window[key];
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

/** 合成非等比组合，文字大小、边距和组合自身的坐标必须完整保留。 */
function fixture(inner = '') {
  return new DOMParser().parseFromString(`<p:grpSp xmlns:p="${P}" xmlns:a="${A}" data-id="outer"><p:grpSpPr><a:xfrm rot="60000"><a:off x="1000" y="2000"/><a:ext cx="400" cy="300"/><a:chOff x="100" y="200"/><a:chExt cx="200" cy="100"/></a:xfrm></p:grpSpPr>
  <p:sp><p:spPr><a:xfrm><a:off x="110" y="220"/><a:ext cx="50" cy="20"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr><p:txBody><a:bodyPr lIns="5"/><a:p><a:r><a:rPr sz="2400"/><a:t>组合中的文字</a:t></a:r></a:p></p:txBody></p:sp>${inner}</p:grpSp>`, 'application/xml');
}

test('子对象几何吸收组合比例，组合位置、字号与边距保持不变', () => {
  const doc = fixture(), group = doc.documentElement;
  const own = group.firstElementChild.firstElementChild;
  normalizeGroupCoordinates(group);
  assert.equal(own.querySelector('off').getAttribute('x'), '1000');
  assert.equal(own.querySelector('off').getAttribute('y'), '2000');
  assert.equal(own.getAttribute('rot'), '60000');
  const shape = group.getElementsByTagNameNS(P, 'sp')[0];
  assert.equal(shape.querySelector('off').getAttribute('x'), '20');
  assert.equal(shape.querySelector('off').getAttribute('y'), '60');
  assert.equal(shape.querySelector('ext').getAttribute('cx'), '100');
  assert.equal(shape.querySelector('ext').getAttribute('cy'), '60');
  assert.equal(group.querySelector('rPr').getAttribute('sz'), '2400');
  assert.equal(group.querySelector('bodyPr').getAttribute('lIns'), '5');
  assert.equal(own.querySelector('chExt').getAttribute('cx'), '400');
  // 第二次处理不能再次放大对象或移动位置。
  const once = new XMLSerializer().serializeToString(doc);
  normalizeGroupCoordinates(group);
  assert.equal(new XMLSerializer().serializeToString(doc), once);
});

test('嵌套组合依次消化累计比例，仍保留组合和对象身份', () => {
  const inner = `<p:grpSp data-id="inner"><p:grpSpPr><a:xfrm><a:off x="120" y="230"/><a:ext cx="80" cy="40"/><a:chOff x="10" y="20"/><a:chExt cx="40" cy="20"/></a:xfrm></p:grpSpPr><p:pic><p:spPr><a:xfrm><a:off x="15" y="25"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr></p:pic></p:grpSp>`;
  const doc = fixture(inner);normalizeGroupCoordinates(doc.documentElement);
  const group = doc.querySelector('[data-id="inner"]'), pic = group.getElementsByTagNameNS(P, 'pic')[0];
  assert.equal(group.querySelector('off').getAttribute('x'), '40');
  assert.equal(group.querySelector('off').getAttribute('y'), '90');
  assert.equal(pic.querySelector('off').getAttribute('x'), '20');
  assert.equal(pic.querySelector('off').getAttribute('y'), '30');
  assert.equal(pic.querySelector('ext').getAttribute('cx'), '40');
  assert.equal(pic.querySelector('ext').getAttribute('cy'), '60');
});

test('零尺寸组合不产生 NaN，包内所有版式适配仍保持外链清理', async () => {
  const doc = fixture();doc.querySelector('chExt').setAttribute('cx', '0');
  const original = new XMLSerializer().serializeToString(doc);
  normalizeGroupCoordinates(doc.documentElement);
  assert.equal(new XMLSerializer().serializeToString(doc), original);
  const zip = new JSZip();
  for (const folder of ['slides', 'slideMasters', 'slideLayouts']) zip.file(`ppt/${folder}/test.xml`, new XMLSerializer().serializeToString(fixture()));
  zip.file('ppt/slides/_rels/test.xml.rels', '<Relationships><Relationship Type="image" Target="https://example.com/image.png" TargetMode="External"/></Relationships>');
  const clean = await JSZip.loadAsync(await cleanOpenXml(await zip.generateAsync({type:'uint8array'}), normalizePowerPointGroups));
  for (const folder of ['slides', 'slideMasters', 'slideLayouts']) {
    const xml = await clean.file(`ppt/${folder}/test.xml`).async('string');
    assert.ok(xml.includes('chExt cx="400" cy="300"'));
    assert.ok(xml.includes('sz="2400"'));
  }
  assert.ok(!(await clean.file('ppt/slides/_rels/test.xml.rels').async('string')).includes('https://'));
});
