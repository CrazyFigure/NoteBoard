// NoteBoard 思维导图布局引擎 / 展示主题测试
// 覆盖四种布局的坐标约束、连线路径生成，以及文档外观元信息读写
// 详见 docs/09-开发路线图.md

import { describe, test, expect } from 'vitest';
import {
  computeMindmapLayout,
  buildLinkPath,
  type LayoutNode,
} from '@/features/mindmap/mindmapLayout';
import {
  MINDMAP_THEMES,
  MINDMAP_LAYOUTS,
  getMindmapTheme,
  getMindmapLayoutMeta,
} from '@/features/mindmap/mindmapTheme';
import {
  createDefaultMindmap,
  serializeMindmapDocument,
  parseMindmapDocumentMeta,
} from '@/features/mindmap/mindmapConverter';
import type { MindNode, MindmapLayout } from '@/features/mindmap/mindmapTypes';

const ALL_LAYOUTS: MindmapLayout[] = ['right', 'left', 'balanced', 'tree'];

function countNodes(node: MindNode): number {
  return 1 + (node.children || []).reduce((sum, c) => sum + countNodes(c), 0);
}

function rootOf(nodes: LayoutNode[]): LayoutNode {
  const root = nodes.find((n) => n.level === 0);
  if (!root) throw new Error('未找到根节点布局');
  return root;
}

/** 取所有一级分支（根节点的直接子节点）布局 */
function level1Of(nodes: LayoutNode[]): LayoutNode[] {
  const rootId = rootOf(nodes).node.id;
  return nodes.filter((n) => n.level === 1 && n.node.id !== rootId);
}

describe('mindmapLayout 布局引擎测试', () => {
  const tree = createDefaultMindmap('根主题');

  test('四种布局都产出完整且坐标有限的节点与连线', () => {
    const total = countNodes(tree);
    for (const layout of ALL_LAYOUTS) {
      const { nodes, links } = computeMindmapLayout(tree, layout, 6);
      expect(nodes.length).toBe(total);
      expect(links.length).toBe(total - 1);

      for (const n of nodes) {
        expect(Number.isFinite(n.x)).toBe(true);
        expect(Number.isFinite(n.y)).toBe(true);
        // 归一化后不应出现负坐标
        expect(n.x).toBeGreaterThanOrEqual(0);
        expect(n.y).toBeGreaterThanOrEqual(0);
        expect(n.width).toBeGreaterThan(0);
        expect(n.height).toBeGreaterThan(0);
      }
    }
  });

  test('向右 / 向左 / 双向布局的一级分支不重叠且方向正确', () => {
    for (const layout of ['right', 'left', 'balanced'] as MindmapLayout[]) {
      const { nodes } = computeMindmapLayout(tree, layout, 6);
      const root = rootOf(nodes);
      const level1 = level1Of(nodes);
      expect(level1.length).toBe(tree.children.length);

      // 同级分支纵向（堆叠轴）不重叠：双向布局需按左右两侧分别校验
      const assertNoVerticalOverlap = (list: LayoutNode[]) => {
        const sorted = [...list].sort((a, b) => a.y - b.y);
        for (let i = 1; i < sorted.length; i += 1) {
          expect(sorted[i - 1].y + sorted[i - 1].height).toBeLessThanOrEqual(sorted[i].y);
        }
      };
      const rootCenterX = root.x + root.width / 2;
      if (layout === 'balanced') {
        assertNoVerticalOverlap(level1.filter((n) => n.x + n.width / 2 > rootCenterX));
        assertNoVerticalOverlap(level1.filter((n) => n.x + n.width / 2 < rootCenterX));
      } else {
        assertNoVerticalOverlap(level1);
      }

      if (layout === 'right') {
        for (const n of level1) expect(n.x).toBeGreaterThanOrEqual(root.x + root.width);
      } else if (layout === 'left') {
        for (const n of level1) expect(n.x + n.width).toBeLessThanOrEqual(root.x);
      } else {
        // 双向平衡：以根节点中心为界，左右两侧均有分支
        const rightCount = level1.filter((n) => n.x + n.width / 2 > rootCenterX).length;
        const leftCount = level1.filter((n) => n.x + n.width / 2 < rootCenterX).length;
        expect(rightCount).toBeGreaterThan(0);
        expect(leftCount).toBeGreaterThan(0);
        expect(rightCount + leftCount).toBe(level1.length);
      }
    }
  });

  test('向下组织图父子纵向分层且同级横向不重叠', () => {
    const { nodes } = computeMindmapLayout(tree, 'tree', 6);
    const root = rootOf(nodes);
    const level1 = level1Of(nodes);

    for (const n of level1) {
      expect(n.y).toBeGreaterThanOrEqual(root.y + root.height);
    }

    const sorted = [...level1].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i - 1].x + sorted[i - 1].width).toBeLessThanOrEqual(sorted[i].x);
    }
  });

  test('连线路径随布局与样式切换而生成合法 path', () => {
    for (const layout of ALL_LAYOUTS) {
      const { nodes, links } = computeMindmapLayout(tree, layout, 6);
      const nodeById = new Map(nodes.map((n) => [n.node.id, n]));
      for (const link of links.slice(0, 5)) {
        const from = nodeById.get(link.from.node.id)!;
        const to = nodeById.get(link.to.node.id)!;
        expect(buildLinkPath(from, to, layout, 'curve')).toMatch(/^M /);
        expect(buildLinkPath(from, to, layout, 'straight')).toMatch(/^M /);
      }
    }
  });
});

describe('mindmapTheme 展示主题测试', () => {
  test('主题与布局元信息完整且未命中时安全回退', () => {
    expect(MINDMAP_THEMES.length).toBeGreaterThanOrEqual(3);
    for (const theme of MINDMAP_THEMES) {
      expect(theme.branchColors.length).toBeGreaterThanOrEqual(3);
      expect(theme.rootText.length).toBeGreaterThan(0);
    }

    expect(MINDMAP_LAYOUTS.map((l) => l.id)).toEqual(['right', 'left', 'balanced', 'tree']);
    expect(getMindmapTheme('不存在的主题').id).toBe(MINDMAP_THEMES[0].id);
    expect(getMindmapLayoutMeta('tree').id).toBe('tree');
  });
});

describe('思维导图外观元信息读写', () => {
  const tree = createDefaultMindmap('外观元信息');

  test('序列化携带布局与配色，反序列化可完整读回', () => {
    const json = serializeMindmapDocument(tree, { layout: 'tree', theme: 'ocean' });
    expect(parseMindmapDocumentMeta(json)).toEqual({ layout: 'tree', theme: 'ocean' });
  });

  test('缺省外观与 Markdown 文档回退到默认值', () => {
    expect(parseMindmapDocumentMeta(serializeMindmapDocument(tree))).toEqual({
      layout: 'right',
      theme: 'classic',
    });
    expect(parseMindmapDocumentMeta('# 纯 Markdown 大纲')).toEqual({
      layout: 'right',
      theme: 'classic',
    });
    expect(parseMindmapDocumentMeta('')).toEqual({ layout: 'right', theme: 'classic' });
  });

  test('非法布局取值被忽略并回退默认', () => {
    const json = JSON.stringify({ version: 1, root: tree, layout: 'diagonal', theme: 'ocean' });
    expect(parseMindmapDocumentMeta(json)).toEqual({ layout: 'right', theme: 'ocean' });
  });
});
