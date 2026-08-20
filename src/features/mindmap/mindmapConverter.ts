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
    note: node.note,
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

  return {
    id: topic.id || generateNodeId(),
    text: topic.title || '分支',
    note: topic.note?.plain?.content,
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

    let level = 0;
    let text = '';

    // 匹配 Markdown 标题 #, ##, ###
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      level = headingMatch[1].length;
      text = headingMatch[2].trim();

      if (!hasSetRoot && level === 1) {
        root.text = text;
        hasSetRoot = true;
        continue;
      }
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

    const newNode: MindNode = {
      id: generateNodeId(),
      text,
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
  if (depth === 0) {
    res += `# ${root.text}\n\n`;
    for (const child of root.children) {
      res += mindNodeToMarkdown(child, depth + 1);
    }
  } else {
    const indent = '  '.repeat(depth - 1);
    res += `${indent}- ${root.text}\n`;
    if (root.note) {
      res += `${indent}  > ${root.note}\n`;
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
