// XMind 压缩包读取：现代 JSON 与经典 XML 共用画布、主题和资源转换流程。
import type JSZip from 'jszip';
import type { MindNode } from './mindmapTypes';
import { cloneMindmapTree, getMindmapTreeStats, mapMindmapTree, walkMindNodes } from './mindmapTree';
import { parseMindmapDocument } from './mindmapConverter';

type RawTopic = Record<string, unknown>;

export interface XmindImportSheet {
  id: string;
  title: string;
  rootTopic: RawTopic;
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
      boundaries: xmlChild(element, 'boundaries')?.children.length ? [{}] : undefined,
      summaries: xmlChild(element, 'summaries')?.children.length ? [{}] : undefined,
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
      if (Array.isArray(sheet.relationships) && sheet.relationships.length > 0) warnings.push('关联线无法转换');
      if (sheet.theme) warnings.push('XMind 主题外观将使用 NoteBoard 的导图样式');
      return { id: String(index), title: typeof sheet.title === 'string' ? sheet.title : `画布 ${index + 1}`, rootTopic: sheet.rootTopic as RawTopic, warnings };
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
    return {
      id: String(index), title: xmlChild(sheet, 'title')?.textContent ?? `画布 ${index + 1}`, rootTopic,
      warnings: xmlChild(sheet, 'relationships')?.children.length ? ['关联线无法转换'] : [],
    };
  });
}

/** 获取所有主题分组；漂浮/概要等主题依用户选择转为普通分支，不能静默跳过。 */
function topicChildren(topic: RawTopic): RawTopic[] {
  if (!topic.children || typeof topic.children !== 'object') return [];
  return Object.values(topic.children).flatMap((group) => Array.isArray(group) ? group : []) as RawTopic[];
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
  let sequence = 0;
  const root = archive.legacyRoot ? cloneMindmapTree(archive.legacyRoot) : mapMindmapTree(sheet.rootTopic, topicChildren, (topic) => {
    const children = topic.children as Record<string, unknown> | undefined;
    if (children && Object.entries(children).some(([type, group]) => type !== 'attached' && Array.isArray(group) && group.length > 0)) warnings.add('漂浮、概要等特殊主题已转为普通分支；原有位置与关系不保留');
    for (const [field, message] of [['boundaries', '边界无法转换'], ['summaries', '概要关系无法转换'], ['labels', '标签无法转换']] as const) {
      if (Array.isArray(topic[field]) && topic[field].length > 0) warnings.add(message);
    }
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
    const src = (topic.image as { src?: unknown } | undefined)?.src;
    const image = typeof src === 'string' && src ? src : undefined;
    if (image?.startsWith('xap:') || image?.startsWith('resources/')) {
      const path = resourcePath(image);
      const entry = path ? archive.zip.file(path) : null;
      if (!entry) warnings.add('部分包内图片资源缺失，无法显示');
      if (uncompressedSize(entry) > XMIND_IMPORT_WARNINGS.imageBytes) warnings.add('单张内嵌图片超过 10 MB，继续可能占用较多内存');
    }
    return { id, text: typeof topic.title === 'string' ? topic.title : '', note, icon: markerIcon(markers[0]?.markerId, warnings), image, isExpanded: topic.branch !== 'folded', children: [] };
  });
  const stats = getMindmapTreeStats(root);
  if (stats.nodeCount > XMIND_IMPORT_WARNINGS.nodeCount) warnings.add(`节点数为 ${stats.nodeCount}，超过 50,000 个，继续可能耗时较长`);
  if (stats.maxDepth > XMIND_IMPORT_WARNINGS.depth) warnings.add(`层级深度为 ${stats.maxDepth}，超过 500 层，继续可能耗时较长`);
  return { root, warnings: [...warnings] };
}

/** 已经确认导入后才展开内嵌图片，重复引用共享同一份 Data URL，原 XMind 文件不被修改。 */
export async function resolveXmindImages(archive: XmindArchive, root: MindNode): Promise<MindNode> {
  const images = new Map<string, string | undefined>();
  for (const node of walkMindNodes(root)) {
    if (!node.image?.startsWith('xap:') && !node.image?.startsWith('resources/')) continue;
    const path = resourcePath(node.image);
    const entry = path ? archive.zip.file(path) : null;
    if (!path || !entry) { delete node.image; continue; }
    if (!images.has(path)) {
      const base64 = await entry.async('base64');
      const extension = path.split('.').at(-1)?.toLowerCase();
      const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };
      const mime = types[extension ?? ''] ?? (base64.startsWith('/9j/') ? 'image/jpeg' : 'image/png');
      images.set(path, `data:${mime};base64,${base64}`);
    }
    node.image = images.get(path);
  }
  return root;
}
