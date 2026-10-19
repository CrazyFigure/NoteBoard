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

const ALL_LAYOUTS: MindmapLayout[] = [
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

  test('所有布局都产出完整且坐标有限的节点与连线', () => {
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
        expect(buildLinkPath(from, to, layout, 'elbow')).toMatch(/^M /);
      }
      // 布局引擎直接给出的路径同样合法
      for (const edgeStyle of ['curve', 'straight', 'elbow'] as const) {
        const result = computeMindmapLayout(tree, layout, 6, { edgeStyle });
        for (const link of result.links) expect(link.path).toMatch(/^M -?\d/);
      }
    }
  });
});

/** 构造带一级 / 二级分支的测试树 */
function makeTree(): MindNode {
  return {
    id: 'root',
    text: '中心主题',
    children: [
      {
        id: 'a',
        text: '分支 A',
        children: [
          { id: 'a1', text: 'A-1', children: [{ id: 'a1x', text: 'A-1-x', children: [] }] },
          { id: 'a2', text: 'A-2', children: [] },
        ],
      },
      { id: 'b', text: '分支 B', children: [{ id: 'b1', text: 'B-1', children: [] }] },
      { id: 'c', text: '分支 C', children: [{ id: 'c1', text: 'C-1', children: [] }] },
    ],
  };
}

/** 任意两个节点矩形不相交 */
function assertNoOverlap(nodes: LayoutNode[]) {
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const overlap =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlap, `${a.node.id} 与 ${b.node.id} 重叠`).toBe(false);
    }
  }
}

function byId(nodes: LayoutNode[], id: string): LayoutNode {
  const found = nodes.find((n) => n.node.id === id);
  if (!found) throw new Error(`未找到节点 ${id}`);
  return found;
}

describe('节点自动换行与宽度', () => {
  const longText = '你好'.repeat(30);
  const tree: MindNode = {
    id: 'root',
    text: '根',
    children: [
      { id: 'long', text: longText, children: [] },
      { id: 'short', text: '短', children: [] },
    ],
  };

  test('长标题按设置宽度封顶并换行，高度随行数增长', () => {
    const { nodes } = computeMindmapLayout(tree, 'right', 6, { maxNodeWidth: 240 });
    const long = byId(nodes, 'long');
    const short = byId(nodes, 'short');
    expect(long.width).toBe(240);
    expect(long.titleLines.length).toBeGreaterThan(1);
    expect(long.titleLines.map((l) => l.text).join('')).toBe(longText);
    expect(long.height).toBeGreaterThan(short.height);
    // 短标题不会被撑到最大宽度
    expect(short.width).toBeLessThan(240);
    expect(short.titleLines).toHaveLength(1);
  });

  test('修改宽度设置后未手动拉伸的节点跟随变化', () => {
    const narrow = byId(computeMindmapLayout(tree, 'right', 6, { maxNodeWidth: 200 }).nodes, 'long');
    const wide = byId(computeMindmapLayout(tree, 'right', 6, { maxNodeWidth: 500 }).nodes, 'long');
    expect(narrow.width).toBe(200);
    expect(wide.width).toBe(500);
    expect(wide.titleLines.length).toBeLessThan(narrow.titleLines.length);
  });

  test('手动宽度优先于设置，且临时覆盖可用于拖拽预览', () => {
    const custom: MindNode = { ...tree, children: [{ ...tree.children[0], width: 400 }, tree.children[1]] };
    const fixed = byId(computeMindmapLayout(custom, 'right', 6, { maxNodeWidth: 200 }).nodes, 'long');
    expect(fixed.width).toBe(400);
    const preview = byId(
      computeMindmapLayout(custom, 'right', 6, {
        maxNodeWidth: 200,
        widthOverrides: new Map([['long', 300]]),
      }).nodes,
      'long',
    );
    expect(preview.width).toBe(300);
  });

  test('编辑草稿通过文本覆盖实时参与排版', () => {
    const { nodes } = computeMindmapLayout(tree, 'right', 6, {
      maxNodeWidth: 240,
      textOverrides: new Map([['short', { text: longText }]]),
    });
    expect(byId(nodes, 'short').titleLines.length).toBeGreaterThan(1);
  });

  test('空标题节点保持最小尺寸且不显示占位文字', () => {
    const empty: MindNode = { id: 'root', text: '', children: [{ id: 'e', text: '', children: [] }] };
    const { nodes } = computeMindmapLayout(empty, 'right', 6);
    const e = byId(nodes, 'e');
    expect(e.titleLines).toEqual([{ text: '', start: 0 }]);
    expect(e.width).toBeGreaterThan(0);
    expect(e.height).toBe(36);
  });

  test('超长备注最多保留 8 行并在末行加省略号', () => {
    const noted: MindNode = {
      id: 'root',
      text: '根',
      children: [{ id: 'n', text: '备注节点', note: Array.from({ length: 12 }, (_, i) => `第${i}行`).join('\n'), children: [] }],
    };
    const n = byId(computeMindmapLayout(noted, 'right', 6).nodes, 'n');
    expect(n.noteLines).toHaveLength(8);
    expect(n.noteLines[7].endsWith('…')).toBe(true);
  });
});

describe('对齐、图片显示与富文本排版', () => {
  const img = 'data:image/png;base64,TEST';
  const tree: MindNode = {
    id: 'root',
    text: '根',
    children: [
      { id: 'plain', text: '普通节点', children: [] },
      { id: 'pic', text: '带图', image: img, children: [] },
    ],
  };
  const sizeOf = () => ({ width: 800, height: 400 });

  test('对齐默认左对齐，节点设置优先于全局设置', () => {
    expect(byId(computeMindmapLayout(tree, 'right', 6).nodes, 'plain').textAlign).toBe('left');
    expect(
      byId(computeMindmapLayout(tree, 'right', 6, { defaultTextAlign: 'center' }).nodes, 'plain').textAlign,
    ).toBe('center');
    const custom: MindNode = { ...tree, children: [{ ...tree.children[0], textAlign: 'left' }, tree.children[1]] };
    expect(
      byId(computeMindmapLayout(custom, 'right', 6, { defaultTextAlign: 'center' }).nodes, 'plain').textAlign,
    ).toBe('left');
  });

  test('原始比例：按图片宽高比计算高度，节点撑到最大宽度', () => {
    const pic = byId(
      computeMindmapLayout(tree, 'right', 6, { maxNodeWidth: 300, imageSize: sizeOf }).nodes,
      'pic',
    );
    expect(pic.width).toBe(300);
    expect(pic.imageBox?.fit).toBe('original');
    expect(pic.imageBox!.height).toBe(Math.round((pic.imageBox!.width * 400) / 800));
    expect(pic.height).toBeGreaterThan(36 + pic.imageBox!.height);
  });

  test('宽度填充或尺寸未知时使用固定高度缩略图', () => {
    const fill = byId(
      computeMindmapLayout(tree, 'right', 6, { defaultImageFit: 'fill', imageSize: sizeOf }).nodes,
      'pic',
    );
    expect(fill.imageBox).toMatchObject({ fit: 'fill', height: 54 });
    const unknown = byId(computeMindmapLayout(tree, 'right', 6).nodes, 'pic');
    expect(unknown.imageBox?.fit).toBe('fill');
    // 节点单独设置宽度填充优先于全局原始比例
    const custom: MindNode = { ...tree, children: [tree.children[0], { ...tree.children[1], imageFit: 'fill' }] };
    expect(byId(computeMindmapLayout(custom, 'right', 6, { imageSize: sizeOf }).nodes, 'pic').imageBox?.fit).toBe('fill');
  });

  test('原始比例下小图不放大', () => {
    const small = byId(
      computeMindmapLayout(tree, 'right', 6, { imageSize: () => ({ width: 40, height: 20 }) }).nodes,
      'pic',
    );
    expect(small.imageBox).toMatchObject({ fit: 'original', width: 40, height: 20 });
  });

  test('加粗文字测量更宽，节点随之变宽', () => {
    // 估算测量不区分字重，这里用按字重放大的测量函数验证富文本字体参与排版
    const measure = (text: string, font: string) => text.length * (/^(italic )?700 /.test(font) ? 14 : 10);
    const plain: MindNode = { id: 'root', text: '根', children: [{ id: 'a', text: 'abcdefgh', children: [] }] };
    const bold: MindNode = {
      id: 'root',
      text: '根',
      children: [{ id: 'a', text: 'abcdefgh', marks: [{ start: 0, end: 8, bold: true }], children: [] }],
    };
    const w1 = byId(computeMindmapLayout(plain, 'right', 6, { measure }).nodes, 'a').width;
    const w2 = byId(computeMindmapLayout(bold, 'right', 6, { measure }).nodes, 'a').width;
    expect(w2).toBeGreaterThan(w1);
    expect(byId(computeMindmapLayout(bold, 'right', 6, { measure }).nodes, 'a').marks).toEqual([
      { start: 0, end: 8, bold: true },
    ]);
  });
});

describe('新增布局的几何约束', () => {
  const tree = makeTree();

  test('各布局节点两两不重叠', () => {
    for (const layout of ALL_LAYOUTS) {
      assertNoOverlap(computeMindmapLayout(tree, layout, 6).nodes);
    }
  });

  test('向上组织图：根节点在最下方，子节点在父节点上方', () => {
    const { nodes } = computeMindmapLayout(tree, 'tree-up', 6);
    const root = rootOf(nodes);
    for (const n of nodes) {
      if (n !== root) expect(n.y + n.height).toBeLessThanOrEqual(root.y);
    }
    const a = byId(nodes, 'a');
    expect(byId(nodes, 'a1').y + byId(nodes, 'a1').height).toBeLessThanOrEqual(a.y);
  });

  test('右侧 / 左侧树状图：子节点位于父节点下方并向对应方向缩进', () => {
    const right = computeMindmapLayout(tree, 'indent-right', 6).nodes;
    const ra = byId(right, 'a');
    const ra1 = byId(right, 'a1');
    expect(ra1.y).toBeGreaterThanOrEqual(ra.y + ra.height);
    expect(ra1.x).toBeGreaterThan(ra.x);

    const left = computeMindmapLayout(tree, 'indent-left', 6).nodes;
    const la = byId(left, 'a');
    const la1 = byId(left, 'a1');
    expect(la1.y).toBeGreaterThanOrEqual(la.y + la.height);
    expect(la1.x + la1.width).toBeLessThan(la.x + la.width);
  });

  test('时间轴：一级节点中心在同一水平线上，子树上下交替', () => {
    const { nodes, decorations } = computeMindmapLayout(tree, 'timeline', 6);
    const root = rootOf(nodes);
    const axisY = root.y + root.height / 2;
    const level1 = level1Of(nodes).sort((p, q) => p.x - q.x);
    for (const n of level1) expect(n.y + n.height / 2).toBeCloseTo(axisY);
    // 一级节点从左到右依次排开
    for (let i = 1; i < level1.length; i += 1) {
      expect(level1[i].x).toBeGreaterThanOrEqual(level1[i - 1].x + level1[i - 1].width);
    }
    expect(byId(nodes, 'a1').y + byId(nodes, 'a1').height).toBeLessThanOrEqual(byId(nodes, 'a').y);
    expect(byId(nodes, 'b1').y).toBeGreaterThanOrEqual(byId(nodes, 'b').y + byId(nodes, 'b').height);
    expect(decorations.length).toBeGreaterThan(0);
  });

  test('鱼骨图：鱼头在最右，一级分支在脊柱上下交替', () => {
    const { nodes, decorations } = computeMindmapLayout(tree, 'fishbone', 6);
    const root = rootOf(nodes);
    const spineY = root.y + root.height / 2;
    for (const n of nodes) {
      if (n !== root) expect(n.x + n.width).toBeLessThanOrEqual(root.x);
    }
    expect(byId(nodes, 'a').y + byId(nodes, 'a').height).toBeLessThan(spineY);
    expect(byId(nodes, 'b').y).toBeGreaterThan(spineY);
    expect(byId(nodes, 'c').y + byId(nodes, 'c').height).toBeLessThan(spineY);
    expect(decorations).toHaveLength(1);
  });

  test('同级排列走向随布局变化（供拖放判定前后位置）', () => {
    expect(byId(computeMindmapLayout(tree, 'right', 6).nodes, 'a').siblingFlow).toBe('down');
    expect(byId(computeMindmapLayout(tree, 'tree', 6).nodes, 'a').siblingFlow).toBe('right');
    expect(byId(computeMindmapLayout(tree, 'timeline', 6).nodes, 'a').siblingFlow).toBe('right');
    expect(byId(computeMindmapLayout(tree, 'fishbone', 6).nodes, 'a').siblingFlow).toBe('left');
    // 向左逻辑图的拉伸手柄在左侧
    expect(byId(computeMindmapLayout(tree, 'left', 6).nodes, 'a').freeEdge).toBe('left');
  });
});

describe('mindmapTheme 展示主题测试', () => {
  test('主题与布局元信息完整且未命中时安全回退', () => {
    expect(MINDMAP_THEMES.length).toBeGreaterThanOrEqual(3);
    for (const theme of MINDMAP_THEMES) {
      expect(theme.branchColors.length).toBeGreaterThanOrEqual(3);
      expect(theme.rootText.length).toBeGreaterThan(0);
    }

    expect(MINDMAP_LAYOUTS.map((l) => l.id)).toEqual(ALL_LAYOUTS);
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

  test('连线样式只在显式设置时写入并可读回', () => {
    const json = serializeMindmapDocument(tree, { layout: 'fishbone', theme: 'ocean', edgeStyle: 'elbow' });
    expect(parseMindmapDocumentMeta(json)).toEqual({ layout: 'fishbone', theme: 'ocean', edgeStyle: 'elbow' });
    expect(JSON.parse(serializeMindmapDocument(tree, { layout: 'right' }))).not.toHaveProperty('edgeStyle');
    const invalid = JSON.stringify({ version: 1, root: tree, edgeStyle: 'zigzag' });
    expect(parseMindmapDocumentMeta(invalid).edgeStyle).toBeUndefined();
  });

  test('非法布局取值被忽略并回退默认', () => {
    const json = JSON.stringify({ version: 1, root: tree, layout: 'diagonal', theme: 'ocean' });
    expect(parseMindmapDocumentMeta(json)).toEqual({ layout: 'right', theme: 'ocean' });
  });
});
