// DrawingML 组合的子坐标缩放只用于几何布局，字号以文档声明的物理单位渲染。
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';

/** 只读取直接子节点，防止误取嵌套组合的坐标或文字属性。 */
function child(node, name) {
  return Array.from(node?.children ?? []).find((item) => item.localName === name);
}

/** 把组合缩放折算到子对象的坐标和尺寸，再将组合坐标比例归一。
 * SVG 引擎会把组合 scale 同时施加到文字；提前换算几何可避免字号被重复放大，
 * 保留组合、对象 ID 和动画关系，主视图与缩略图使用同一份布局。
 */
export function normalizeGroupCoordinates(group) {
  const transform = child(child(group, 'grpSpPr'), 'xfrm');
  const extent = child(transform, 'ext'), childExtent = child(transform, 'chExt'), origin = child(transform, 'chOff');
  const width = Number(extent?.getAttribute('cx')), height = Number(extent?.getAttribute('cy'));
  const childWidth = Number(childExtent?.getAttribute('cx')), childHeight = Number(childExtent?.getAttribute('cy'));
  // 缺失或退化的坐标不能推导比例，交给原引擎处理；不引入 NaN 或无限尺寸。
  if (![width, height, childWidth, childHeight].every((value) => Number.isFinite(value) && value > 0) || !origin) return;
  const sx = width / childWidth, sy = height / childHeight;
  const ox = Number(origin.getAttribute('x')), oy = Number(origin.getAttribute('y'));
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) return;
  for (const shape of Array.from(group.children)) {
    // grpSpPr 保存当前组合自身的位置，不能把它作为子对象再次换算。
    if (shape.namespaceURI !== PRESENTATION_NS || !['sp', 'cxnSp', 'pic', 'graphicFrame', 'grpSp'].includes(shape.localName)) continue;
    const props = child(shape, shape.localName === 'grpSp' ? 'grpSpPr' : 'spPr');
    const frame = child(props, 'xfrm') ?? child(shape, 'xfrm');
    if (!frame) continue;
    const offset = child(frame, 'off'), size = child(frame, 'ext');
    if (offset && size) {
      offset.setAttribute('x', String(Math.round((Number(offset.getAttribute('x')) - ox) * sx)));
      offset.setAttribute('y', String(Math.round((Number(offset.getAttribute('y')) - oy) * sy)));
      size.setAttribute('cx', String(Math.round(Number(size.getAttribute('cx')) * sx)));
      size.setAttribute('cy', String(Math.round(Number(size.getAttribute('cy')) * sy)));
    }
    // 外层换算先更新内层组合的尺寸，再递归消化累积比例；文字与线宽均不参与缩放。
    if (shape.namespaceURI === PRESENTATION_NS && shape.localName === 'grpSp') normalizeGroupCoordinates(shape);
  }
  origin.setAttribute('x', '0'); origin.setAttribute('y', '0');
  childExtent.setAttribute('cx', String(width)); childExtent.setAttribute('cy', String(height));
}

/** 同时处理幻灯片、版式和母版，保持继承内容与缩略图一致；只修改内存中的 XML。 */
export async function normalizePowerPointGroups(zip) {
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !/^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/i.test(entry.name)) continue;
    const doc = new DOMParser().parseFromString(await entry.async('string'), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('幻灯片布局数据损坏');
    const groups = Array.from(doc.getElementsByTagNameNS(PRESENTATION_NS, 'grpSp'));
    for (const group of groups) if (group.parentElement?.localName !== 'grpSp') normalizeGroupCoordinates(group);
    if (groups.length) zip.file(entry.name, new XMLSerializer().serializeToString(doc));
  }
}
