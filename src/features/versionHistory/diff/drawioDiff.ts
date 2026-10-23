// NoteBoard 文档历史记录：Draw.io 差异
//
// .drawio 的每个 <diagram>（页面）可能是明文 <mxGraphModel>，也可能是压缩内容
// （base64 → raw deflate → URI 编码的 XML）。先解码为明文，再把每个图形（mxCell）整理成一行：
//   - 逐行差异：同一图形的属性变化落在同一行，删除 / 新增一目了然
//   - 按图形 id 统计每页的新增 / 修改 / 删除，并给出图形文字
// 解码使用浏览器自带的 DecompressionStream，离线可用。

export interface DrawioCell {
  id: string;
  /** 规范化后的一行描述（比较键与逐行差异内容） */
  line: string;
  /** 图形上的文字（去掉 HTML 标记） */
  label: string;
}

export interface DrawioPage {
  id: string;
  name: string;
  cells: DrawioCell[];
}

export interface DrawioPageDiff {
  name: string;
  ins: string[];
  del: string[];
  mod: string[];
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 解压页面内容：raw deflate → 文本 → URI 解码 */
async function inflatePage(text: string): Promise<string> {
  const body = new Response(base64ToBytes(text) as BodyInit).body;
  if (!body) throw new Error('无法读取图表内容');
  const stream = body.pipeThrough(new DecompressionStream('deflate-raw'));
  const raw = await new Response(stream).text();
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function stripHtml(s: string): string {
  return s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** mxCell → 一行描述：属性按名称排序，几何信息附在后面 */
function cellLine(cell: Element): string {
  const attrs = [...cell.attributes].map((a) => `${a.name}="${a.value}"`).sort();
  const geo = cell.querySelector(':scope > mxGeometry');
  const geoAttrs = geo ? [...geo.attributes].filter((a) => a.name !== 'as').map((a) => `${a.name}="${a.value}"`).sort() : [];
  const points = geo ? [...geo.querySelectorAll('mxPoint')].map((p) => `(${p.getAttribute('x') ?? ''},${p.getAttribute('y') ?? ''})`).join('') : '';
  return `<cell ${attrs.join(' ')}${geoAttrs.length ? ` geo: ${geoAttrs.join(' ')}` : ''}${points ? ` points: ${points}` : ''}>`;
}

function cellsFromModel(model: Element): DrawioCell[] {
  const cells: DrawioCell[] = [];
  // UserObject / object 包装的图形：文字在包装元素的 label 属性上
  for (const el of model.querySelectorAll('mxCell, UserObject, object')) {
    if (el.tagName === 'mxCell' && el.parentElement && el.parentElement.tagName !== 'root') continue;
    const inner = el.tagName === 'mxCell' ? el : el.querySelector('mxCell');
    const id = el.getAttribute('id') ?? inner?.getAttribute('id') ?? '';
    if (!id) continue;
    // 结构性根节点（id 0 / 1 这类既不是图形也不是连线的图层容器）不参与比较
    const shape = inner ?? el;
    if (el.tagName === 'mxCell' && !shape.hasAttribute('vertex') && !shape.hasAttribute('edge')) continue;
    const label = stripHtml(el.getAttribute('label') ?? el.getAttribute('value') ?? inner?.getAttribute('value') ?? '');
    const line = el.tagName === 'mxCell' ? cellLine(el) : `${cellLine(el)} ${inner ? cellLine(inner) : ''}`;
    cells.push({ id, line, label });
  }
  return cells;
}

/** 解析 .drawio 内容为页面列表；不是有效的 Draw.io 文件时返回 null */
export async function decodeDrawio(xml: string): Promise<DrawioPage[] | null> {
  if (!xml.trim()) return [];
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) return null;
  const root = doc.documentElement;
  // 单页明文：根节点直接是 mxGraphModel
  if (root.tagName === 'mxGraphModel') return [{ id: 'page', name: '第 1 页', cells: cellsFromModel(root) }];
  if (root.tagName !== 'mxfile') return null;
  const pages: DrawioPage[] = [];
  const diagrams = [...root.querySelectorAll(':scope > diagram')];
  for (const [i, d] of diagrams.entries()) {
    let model = d.querySelector('mxGraphModel');
    if (!model) {
      const text = d.textContent?.trim() ?? '';
      if (text) {
        try {
          const inner = new DOMParser().parseFromString(await inflatePage(text), 'text/xml');
          model = inner.querySelector('mxGraphModel');
        } catch {
          model = null;
        }
      }
    }
    pages.push({ id: d.getAttribute('id') ?? String(i), name: d.getAttribute('name') ?? `第 ${i + 1} 页`, cells: model ? cellsFromModel(model) : [] });
  }
  return pages;
}

/** 逐行差异用的明文：每页一个标题行，每个图形一行 */
export function drawioText(pages: DrawioPage[]): string {
  return pages.map((p) => [`# 页面：${p.name}`, ...p.cells.map((c) => (c.label ? `${c.line}  // ${c.label}` : c.line))].join('\n')).join('\n\n') + '\n';
}

/** 按页面与图形 id 统计改动 */
export function diffDrawio(base: DrawioPage[] | null, target: DrawioPage[]): DrawioPageDiff[] {
  if (!base) return [];
  const byPage = new Map(base.map((p) => [p.id, p]));
  const out: DrawioPageDiff[] = [];
  const name = (c: DrawioCell) => c.label || `图形 ${c.id}`;
  for (const page of target) {
    const old = byPage.get(page.id);
    byPage.delete(page.id);
    const oldCells = new Map((old?.cells ?? []).map((c) => [c.id, c]));
    const diff: DrawioPageDiff = { name: page.name, ins: [], del: [], mod: [] };
    for (const c of page.cells) {
      const o = oldCells.get(c.id);
      if (!o) diff.ins.push(name(c));
      else if (o.line !== c.line) diff.mod.push(name(c));
      oldCells.delete(c.id);
    }
    for (const c of oldCells.values()) diff.del.push(name(c));
    if (!old) diff.name = `${page.name}（新页面）`;
    if (diff.ins.length || diff.del.length || diff.mod.length || !old) out.push(diff);
  }
  for (const removed of byPage.values()) {
    out.push({ name: `${removed.name}（已删除）`, ins: [], del: removed.cells.map((c) => c.label || `图形 ${c.id}`), mod: [] });
  }
  return out;
}
