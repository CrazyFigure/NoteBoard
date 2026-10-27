// XMind 压缩包读取：现代 JSON 与经典 XML 共用画布、主题和资源转换流程。
import type JSZip from 'jszip';
import type { MindNode } from './mindmapTypes';
import { cloneMindmapTree, getMindmapTreeStats, mapMindmapTree, walkMindNodes } from './mindmapTree';
import { generateNodeId, parseMindmapDocument } from './mindmapConverter';
import { pruneMindmapStructures } from './mindmapStructures';

type RawTopic = Record<string, unknown>;

/** 画布级联系线（现代 JSON 与经典 XML 统一为同一中间结构） */
interface RawRelationship {
  id?: unknown;
  end1Id?: unknown;
  end2Id?: unknown;
  title?: unknown;
}

/** 外框 / 概要的原始范围描述 */
interface RawRange {
  id?: unknown;
  range?: unknown;
  title?: unknown;
  topicId?: unknown;
}

export interface XmindImportSheet {
  id: string;
  title: string;
  rootTopic: RawTopic;
  /** 画布级联系线 */
  relationships?: RawRelationship[];
  warnings: string[];
}

export interface XmindArchive {
  zip: JSZip;
  contentPath: 'content.json' | 'content.xml';
  contentBytes: number;
  /** 旧版错误使用 .xmind 后缀的原生 JSON，仅在风险确认后解析。 */
  legacyBuffer?: ArrayBuffer;
  legacyRoot?: MindNode;
}

/** 用户确认的警戒值只用于询问风险，不能据此截断或偷偷丢弃内容。 */
export const XMIND_IMPORT_WARNINGS = {
  nodeCount: 50_000,
  depth: 500,
  contentBytes: 20 * 1024 * 1024,
  imageBytes: 10 * 1024 * 1024,
} as const;

/** 安全读取 ZIP 已声明的解压尺寸；具体解压仍由 JSZip 验证文件结构。 */
function uncompressedSize(entry: JSZip.JSZipObject | null): number {
  return (entry as (JSZip.JSZipObject & { _data?: { uncompressedSize?: number } }) | null)?._data?.uncompressedSize ?? 0;
}

/** 先读取目录和正文大小，让调用方能在大正文解压、解析前询问是否继续。 */
export async function inspectXmindArchive(buffer: ArrayBuffer): Promise<XmindArchive> {
  const Zip = (await import('jszip')).default;
  const prefix = new TextDecoder().decode(buffer.slice(0, 128)).trimStart();
  if (prefix.startsWith('{')) return { zip: new Zip(), contentPath: 'content.json', contentBytes: buffer.byteLength, legacyBuffer: buffer };
  const zip = await Zip.loadAsync(buffer);
  const contentPath = zip.file('content.json') ? 'content.json' : 'content.xml';
  const entry = zip.file(contentPath);
  if (!entry) throw new Error('未在 XMind 文件中找到 content.json 或 content.xml');
  return { zip, contentPath, contentBytes: uncompressedSize(entry) };
}

/** 只读取直接子元素，避免把深层主题的标题、备注错误当作父主题字段。 */
function xmlChildren(element: Element, name: string): Element[] {
  return Array.from(element.children).filter((child) => child.localName === name);
}

function xmlChild(element: Element | undefined, name: string): Element | undefined {
  return element ? xmlChildren(element, name)[0] : undefined;
}

/** XML 字段按局部名称读取，兼容 xhtml/xlink 等不同命名空间前缀。 */
function xmlAttribute(element: Element, name: string): string | undefined {
  return Array.from(element.attributes).find((attribute) => attribute.localName === name)?.value;
}

/** 经典主题以显式栈转换为中间结构，保留每个 children/topics 分组中的全部主题。 */
function xmlTopic(root: Element): RawTopic {
  const create = (element: Element): RawTopic => {
    const notes = xmlChild(element, 'notes');
    const plain = xmlChild(notes, 'plain');
    const html = xmlChild(notes, 'html');
    const image = xmlChild(element, 'image');
    const labels = xmlChild(element, 'labels');
    return {
      id: element.getAttribute('id'),
      title: xmlChild(element, 'title')?.textContent ?? '',
      branch: element.getAttribute('branch'),
      notes: plain ? { plain: { content: plain.textContent ?? '' } }
        : html ? { html: { content: html.innerHTML } } : undefined,
      markers: xmlChildren(xmlChild(element, 'marker-refs') ?? element, 'marker-ref').map((marker) => ({ markerId: marker.getAttribute('marker-id') })),
      image: image ? { src: xmlAttribute(image, 'src') } : undefined,
      labels: labels?.textContent ? [labels.textContent] : undefined,
      href: xmlAttribute(element, 'href'),
      style: element.hasAttribute('style-id') ? {} : undefined,
      structureClass: element.getAttribute('structure-class'),
      // 外框与概要统一为与现代 JSON 相同的 { id, range, title / topicId } 结构
      boundaries: xmlChildren(xmlChild(element, 'boundaries') ?? element, 'boundary').map((boundary) => ({
        id: boundary.getAttribute('id'),
        range: boundary.getAttribute('range'),
        title: xmlChild(boundary, 'title')?.textContent ?? undefined,
      })),
      summaries: xmlChildren(xmlChild(element, 'summaries') ?? element, 'summary').map((summary) => ({
        id: summary.getAttribute('id'),
        range: summary.getAttribute('range'),
        topicId: summary.getAttribute('topic-id'),
      })),
      children: {} as Record<string, RawTopic[]>,
    };
  };
  const result = create(root);
  const stack = [{ element: root, topic: result }];
  while (stack.length > 0) {
    const { element, topic } = stack.pop()!;
    const children = xmlChild(element, 'children');
    for (const group of children ? xmlChildren(children, 'topics') : []) {
      const type = group.getAttribute('type') || 'attached';
      const target = (topic.children as Record<string, RawTopic[]>)[type] ??= [];
      for (const child of xmlChildren(group, 'topic')) {
        const next = create(child);
        target.push(next);
        stack.push({ element: child, topic: next });
      }
    }
  }
  return result;
}

/** 解析画布清单。现代文件解析失败时不得回退到仅含兼容提示的 XML，以免丢失真实正文。 */
export async function readXmindSheets(archive: XmindArchive): Promise<XmindImportSheet[]> {
  if (archive.legacyBuffer) {
    const content = new TextDecoder().decode(archive.legacyBuffer);
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const candidate = (parsed.root ?? parsed) as Partial<MindNode>;
    const stack = [candidate];
    // 只恢复可确认的旧版原生节点结构，不把任意 JSON 当作 Markdown 或空导图导入。
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node.text !== 'string' || !Array.isArray(node.children)) throw new Error('此文件不是有效的 XMind 压缩包或旧版 NoteBoard 导图');
      for (const child of node.children) stack.push(child);
    }
    archive.legacyRoot = parseMindmapDocument(content);
    return [{ id: '0', title: archive.legacyRoot.text || '旧版导图', rootTopic: {}, warnings: ['这是旧版 NoteBoard 使用 .xmind 后缀保存的 JSON，将转换为 .mindmap；原文件保留'] }];
  }
  const content = await archive.zip.file(archive.contentPath)!.async('text');
  if (archive.contentPath === 'content.json') {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('XMind 的画布数据为空或格式无效');
    return parsed.map((sheet: Record<string, unknown>, index) => {
      if (!sheet || typeof sheet.rootTopic !== 'object' || !sheet.rootTopic) throw new Error(`XMind 第 ${index + 1} 个画布缺少中心主题`);
      const warnings: string[] = [];
      if (sheet.theme) warnings.push('XMind 主题外观将使用 NoteBoard 的导图样式');
      return {
        id: String(index), title: typeof sheet.title === 'string' ? sheet.title : `画布 ${index + 1}`, rootTopic: sheet.rootTopic as RawTopic,
        relationships: Array.isArray(sheet.relationships) ? sheet.relationships as RawRelationship[] : undefined, warnings,
      };
    });
  }
  const xml = new DOMParser().parseFromString(content, 'application/xml');
  if (xml.getElementsByTagNameNS('*', 'parsererror').length > 0) throw new Error('经典 XMind 的 XML 格式无效');
  const sheets = xmlChildren(xml.documentElement, 'sheet');
  if (sheets.length === 0) throw new Error('经典 XMind 文件中没有画布');
  return sheets.map((sheet, index) => {
    const topics = xmlChildren(sheet, 'topic');
    if (topics.length === 0) throw new Error(`XMind 第 ${index + 1} 个画布缺少中心主题`);
    const rootTopic = xmlTopic(topics[0]);
    // 经典格式允许画布直接挂载漂浮主题，同样保留为根下普通分支并明确提示。
    if (topics.length > 1) (rootTopic.children as Record<string, RawTopic[]>).detached = topics.slice(1).map(xmlTopic);
    const relationships = xmlChildren(xmlChild(sheet, 'relationships') ?? sheet, 'relationship').map((relationship): RawRelationship => ({
      id: relationship.getAttribute('id'),
      end1Id: relationship.getAttribute('end1'),
      end2Id: relationship.getAttribute('end2'),
      title: xmlChild(relationship, 'title')?.textContent ?? undefined,
    }));
    return {
      id: String(index), title: xmlChild(sheet, 'title')?.textContent ?? `画布 ${index + 1}`, rootTopic,
      relationships, warnings: [],
    };
  });
}

/** 被 summaries 引用的概要主题 id：这些主题转为概要文字，不再作为普通分支 */
function referencedSummaryIds(topic: RawTopic): Set<string> {
  const ids = new Set<string>();
  for (const summary of Array.isArray(topic.summaries) ? topic.summaries as RawRange[] : []) {
    if (typeof summary?.topicId === 'string') ids.add(summary.topicId);
  }
  return ids;
}

/** 某个主题分组（attached / detached / summary 等） */
function topicGroup(topic: RawTopic, type: string): RawTopic[] {
  const group = (topic.children as Record<string, unknown> | undefined)?.[type];
  return Array.isArray(group) ? group as RawTopic[] : [];
}

/**
 * 获取所有主题分组：常规子主题在前（外框 / 概要的下标区间以它为准）；
 * 漂浮等特殊主题与未被引用的概要主题转为普通分支，不能静默跳过。
 */
function topicChildren(topic: RawTopic): RawTopic[] {
  if (!topic.children || typeof topic.children !== 'object') return [];
  const referenced = referencedSummaryIds(topic);
  const result = [...topicGroup(topic, 'attached')];
  for (const [type, group] of Object.entries(topic.children as Record<string, unknown>)) {
    if (type === 'attached' || !Array.isArray(group)) continue;
    for (const child of group as RawTopic[]) {
      if (type === 'summary' && typeof child?.id === 'string' && referenced.has(child.id)) continue;
      result.push(child);
    }
  }
  return result;
}

/** 解析 XMind 范围 "(起,止)"；"master" 表示主题自身 */
function parseRange(range: unknown): [number, number] | 'master' | null {
  if (range === 'master') return 'master';
  if (typeof range !== 'string') return null;
  const match = /^\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(range.trim());
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return a <= b ? [a, b] : [b, a];
}

/** 只把包内路径映射到 ZIP 条目，不访问外部文件系统，也不接受上级目录跳转。 */
function resourcePath(src: string): string | null {
  if (!src.startsWith('xap:') && !src.startsWith('resources/')) return null;
  let value = src.replace(/^xap:/, '').replace(/^\/+/, '');
  try { value = decodeURIComponent(value); } catch { /* 无效编码沿用原值，后续按缺失资源提示。 */ }
  return value.split(/[\\/]/).includes('..') ? null : value.replace(/\\/g, '/');
}

/** 常见 XMind 内置标记按用户选择映射为近似 Emoji；未知标记不作为长字符串挤坏节点。 */
function markerIcon(markerId: string | undefined, warnings: Set<string>): string | undefined {
  if (!markerId) return undefined;
  if (/\p{Extended_Pictographic}|\u20E3/u.test(markerId)) return markerId;
  const priority = /^priority-([1-9])$/.exec(markerId);
  if (priority) {
    warnings.add('XMind 内置图标已映射为近似 Emoji');
    return `${priority[1]}\uFE0F\u20E3`;
  }
  const common: Record<string, string> = {
    'task-start': '⬜', 'task-done': '✅',
    'smiley-smile': '🙂', 'smiley-laugh': '😄', 'smiley-angry': '😠', 'smiley-sad': '🙁', 'smiley-surprise': '😮',
    'symbol-yes': '✅', 'symbol-no': '❌', 'symbol-question': '❓',
  };
  const icon = common[markerId] ?? (/^flag-/.test(markerId) ? '🚩' : /^star-/.test(markerId) ? '⭐' : /^task-/.test(markerId) ? '🟡' : undefined);
  warnings.add(icon ? 'XMind 内置图标已映射为近似 Emoji' : '部分内置图标无法识别，未转换');
  return icon;
}

/** 中间主题转为原生节点，同时收集转换差异与规模风险，供导入前统一确认。 */
export function prepareXmindSheet(archive: XmindArchive, sheet: XmindImportSheet): { root: MindNode; warnings: string[] } {
  const warnings = new Set(sheet.warnings);
  const ids = new Set<string>();
  // 原始主题 → 新节点（外框 / 概要 / 联系线在整树建好后再按 id 解析）
  const rawOf = new Map<MindNode, RawTopic>();
  const idOf = new Map<string, string>();
  let sequence = 0;
  const root = archive.legacyRoot ? cloneMindmapTree(archive.legacyRoot) : mapMindmapTree(sheet.rootTopic, topicChildren, (topic) => {
    const children = topic.children as Record<string, unknown> | undefined;
    const referenced = referencedSummaryIds(topic);
    if (children && Object.entries(children).some(([type, group]) => type !== 'attached' && Array.isArray(group)
      && (group as RawTopic[]).some((child) => type !== 'summary' || typeof child?.id !== 'string' || !referenced.has(child.id)))) {
      warnings.add('漂浮、概要等特殊主题已转为普通分支；原有位置与关系不保留');
    }
    if (Array.isArray(topic.labels) && topic.labels.length > 0) warnings.add('标签无法转换');
    if (topic.href) warnings.add('主题超链接和附件链接无法转换');
    if (topic.style || topic.styleId || topic.attributedTitle || topic.structureClass) warnings.add('主题的布局、专属样式或富文本格式将使用 NoteBoard 的导图样式');
    const markers = Array.isArray(topic.markers) ? topic.markers as Array<{ markerId?: string }> : [];
    if (markers.length > 1) warnings.add('每个主题仅显示第一个图标，其余标记不转换');
    const notes = (topic.notes ?? topic.note) as { plain?: { content?: string }; html?: { content?: string } } | undefined;
    let note = typeof notes?.plain?.content === 'string' ? notes.plain.content : undefined;
    if (note === undefined && typeof notes?.html?.content === 'string') {
      // template 内容保持惰性，不因转换备注而加载其中的图片或执行脚本。
      const template = document.createElement('template');
      template.innerHTML = notes.html.content;
      for (const lineBreak of template.content.querySelectorAll('br')) lineBreak.replaceWith('\n');
      for (const block of template.content.querySelectorAll('p,div,li')) block.append('\n');
      note = template.content.textContent?.replace(/\n{3,}/g, '\n\n').trimEnd() ?? '';
      warnings.add('富文本备注已转为纯文本，保留文字内容');
    }
    let id = typeof topic.id === 'string' && topic.id ? topic.id : `xmind-import-${++sequence}`;
    while (ids.has(id)) id = `xmind-import-${++sequence}`;
    ids.add(id);
    // 重复 id 只记录首次出现，联系线按原 id 指向第一处主题
    if (typeof topic.id === 'string' && topic.id && !idOf.has(topic.id)) idOf.set(topic.id, id);
    const src = (topic.image as { src?: unknown } | undefined)?.src;
    const image = typeof src === 'string' && src ? src : undefined;
    if (image?.startsWith('xap:') || image?.startsWith('resources/')) {
      const path = resourcePath(image);
      const entry = path ? archive.zip.file(path) : null;
      if (!entry) warnings.add('部分包内图片资源缺失，无法显示');
      if (uncompressedSize(entry) > XMIND_IMPORT_WARNINGS.imageBytes) warnings.add('单张内嵌图片超过 10 MB，继续可能占用较多内存');
    }
    const node: MindNode = { id, text: typeof topic.title === 'string' ? topic.title : '', note, icon: markerIcon(markers[0]?.markerId, warnings), images: image ? [image] : undefined, isExpanded: topic.branch !== 'folded', children: [] };
    if ((Array.isArray(topic.boundaries) && topic.boundaries.length > 0) || (Array.isArray(topic.summaries) && topic.summaries.length > 0)) rawOf.set(node, topic);
    return node;
  });
  if (!archive.legacyRoot) {
    convertXmindStructures(root, rawOf, warnings);
    convertXmindRelationships(root, sheet.relationships ?? [], idOf, warnings);
    pruneMindmapStructures(root);
  }
  const stats = getMindmapTreeStats(root);
  if (stats.nodeCount > XMIND_IMPORT_WARNINGS.nodeCount) warnings.add(`节点数为 ${stats.nodeCount}，超过 50,000 个，继续可能耗时较长`);
  if (stats.maxDepth > XMIND_IMPORT_WARNINGS.depth) warnings.add(`层级深度为 ${stats.maxDepth}，超过 500 层，继续可能耗时较长`);
  return { root, warnings: [...warnings] };
}

/** 外框与概要：按常规子主题下标转为首尾子节点 id；"master" 外框挂到父节点并只圈住自身 */
function convertXmindStructures(root: MindNode, rawOf: Map<MindNode, RawTopic>, warnings: Set<string>): void {
  if (rawOf.size === 0) return;
  const parentOf = new Map<MindNode, MindNode>();
  for (const node of walkMindNodes(root)) for (const child of node.children) parentOf.set(child, node);
  for (const [node, topic] of rawOf) {
    const attachedCount = topicGroup(topic, 'attached').length;
    /** 下标区间转首尾子节点；越界部分截到常规子主题末尾 */
    const toIds = (range: [number, number]): { startId: string; endId: string } | null => {
      const last = Math.min(range[1], attachedCount - 1);
      if (range[0] > last) return null;
      return { startId: node.children[range[0]].id, endId: node.children[last].id };
    };
    for (const boundary of Array.isArray(topic.boundaries) ? topic.boundaries as RawRange[] : []) {
      const range = parseRange(boundary?.range);
      const title = typeof boundary?.title === 'string' && boundary.title ? boundary.title : undefined;
      const id = typeof boundary?.id === 'string' && boundary.id ? boundary.id : generateNodeId();
      if (range === 'master') {
        const parent = parentOf.get(node);
        if (!parent) {
          warnings.add('中心主题的外框无法转换');
          continue;
        }
        (parent.boundaries ??= []).push({ id, startId: node.id, endId: node.id, ...(title ? { title } : {}) });
        continue;
      }
      const ends = range ? toIds(range) : null;
      if (!ends) {
        warnings.add('部分外框范围无效，未转换');
        continue;
      }
      (node.boundaries ??= []).push({ id, ...ends, ...(title ? { title } : {}) });
    }
    const summaryTopics = topicGroup(topic, 'summary');
    for (const summary of Array.isArray(topic.summaries) ? topic.summaries as RawRange[] : []) {
      const range = parseRange(summary?.range);
      const ends = range && range !== 'master' ? toIds(range) : null;
      const summaryTopic = summaryTopics.find((item) => item?.id === summary?.topicId);
      if (!ends) {
        warnings.add('部分概要范围无效，未转换');
        continue;
      }
      if (summaryTopic && topicChildren(summaryTopic).length > 0) warnings.add('概要主题下的子分支无法转换');
      (node.summaries ??= []).push({
        id: typeof summary?.id === 'string' && summary.id ? summary.id : generateNodeId(),
        ...ends,
        text: typeof summaryTopic?.title === 'string' ? summaryTopic.title : '',
      });
    }
  }
}

/** 画布级联系线挂到起点节点；端点缺失的联系线明确提示 */
function convertXmindRelationships(root: MindNode, relationships: RawRelationship[], idOf: Map<string, string>, warnings: Set<string>): void {
  if (relationships.length === 0) return;
  const byId = new Map<string, MindNode>();
  for (const node of walkMindNodes(root)) byId.set(node.id, node);
  for (const relationship of relationships) {
    const from = typeof relationship?.end1Id === 'string' ? byId.get(idOf.get(relationship.end1Id) ?? '') : undefined;
    const to = typeof relationship?.end2Id === 'string' ? idOf.get(relationship.end2Id) : undefined;
    if (!from || !to || !byId.has(to) || to === from.id) {
      warnings.add('部分关联线端点缺失，未转换');
      continue;
    }
    const title = typeof relationship.title === 'string' && relationship.title ? relationship.title : undefined;
    (from.relations ??= []).push({
      id: typeof relationship.id === 'string' && relationship.id ? relationship.id : generateNodeId(),
      targetId: to,
      ...(title ? { title } : {}),
    });
  }
}

/** 已经确认导入后才展开内嵌图片，重复引用共享同一份 Data URL，原 XMind 文件不被修改。 */
export async function resolveXmindImages(archive: XmindArchive, root: MindNode): Promise<MindNode> {
  const images = new Map<string, string | undefined>();
  for (const node of walkMindNodes(root)) {
    if (!node.images) continue;
    const resolved: string[] = [];
    for (const src of node.images) {
      if (!src.startsWith('xap:') && !src.startsWith('resources/')) { resolved.push(src); continue; }
      const path = resourcePath(src);
      const entry = path ? archive.zip.file(path) : null;
      // 包内资源缺失的图片直接丢弃
      if (!path || !entry) continue;
      if (!images.has(path)) {
        const base64 = await entry.async('base64');
        const extension = path.split('.').at(-1)?.toLowerCase();
        const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };
        const mime = types[extension ?? ''] ?? (base64.startsWith('/9j/') ? 'image/jpeg' : 'image/png');
        images.set(path, `data:${mime};base64,${base64}`);
      }
      resolved.push(images.get(path)!);
    }
    if (resolved.length > 0) node.images = resolved;
    else delete node.images;
  }
  return root;
}
