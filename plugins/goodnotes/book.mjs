// Goodnotes 5/6 的笔迹采用 protobuf journal；仅解释已知字段，复杂对象明确提示缺失。
import { openNoteArchive, noteResources } from '../shared/noteArchive.mjs';
import { wire, records, field, stringField, strokePoints } from './binary.mjs';

/** 读取纸张和页面创建事件；只有内容 UUID 可与实际文件对应时采用日志顺序。 */
function pageModel(bytes, names) {
  const papers = new Map(), pages = new Map();
  for (const record of records(bytes)) {
    const fields = wire(record), paper = field(fields, 2), created = field(fields, 54);
    if (paper instanceof Uint8Array) {
      const body = wire(paper), dimensions = field(body, 8);
      if (dimensions instanceof Uint8Array) { const dims = wire(dimensions); papers.set(stringField(body, 2), [field(dims, 1), field(dims, 2)]); }
    }
    if (created instanceof Uint8Array) {
      const body = wire(created), entity = stringField(body, 2), split = entity.lastIndexOf('-');
      if (split < 0 || !/^[0-9a-f-]{36}$/i.test(entity)) continue;
      const tail = (BigInt(`0x${entity.slice(split + 1)}`) + 1n).toString(16).padStart(12, '0');
      if (tail.length !== 12) continue;
      const id = `${entity.slice(0, split + 1)}${tail}`.toUpperCase();
      const ref = field(body, 3), order = field(body, 4);
      pages.set(id, { id, paper: ref instanceof Uint8Array ? stringField(wire(ref), 1) : '', order: order instanceof Uint8Array ? stringField(wire(order), 1) : '' });
    }
  }
  if (![...pages.keys()].some((id) => names.has(id))) return [];
  return [...pages.values()].sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : 0)
    .map((page) => ({ id: page.id, dimensions: papers.get(page.paper) }));
}

/** 原生格式只读解析；缺失纸张链接、图形或文字时保留可见警告与原应用 PDF 指引。 */
export async function openGoodnotes(bytes, signal) {
  const archive = await openNoteArchive(bytes, signal);
  const index = archive.entries.find((entry) => /(^|\/)index\.notes\.pb$/.test(entry.name));
  if (!index) throw new Error('不是可识别的 .goodnotes 文件（缺少 index.notes.pb）');
  const root = index.name.slice(0, -'index.notes.pb'.length);
  const resources = noteResources(archive, root, /^thumbnail\.(?:jpg|png)$/i);
  const notes = new Map(archive.entries.filter((entry) => entry.name.startsWith(`${root}notes/`))
    .map((entry) => [entry.name.slice(root.length + 6).toUpperCase(), entry]));
  const warnings = ['只读兼容解析：显示可识别的笔迹，文字、图形、擦除、图片及 PDF 背景可能无法还原。完整效果请从 Goodnotes 导出 PDF。'];
  let model = [], failures = 0, pointTotal = 0;
  const events = archive.entries.find((entry) => entry.name === `${root}index.events.pb`);
  try { if (events) model = pageModel(await archive.read(events), notes); }
  catch { signal?.throwIfAborted(); warnings.push('页面日志无法识别，页序和纸张大小可能与原笔记不同。'); }
  if (!model.length) {
    warnings.push('未能确认页面日志，按索引或文件顺序显示，纸张暂用 A4。');
    const ids = [];
    try { for (const record of records(await archive.read(index))) { const id = stringField(wire(record), 1).toUpperCase(); if (notes.has(id) && !ids.includes(id)) ids.push(id); } }
    catch { signal?.throwIfAborted(); }
    model = [...ids, ...[...notes.keys()].filter((id) => !ids.includes(id))].map((id) => ({ id }));
  } else {
    const seen = new Set(model.map((page) => page.id));
    model.push(...[...notes.keys()].filter((id) => !seen.has(id)).map((id) => ({ id })));
  }
  if (model.length > 2000) throw new Error('Goodnotes 笔记超过 2000 页');
  const pages = [];
  for (const page of model) {
    signal?.throwIfAborted();
    const strokes = [], entry = notes.get(page.id);
    let journal = [];
    try { if (entry) journal = records(await archive.read(entry)); }
    catch { signal?.throwIfAborted(); failures++; }
    for (const record of journal) {
      try {
        const value = field(wire(record), 7); if (!(value instanceof Uint8Array)) continue;
        const fields = wire(value), geometry = field(fields, 2); if (!(geometry instanceof Uint8Array) || !geometry.length) continue;
        const points = strokePoints(geometry); pointTotal += points.length;
        if (pointTotal > 1000000) throw new RangeError('笔迹点数超过 100 万');
        if (points.some(([x, y, w]) => !Number.isFinite(x + y + w) || Math.abs(x) > 100000 || Math.abs(y) > 100000 || w < 0 || w > 1000)) throw new Error('笔迹坐标无效');
        const colorBytes = field(fields, 4), colors = colorBytes instanceof Uint8Array ? wire(colorBytes) : new Map();
        const rgba = [1, 2, 3, 4].map((n) => Math.max(0, Math.min(1, Number(field(colors, n) ?? (n === 4 ? 1 : 0)))));
        if (rgba.some((n) => !Number.isFinite(n))) throw new Error('笔迹颜色无效');
        const highlight = field(fields, 5) === 1n;
        if (points.length) strokes.push({ points, color: rgba.slice(0, 3).map((n) => Math.round(n * 255)), opacity: highlight && rgba[3] === 1 ? .5 : rgba[3], breaks: true });
        else failures++;
      } catch (error) { if (error instanceof RangeError) throw error; failures++; }
    }
    const [w, h] = page.dimensions ?? [];
    pages.push({ width: Number.isFinite(w) && w > 0 && w < 100000 ? w : 595.28,
      height: Number.isFinite(h) && h > 0 && h < 100000 ? h : 841.89, strokes, label: `笔迹 · 第 ${pages.length + 1} 页` });
    // 较多页面时交还事件循环，让关闭文档和触屏操作可以及时取消解析。
    if (pages.length % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (failures) warnings.push(`${failures} 个笔迹记录或页面未能解析，当前显示可能不完整。`);
  return { pages, resources, warnings };
}
