// NoteBoard 思维导图转换器
// 支持 NoteBoard 节点树 ⇄ XMind 格式 ⇄ Markdown 大纲双向转换
// 支持动态 import('jszip') 导入/导出 .xmind 压缩包
// 详见 docs/09-开发路线图.md

import type { MindNode, MindmapDocumentData, XMindContentJson, XMindTopic, XMindSheet } from './mindmapTypes';

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
      // 若为 NoteBoard Mindmap 格式
      if (parsed.root && parsed.root.text) {
        return normalizeNode(parsed.root);
      }
      // 若直接为 MindNode
      if (parsed.text && Array.isArray(parsed.children)) {
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
  return {
    id: node.id || generateNodeId(),
    text: node.text || '',
    icon: node.icon,
    note: node.note,
    image: node.image,
    color: node.color,
    isExpanded: node.isExpanded !== false,
    children: Array.isArray(node.children) ? node.children.map(normalizeNode) : [],
  };
}

/**
 * 序列化思维导图为 JSON 文本
 */
export function serializeMindmapDocument(root: MindNode): string {
  const doc: MindmapDocumentData = {
    version: 1,
    root,
    layout: 'right',
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * XMind Topic 转换为 NoteBoard MindNode
 */
export function xmindTopicToMindNode(topic: XMindTopic): MindNode {
  const children: MindNode[] = [];
  if (topic.children?.attached && Array.isArray(topic.children.attached)) {
    for (const child of topic.children.attached) {
      children.push(xmindTopicToMindNode(child));
    }
  }

  // 提取 XMind 标记作为图标
  const icon = topic.markers && topic.markers.length > 0 ? topic.markers[0].markerId : undefined;

  return {
    id: topic.id || generateNodeId(),
    text: topic.title || '分支',
    icon,
    note: topic.note?.plain?.content,
    image: topic.image?.src,
    isExpanded: true,
    children,
  };
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
  const attached: XMindTopic[] = node.children.map(mindNodeToXmindTopic);
  const topic: XMindTopic = {
    id: node.id,
    title: node.text,
  };

  if (node.icon) {
    topic.markers = [{ markerId: node.icon }];
  }

  if (node.image) {
    topic.image = { src: node.image };
  }

  if (node.note) {
    topic.note = { plain: { content: node.note } };
  }

  if (attached.length > 0) {
    topic.children = { attached };
  }

  return topic;
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
        root.text = cleanText || text;
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
      text: cleanText || text,
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
    res += `# ${iconPrefix}${root.text}\n\n`;
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
    res += `${indent}- ${iconPrefix}${root.text}\n`;
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
  zip.file('content.json', JSON.stringify(contentJson, null, 2));

  const manifestJson = {
    'file-entries': {
      'content.json': {},
      'metadata.json': {},
    },
  };
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
export async function importFromXmindZip(buffer: ArrayBuffer): Promise<MindNode> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);

  // 1. 优先读取 content.json (XMind Zen / 2020+)
  const contentFile = zip.file('content.json');
  if (contentFile) {
    const contentText = await contentFile.async('text');
    const json = JSON.parse(contentText) as XMindContentJson;
    if (Array.isArray(json) && json[0]?.rootTopic) {
      return xmindTopicToMindNode(json[0].rootTopic);
    }
  }

  // 2. 兼容读取 content.xml (经典版 XMind)
  const xmlFile = zip.file('content.xml');
  if (xmlFile) {
    const xmlText = await xmlFile.async('text');
    // 简易从 xml 提取 title 节点
    const titleMatch = xmlText.match(/<title[^>]*>(.*?)<\/title>/);
    const rootText = titleMatch ? titleMatch[1] : '导入的 XMind';
    return {
      id: generateNodeId(),
      text: rootText,
      isExpanded: true,
      children: [],
    };
  }

  throw new Error('未在 .xmind 文件中找到有效的思维导图内容');
}

/**
 * 检查 targetId 是否是 sourceId 本身或其子孙节点（防止循环挂载）
 */
export function isMindNodeDescendant(root: MindNode, sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return true;
  function searchNode(n: MindNode): MindNode | null {
    if (n.id === sourceId) return n;
    for (const child of n.children || []) {
      const found = searchNode(child);
      if (found) return found;
    }
    return null;
  }
  const sourceNode = searchNode(root);
  if (!sourceNode) return false;

  function hasTarget(n: MindNode): boolean {
    if (n.id === targetId) return true;
    for (const child of n.children || []) {
      if (hasTarget(child)) return true;
    }
    return false;
  }
  return hasTarget(sourceNode);
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

  const cloned: MindNode = JSON.parse(JSON.stringify(root));

  // 1. 查找并抽离 source 节点
  let extracted: MindNode | null = null;
  function removeSource(n: MindNode): boolean {
    if (n.children && n.children.length > 0) {
      const idx = n.children.findIndex((c) => c.id === sourceId);
      if (idx !== -1) {
        [extracted] = n.children.splice(idx, 1);
        return true;
      }
      for (const child of n.children) {
        if (removeSource(child)) return true;
      }
    }
    return false;
  }

  removeSource(cloned);
  if (!extracted) return root;

  // 2. 如果目标是根节点或者 position === 'inside'
  if (targetId === cloned.id || position === 'inside') {
    function insertInside(n: MindNode): boolean {
      if (n.id === targetId) {
        if (!n.children) n.children = [];
        n.children.push(extracted!);
        n.isExpanded = true;
        return true;
      }
      for (const child of n.children || []) {
        if (insertInside(child)) return true;
      }
      return false;
    }
    insertInside(cloned);
    return cloned;
  }

  // 3. 作为兄弟节点插入 (before / after)
  function insertSibling(n: MindNode): boolean {
    if (n.children && n.children.length > 0) {
      const idx = n.children.findIndex((c) => c.id === targetId);
      if (idx !== -1) {
        const insertIdx = position === 'before' ? idx : idx + 1;
        n.children.splice(insertIdx, 0, extracted!);
        return true;
      }
      for (const child of n.children) {
        if (insertSibling(child)) return true;
      }
    }
    return false;
  }

  const inserted = insertSibling(cloned);
  if (!inserted) {
    // 兜底：若未找到兄弟，追加到根节点
    if (!cloned.children) cloned.children = [];
    cloned.children.push(extracted);
  }

  return cloned;
}

