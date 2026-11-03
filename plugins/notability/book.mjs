// .note 以 Session.plist 为根识别，避免将同扩展名的 Supernote 或任意 ZIP 当作 Notability。
import { openNoteArchive, noteResources } from '../shared/noteArchive.mjs';
import { parsePlist } from './plist.mjs';

/** 解码传统 Notability 的定宽笔迹；压力、文字布局和媒体合成不作无损承诺。 */
export async function openNotability(bytes, signal) {
  const archive = await openNoteArchive(bytes, signal);
  const sessions = archive.entries.filter((entry) => /(^|\/)Session\.plist$/.test(entry.name));
  if (sessions.length !== 1) throw new Error('不是可识别的 Notability .note 文件（需要唯一 Session.plist）');
  const root = sessions[0].name.slice(0, -'Session.plist'.length);
  const resources = noteResources(archive, root, /^thumb(?:\d+x)?\.png$/i);
  const warnings = ['只读兼容解析：笔迹按固定宽度显示；文字、纸张、图片及 PDF 背景尚未合成。完整效果请在 Notability 导出 PDF。'];
  let objects;
  try { objects = parsePlist(await archive.read(sessions[0]))?.$objects; }
  catch (error) { signal?.throwIfAborted(); if (!resources.length) throw error; }
  if (!Array.isArray(objects)) {
    if (!resources.length) throw new Error('尚不支持此版本的 Notability 数据，请从原应用导出 PDF');
    return { pages: [], resources, warnings: ['此版本尚不能解析正文；以下仅为内嵌预览或附件。完整阅读请从 Notability 导出 PDF。'] };
  }
  const resolve = (value, depth = 0) => {
    if (depth > 8) throw new Error('Notability 数据引用循环或过深');
    if (value && Number.isInteger(value.uid)) value = objects[value.uid];
    if (value && !(value instanceof Uint8Array) && (value['NS.data'] || value['NS.bytes'])) value = resolve(value['NS.data'] ?? value['NS.bytes'], depth + 1);
    return value;
  };
  const strokes = []; let pointTotal = 0, width = 612, height = 792;
  for (const item of objects) {
    if (!item?.curvespoints) continue;
    signal?.throwIfAborted();
    const xy = resolve(item.curvespoints), counts = resolve(item.curvesnumpoints);
    const widths = resolve(item.curveswidth), colors = resolve(item.curvescolors);
    if (![xy, counts, widths, colors].every((value) => value instanceof Uint8Array)) throw new Error('Notability 笔迹数组无效');
    const n = counts.length / 4;
    if (!Number.isInteger(n) || n > 100000 || widths.length < n * 4 || colors.length < n * 4 || xy.length % 8) throw new Error('Notability 笔迹数组不完整或过大');
    const cv = new DataView(counts.buffer, counts.byteOffset, counts.byteLength);
    const pv = new DataView(xy.buffer, xy.byteOffset, xy.byteLength), wv = new DataView(widths.buffer, widths.byteOffset, widths.byteLength);
    let position = 0;
    for (let i = 0; i < n; i++) {
      const count = cv.getUint32(i * 4, true), penWidth = wv.getFloat32(i * 4, true);
      pointTotal += count;
      if (pointTotal > 1000000 || strokes.length >= 100000 || (position + count) * 8 > xy.length) throw new Error('Notability 笔迹数据过大或损坏');
      if (!Number.isFinite(penWidth) || penWidth <= 0 || penWidth > 1000) throw new Error('Notability 笔宽无效');
      const points = [];
      for (let j = 0; j < count; j++, position++) {
        const x = pv.getFloat32(position * 8, true), y = pv.getFloat32(position * 8 + 4, true);
        if (!Number.isFinite(x + y) || Math.abs(x) > 100000 || Math.abs(y) > 1000000) throw new Error('Notability 坐标无效');
        width = Math.max(width, x + penWidth); height = Math.max(height, y + penWidth);
        points.push([x, y, penWidth]);
      }
      if (points.length) strokes.push({ points, color: [...colors.slice(i * 4, i * 4 + 3)], opacity: colors[i * 4 + 3] / 255 });
    }
    if (position * 8 !== xy.length) throw new Error('Notability 笔迹点数不匹配');
  }
  // 原格式是连续纵向坐标，保持一张长纸，不猜测分页或裁切跨页笔画。
  return { pages: strokes.length ? [{ width, height, strokes, label: '连续笔迹' }] : [], resources, warnings };
}
