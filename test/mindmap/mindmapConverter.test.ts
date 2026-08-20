// NoteBoard 思维导图 / XMind / Markdown 双向转换器测试
// 详见 docs/08-数据契约与持久化.md 与 docs/09-开发路线图.md

import { describe, test, expect } from 'vitest';
import {
  parseMindmapDocument,
  serializeMindmapDocument,
  mindNodeToMarkdown,
  markdownToMindNode,
  mindNodeToXmindJson,
  xmindJsonToMindNode,
  createDefaultMindmap,
  exportToXmindZip,
  importFromXmindZip,
} from '@/features/mindmap/mindmapConverter';
import type { MindNode } from '@/features/mindmap/mindmapTypes';

describe('mindmapConverter 转换器测试', () => {
  const sampleTree: MindNode = {
    id: 'root-1',
    text: 'NoteBoard 规划',
    isExpanded: true,
    children: [
      {
        id: 'c-1',
        text: '图表与格式',
        isExpanded: true,
        children: [
          { id: 'c-1-1', text: 'Mermaid', isExpanded: true, children: [] },
          { id: 'c-1-2', text: 'PlantUML', isExpanded: true, children: [] },
          { id: 'c-1-3', text: 'Draw.io', isExpanded: true, children: [] },
        ],
      },
      {
        id: 'c-2',
        text: '思维导图双模',
        isExpanded: true,
        children: [
          { id: 'c-2-1', text: '大纲编辑模式', isExpanded: true, children: [] },
          { id: 'c-2-2', text: '导图展示模式', isExpanded: true, children: [] },
        ],
      },
    ],
  };

  test('默认思维导图生成', () => {
    const defaultMap = createDefaultMindmap('我的笔记');
    expect(defaultMap.text).toBe('我的笔记');
    expect(defaultMap.children.length).toBeGreaterThan(0);
  });

  test('JSON 序列化与反序列化保真', () => {
    const jsonStr = serializeMindmapDocument(sampleTree);
    const parsed = parseMindmapDocument(jsonStr);
    expect(parsed.text).toBe('NoteBoard 规划');
    expect(parsed.children.length).toBe(2);
    expect(parsed.children[0].children[0].text).toBe('Mermaid');
  });

  test('Markdown 大纲与思维导图双向转换', () => {
    const md = mindNodeToMarkdown(sampleTree);
    expect(md).toContain('# NoteBoard 规划');
    expect(md).toContain('- 图表与格式');
    expect(md).toContain('  - Mermaid');

    const treeFromMd = markdownToMindNode(md);
    expect(treeFromMd.text).toBe('NoteBoard 规划');
    expect(treeFromMd.children.length).toBe(2);
    expect(treeFromMd.children[0].text).toBe('图表与格式');
    expect(treeFromMd.children[0].children.length).toBe(3);
    expect(treeFromMd.children[0].children[0].text).toBe('Mermaid');
  });

  test('XMind content.json 格式转换双向兼容', () => {
    const xmindJson = mindNodeToXmindJson(sampleTree);
    expect(Array.isArray(xmindJson)).toBe(true);
    expect(xmindJson[0].rootTopic.title).toBe('NoteBoard 规划');
    expect(xmindJson[0].rootTopic.children?.attached?.length).toBe(2);

    const convertedBack = xmindJsonToMindNode(xmindJson);
    expect(convertedBack.text).toBe('NoteBoard 规划');
    expect(convertedBack.children.length).toBe(2);
    expect(convertedBack.children[0].children[1].text).toBe('PlantUML');
  });

  test('XMind Zip 打包与解包导入', async () => {
    const blob = await exportToXmindZip(sampleTree);
    expect(blob.size).toBeGreaterThan(0);

    const arrayBuffer = await blob.arrayBuffer();
    const importedTree = await importFromXmindZip(arrayBuffer);
    expect(importedTree.text).toBe('NoteBoard 规划');
    expect(importedTree.children.length).toBe(2);
    expect(importedTree.children[0].children[2].text).toBe('Draw.io');
  });
});
