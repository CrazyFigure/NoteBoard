// NoteBoard 思维导图转换器
// 支持 NoteBoard 节点树 ⇄ XMind 格式 ⇄ Markdown 大纲双向转换
// 支持动态 import('jszip') 导入/导出 .xmind 压缩包
// 详见 docs/09-开发路线图.md

import type {
  MindNode,
  MindmapDocumentData,
  MindmapEdgeStyle,
  MindmapLayout,
  XMindContentJson,
  XMindTopic,
  XMindSheet,
} from './mindmapTypes';
import { normalizeMarks } from './mindmapRichText';
import { cloneMindmapTree, findMindNode, findMindNodeParent, getMindmapTreeStats, getTopLevelMindNodeIds, mapMindmapTree, stringifyMindmapJson } from './mindmapTree';

/** 合法布局枚举（用于反序列化时的防御性校验） */
const VALID_LAYOUTS: MindmapLayout[] = [
  'right',
  'left',
  'balanced',
  'tree',
  'tree-up',
  'indent-right',
  'indent-left',
  'timeline',
  'fishbone',
];

/** 合法连线样式枚举 */
const VALID_EDGE_STYLES: MindmapEdgeStyle[] = ['curve', 'straight', 'elbow'];

export const DEFAULT_MINDMAP_LAYOUT: MindmapLayout = 'right';
export const DEFAULT_MINDMAP_THEME = 'classic';

/** 文档级外观元信息（布局 + 配色主题 + 连线样式） */
export interface MindmapDocumentMeta {
  layout: MindmapLayout;
  theme: string;
  /** 未设置时跟随配色主题 */
  edgeStyle?: MindmapEdgeStyle;
}

let nextNodeId = 1;
export function generateNodeId(): string {
  return `node-${Date.now()}-${nextNodeId++}`;
}

/**
 * 创建默认空白思维导图根节点
 */
export function createDefaultMindmap(title = '中心主题'): MindNode {
  return {
    id: 'root',
    text: title,
    isExpanded: true,
    children: [
      {
        id: generateNodeId(),
        text: '主要分支 1',
        isExpanded: true,
        children: [
          { id: generateNodeId(), text: '子分支 1.1', children: [] },
          { id: generateNodeId(), text: '子分支 1.2', children: [] },
        ],
      },
      {
        id: generateNodeId(),
        text: '主要分支 2',
        isExpanded: true,
        children: [
          { id: generateNodeId(), text: '子分支 2.1', children: [] },
        ],
      },
      {
        id: generateNodeId(),
        text: '主要分支 3',
        isExpanded: true,
        children: [],
      },
    ],
  };
}

/**
 * 解析文档内容为思维导图节点树
 */
export function parseMindmapDocument(content: string): MindNode {
  const trimmed = content.trim();
  if (!trimmed) {
    return createDefaultMindmap();
  }

  // 1. 尝试按 JSON 解析
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      // 若为 NoteBoard Mindmap 格式（标题允许为空字符串）
      if (parsed.root && typeof parsed.root === 'object' && typeof parsed.root.text === 'string') {
        return normalizeNode(parsed.root);
      }
      // 若直接为 MindNode
      if (typeof parsed.text === 'string' && Array.isArray(parsed.children)) {
        return normalizeNode(parsed);
      }
      // 若为 XMind content.json 数组
      if (Array.isArray(parsed) && parsed[0]?.rootTopic) {
        return xmindTopicToMindNode(parsed[0].rootTopic);
      }
    } catch {
      // 忽略，转为 Markdown 解析
    }
  }

  // 2. 尝试按 Markdown 列表与大纲解析
  return markdownToMindNode(trimmed);
}

/**
 * 确保节点属性完整
 */
function normalizeNode(node: Partial<MindNode>): MindNode {
  return mapMindmapTree(node, (source) => Array.isArray(source.children) ? source.children : [], (source) => ({
    id: source.id || generateNodeId(),
    text: source.text || '',
    icon: source.icon,
    note: source.note,
    image: source.image,
    color: source.color,
    // 仅保留合法的手动宽度
    width:
      typeof source.width === 'number' && Number.isFinite(source.width) && source.width > 0
        ? source.width
        : undefined,
    // 富文本标记按文本长度裁剪校验；对齐与图片显示方式只接受合法枚举
    marks: normalizeMarks(source.marks, (source.text || '').length),
    textAlign: source.textAlign === 'left' || source.textAlign === 'center' ? source.textAlign : undefined,
    imageFit: source.imageFit === 'original' || source.imageFit === 'fill' ? source.imageFit : undefined,
    isExpanded: source.isExpanded !== false,
    children: [],
  }));
}

/**
 * 序列化思维导图为 JSON 文本
 * @param meta 文档级外观元信息（布局与配色主题），缺省时回退到默认外观
 */
export function serializeMindmapDocument(
  root: MindNode,
  meta?: { layout?: MindmapLayout; theme?: string; edgeStyle?: MindmapEdgeStyle },
): string {
  const doc: MindmapDocumentData = {
    version: 1,
    root,
    layout: meta?.layout ?? DEFAULT_MINDMAP_LAYOUT,
    theme: meta?.theme ?? DEFAULT_MINDMAP_THEME,
  };
  // 连线样式只在显式选择时写入，缺省跟随主题
  if (meta?.edgeStyle) doc.edgeStyle = meta.edgeStyle;
  // 大图/深图使用用户确认的紧凑格式；显式栈同时避免合法深层树触发原生 stringify 栈溢出。
  const stats = getMindmapTreeStats(root);
  return stats.maxDepth > 100 ? stringifyMindmapJson(doc, false)
    : JSON.stringify(doc, null, stats.nodeCount <= 500 ? 2 : undefined);
}

/**
 * 仅读取文档级外观元信息（布局、配色主题与连线样式），不构建节点树
 * 非 JSON 文档（如 Markdown 大纲）统一返回默认外观
 */
export function parseMindmapDocumentMeta(content: string): MindmapDocumentMeta {
  const meta: MindmapDocumentMeta = {
    layout: DEFAULT_MINDMAP_LAYOUT,
    theme: DEFAULT_MINDMAP_THEME,
  };
  const trimmed = (content || '').trim();
  if (!trimmed.startsWith('{')) return meta;

  try {
    const parsed = JSON.parse(trimmed) as Partial<MindmapDocumentData>;
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.layout === 'string' && VALID_LAYOUTS.includes(parsed.layout as MindmapLayout)) {
        meta.layout = parsed.layout as MindmapLayout;
      }
      if (typeof parsed.theme === 'string' && parsed.theme.trim()) {
        meta.theme = parsed.theme;
      }
      if (
        typeof parsed.edgeStyle === 'string' &&
        VALID_EDGE_STYLES.includes(parsed.edgeStyle as MindmapEdgeStyle)
      ) {
        meta.edgeStyle = parsed.edgeStyle as MindmapEdgeStyle;
      }
    }
  } catch {
    // 非法 JSON 时回退默认外观
  }
  return meta;
}

/**
 * XMind Topic 转换为 NoteBoard MindNode
 */
export function xmindTopicToMindNode(topic: XMindTopic): MindNode {
  // 显式栈保留全部层级，不再因单链主题过深而在转换阶段溢出。
  return mapMindmapTree(topic, (source) => source.children?.attached ?? [], (source) => ({
    id: source.id || generateNodeId(),
    text: typeof source.title === 'string' ? source.title : '分支',
    icon: source.markers?.[0]?.markerId,
    note: source.notes?.plain?.content ?? source.note?.plain?.content,
    image: source.image?.src,
    isExpanded: source.branch !== 'folded',
    children: [],
  }));
}

/**
 * XMind content.json 整体转换为 MindNode
 */
export function xmindJsonToMindNode(sheets: XMindSheet[]): MindNode {
  if (!sheets || sheets.length === 0 || !sheets[0].rootTopic) {
    return createDefaultMindmap();
  }
  return xmindTopicToMindNode(sheets[0].rootTopic);
}

/**
 * NoteBoard MindNode 转换为 XMind Topic
 */
export function mindNodeToXmindTopic(node: MindNode): XMindTopic {
  const create = (source: MindNode): XMindTopic => {
    const topic: XMindTopic = { id: source.id, title: source.text };
    if (source.icon) topic.markers = [{ markerId: source.icon }];
    if (source.image) topic.image = { src: source.image };
    if (source.note) {
      topic.notes = { plain: { content: source.note } };
      // 旧版 NoteBoard 读取 note，官方 XMind 读取 notes，同时写入以保留双方兼容。
      topic.note = { plain: { content: source.note } };
    }
    if (source.isExpanded === false) topic.branch = 'folded';
    return topic;
  };
  const result = create(node);
  const stack = [{ source: node, target: result }];
  while (stack.length > 0) {
    const { source, target } = stack.pop()!;
    if (source.children.length === 0) continue;
    const attached: XMindTopic[] = [];
    target.children = { attached };
    for (const child of source.children) {
      const next = create(child);
      attached.push(next);
      stack.push({ source: child, target: next });
    }
  }
  return result;
}

/**
 * MindNode 转换为 XMind content.json 结构
 */
export function mindNodeToXmindJson(root: MindNode): XMindContentJson {
  const sheet: XMindSheet = {
    id: `sheet-${Date.now()}`,
    title: root.text || '画布 1',
    rootTopic: mindNodeToXmindTopic(root),
  };
  return [sheet];
}

/**
 * 提取文本开头的常用 Emoji 或标记
 */
function extractLeadingIcon(rawText: string): { icon?: string; text: string } {
  // 匹配前置常见 Emoji 符号或数字标记
  const emojiMatch = rawText.match(/^([\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[1-9]️⃣|🔟|⭐️|🚩|💡|🔥|📌|✅|❌|❓|🎯|🚀|📅|⚡️)\s*(.*)$/u);
  if (emojiMatch) {
    return {
      icon: emojiMatch[1],
      text: emojiMatch[2].trim(),
    };
  }
  return { text: rawText };
}

/** 标题中的节点内换行在 Markdown 大纲中写为 <br>，避免打断标题 / 列表结构 */
function toMarkdownTitle(text: string): string {
  return text.replace(/\n/g, '<br>');
}

/** Markdown 标题 / 列表项中的 <br> 还原为节点内换行 */
function fromMarkdownTitle(text: string): string {
  return text.replace(/\s*<br\s*\/?>\s*/gi, '\n');
}

/**
 * Markdown 大纲转换为 MindNode 树
 */
export function markdownToMindNode(md: string): MindNode {
  const lines = md.split('\n');
  const root: MindNode = {
    id: 'root',
    text: '思维导图',
    isExpanded: true,
    children: [],
  };

  interface StackItem {
    level: number;
    node: MindNode;
  }

  const stack: StackItem[] = [{ level: 0, node: root }];
  let hasSetRoot = false;

  for (let line of lines) {
    line = line.replace(/\r$/, '');
    if (!line.trim()) continue;

    // 解析备注引用块 >
    const quoteMatch = line.match(/^(\s*)>\s*(.*)$/);
    if (quoteMatch && stack.length > 0) {
      const quoteContent = quoteMatch[2].trim();
      const targetNode = stack[stack.length - 1].node;

      // 检查是否为 Markdown 图片语法 ![alt](url)
      const imgMatch = quoteContent.match(/^!\[.*?\]\((.*?)\)$/);
      if (imgMatch) {
        targetNode.image = imgMatch[1];
      } else {
        targetNode.note = targetNode.note ? `${targetNode.note}\n${quoteContent}` : quoteContent;
      }
      continue;
    }

    let level = 0;
    let text = '';

    // 匹配 Markdown 标题 #, ##, ###
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      level = headingMatch[1].length;
      text = headingMatch[2].trim();

      const { icon, text: cleanText } = extractLeadingIcon(text);

      if (!hasSetRoot && level === 1) {
        root.text = fromMarkdownTitle(cleanText || text);
        root.icon = icon;
        hasSetRoot = true;
        continue;
      }
      text = cleanText || text;
    } else {
      // 匹配列表项 - , * , 1. , 以及前置空格缩进
      const listMatch = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        const indent = listMatch[1].length;
        level = Math.floor(indent / 2) + 2; // 列表层级
        text = listMatch[2].trim();
      } else {
        // 普通行文本
        const indentMatch = line.match(/^(\s*)(.*)$/);
        if (indentMatch) {
          level = Math.floor(indentMatch[1].length / 2) + 2;
          text = indentMatch[2].trim();
        }
      }
    }

    if (!text) continue;

    const { icon, text: cleanText } = extractLeadingIcon(text);

    const newNode: MindNode = {
      id: generateNodeId(),
      text: fromMarkdownTitle(cleanText || text),
      icon,
      isExpanded: true,
      children: [],
    };

    // 寻找父级
    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;
    parent.children.push(newNode);
    stack.push({ level, node: newNode });
  }

  if (root.children.length === 0 && !hasSetRoot) {
    return createDefaultMindmap();
  }

  return root;
}

/**
 * MindNode 树转换为 Markdown 大纲
 */
export function mindNodeToMarkdown(root: MindNode, depth = 0): string {
  let res = '';
  const iconPrefix = root.icon ? `${root.icon} ` : '';

  if (depth === 0) {
    res += `# ${iconPrefix}${toMarkdownTitle(root.text)}\n\n`;
    if (root.note) {
      const noteLines = root.note.split('\n');
      for (const nl of noteLines) {
        res += `> ${nl}\n`;
      }
      res += '\n';
    }
    if (root.image) {
      res += `> ![图片](${root.image})\n\n`;
    }
    for (const child of root.children) {
      res += mindNodeToMarkdown(child, depth + 1);
    }
  } else {
    const indent = '  '.repeat(depth - 1);
    res += `${indent}- ${iconPrefix}${toMarkdownTitle(root.text)}\n`;
    if (root.note) {
      const noteLines = root.note.split('\n');
      for (const nl of noteLines) {
        res += `${indent}  > ${nl}\n`;
      }
    }
    if (root.image) {
      res += `${indent}  > ![图片](${root.image})\n`;
    }
    for (const child of root.children) {
      res += mindNodeToMarkdown(child, depth + 1);
    }
  }
  return res;
}

/**
 * 动态加载 JSZip 并打包为 .xmind 格式
 */
export async function exportToXmindZip(root: MindNode): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  const contentJson = mindNodeToXmindJson(root);
  // 内嵌图片按标准 XMind 资源路径打包，不能只把 Data URL 留在 image.src 中。
  const topics = [contentJson[0].rootTopic];
  let imageIndex = 0;
  const imagePaths = new Map<string, string>();
  while (topics.length > 0) {
    const topic = topics.pop()!;
    for (const child of topic.children?.attached ?? []) topics.push(child);
    const src = topic.image?.src;
    const embedded = src?.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/);
    if (!src || !embedded) continue;
    let path = imagePaths.get(src);
    if (!path) {
      const extension = embedded[1] === 'image/svg+xml' ? 'svg' : embedded[1].split('/')[1].replace('jpeg', 'jpg');
      path = `resources/image-${++imageIndex}.${extension}`;
      zip.file(path, embedded[2], { base64: true });
      imagePaths.set(src, path);
    }
    topic.image = { ...topic.image, src: `xap:${path}` };
  }
  zip.file('content.json', stringifyMindmapJson(contentJson, false));

  const manifestJson = {
    'file-entries': {
      'content.json': {},
      'metadata.json': {},
    },
  };
  for (const path of imagePaths.values()) (manifestJson['file-entries'] as Record<string, object>)[path] = {};
  zip.file('manifest.json', JSON.stringify(manifestJson, null, 2));

  const metadataJson = {
    creator: { name: 'NoteBoard', version: '0.1.3' },
  };
  zip.file('metadata.json', JSON.stringify(metadataJson, null, 2));

  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.xmind.workbook' });
}

/**
 * 动态加载 JSZip 并从 .xmind 压缩包解析出 MindNode 根节点
 */
export async function importFromXmindZip(buffer: ArrayBuffer, sheetId?: string): Promise<MindNode> {
  const { inspectXmindArchive, readXmindSheets, prepareXmindSheet, resolveXmindImages } = await import('./xmindImport');
  const archive = await inspectXmindArchive(buffer);
  const sheets = await readXmindSheets(archive);
  // 纯转换入口不能静默选第一张多画布内容；交互入口负责展示选择列表后传入确定的画布。
  if (sheets.length > 1 && sheetId === undefined) throw new Error('XMind 包含多个画布，请先选择要导入的画布');
  const sheet = sheets.find((entry) => entry.id === (sheetId ?? sheets[0].id));
  if (!sheet) throw new Error('所选 XMind 画布不存在');
  return resolveXmindImages(archive, prepareXmindSheet(archive, sheet).root);
}

/**
 * 检查 targetId 是否是 sourceId 本身或其子孙节点（防止循环挂载）
 */
export function isMindNodeDescendant(root: MindNode, sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return true;
  const sourceNode = findMindNode(root, sourceId);
  return sourceNode !== null && findMindNode(sourceNode, targetId) !== null;
}

/**
 * 纯函数：批量移动多个节点（各自整树搬移），返回新的树对象
 * 只搬顶层节点（祖先也在其中的忽略），保持原文档顺序整体插入到目标处；
 * 目标落在任一源子树内（含源节点本身）时原样返回。
 */
export function moveMindNodes(
  root: MindNode,
  sourceIds: Iterable<string>,
  targetId: string,
  position: 'before' | 'inside' | 'after' = 'after',
): MindNode {
  const ids = getTopLevelMindNodeIds(root, sourceIds);
  if (ids.length === 0 || ids.some((id) => isMindNodeDescendant(root, id, targetId))) {
    return root;
  }

  const cloned = cloneMindmapTree(root);
  // 1. 按文档顺序抽离全部源节点（顶层节点之间互不包含，抽离互不影响）
  const extracted: MindNode[] = [];
  for (const id of ids) {
    const parentInfo = findMindNodeParent(cloned, id);
    if (!parentInfo) return root;
    extracted.push(...parentInfo.parent.children.splice(parentInfo.index, 1));
  }

  // 2. 挂为目标的子节点（根节点只能挂入）
  if (targetId === cloned.id || position === 'inside') {
    const target = findMindNode(cloned, targetId);
    if (!target) return root;
    target.children.push(...extracted);
    target.isExpanded = true;
    return cloned;
  }

  // 3. 作为兄弟节点整体插入到目标前 / 后
  const targetParent = findMindNodeParent(cloned, targetId);
  if (!targetParent) return root;
  const insertIndex = position === 'before' ? targetParent.index : targetParent.index + 1;
  targetParent.parent.children.splice(insertIndex, 0, ...extracted);
  return cloned;
}

/**
 * 纯函数：在思维导图节点树中移动节点（整树搬移），返回新的树对象
 */
export function moveMindNode(
  root: MindNode,
  sourceId: string,
  targetId: string,
  position: 'before' | 'inside' | 'after' = 'after',
): MindNode {
  if (sourceId === targetId || isMindNodeDescendant(root, sourceId, targetId)) {
    return root;
  }

  const cloned = cloneMindmapTree(root);

  // 1. 查找并抽离 source 节点
  const sourceParent = findMindNodeParent(cloned, sourceId);
  if (!sourceParent) return root;
  const [extracted] = sourceParent.parent.children.splice(sourceParent.index, 1);

  // 2. 如果目标是根节点或者 position === 'inside'
  if (targetId === cloned.id || position === 'inside') {
    const target = findMindNode(cloned, targetId);
    if (!target) return root;
    target.children.push(extracted);
    target.isExpanded = true;
    return cloned;
  }

  // 3. 作为兄弟节点插入 (before / after)
  const targetParent = findMindNodeParent(cloned, targetId);
  if (targetParent) {
    const insertIndex = position === 'before' ? targetParent.index : targetParent.index + 1;
    targetParent.parent.children.splice(insertIndex, 0, extracted);
  } else {
    // 兜底：若未找到兄弟，追加到根节点
    if (!cloned.children) cloned.children = [];
    cloned.children.push(extracted);
  }

  return cloned;
}

