// NoteBoard 思维导图结构元素测试
// 覆盖概要 / 外框 / 联系线的数据范围解析、失效清理、几何跟随节点，以及 XMind 双向转换
// 详见 docs/09-开发路线图.md

import { describe, expect, test } from 'vitest';
import JSZip from 'jszip';
import type { MindNode, MindmapLayout } from '@/features/mindmap/mindmapTypes';
import {
  computeMindmapStructures,
  dragRangeEnd,
  rangeFixedEndId,
  getSiblingRangeForSelection,
  pruneMindmapStructures,
  removeStructure,
  resolveRangeIndexes,
  resolveRangeNodes,
  setStructureText,
} from '@/features/mindmap/mindmapStructures';
import { computeMindmapLayout } from '@/features/mindmap/mindmapLayout';
import {
  exportToXmindZip,
  importFromXmindZip,
  moveMindNode,
  parseMindmapDocument,
  serializeMindmapDocument,
} from '@/features/mindmap/mindmapConverter';
import { cloneMindmapTree } from '@/features/mindmap/mindmapTree';
import { inspectXmindArchive, prepareXmindSheet, readXmindSheets } from '@/features/mindmap/xmindImport';

/** 根 + 三个一级分支（a 下挂两个子节点）+ 概要 / 外框 / 联系线 */
function sample(): MindNode {
  return {
    id: 'root',
    text: '中心',
    summaries: [{ id: 's1', startId: 'a', endId: 'b', text: '前两项' }],
    boundaries: [{ id: 'b1', startId: 'c', endId: 'c', title: '重点' }],
    children: [
      {
        id: 'a',
        text: '分支 A',
        relations: [{ id: 'r1', targetId: 'c', title: '依赖' }],
        children: [
          { id: 'a1', text: 'A1', children: [] },
          { id: 'a2', text: 'A2', children: [] },
        ],
      },
      { id: 'b', text: '分支 B', children: [] },
      { id: 'c', text: '分支 C', children: [] },
    ],
  };
}

const ALL_LAYOUTS: MindmapLayout[] = ['right', 'left', 'balanced', 'tree', 'tree-up', 'indent-right', 'indent-left', 'timeline', 'fishbone'];

describe('范围与数据操作', () => {
  test('范围按首尾 id 解析，排序变化后仍跟随原节点', () => {
    const root = sample();
    expect(resolveRangeIndexes(root, root.summaries![0])).toEqual([0, 1]);
    // b 移到 c 之后：范围扩展为 a..b 之间的全部节点
    const moved = moveMindNode(root, 'b', 'c', 'after');
    expect(resolveRangeIndexes(moved, moved.summaries![0])).toEqual([0, 2]);
  });

  test('首尾之一被移走时收缩为剩余一端，都不在时失效并在清理时移除', () => {
    const root = sample();
    root.children.splice(1, 1);
    expect(resolveRangeIndexes(root, root.summaries![0])).toEqual([0, 0]);
    root.children.splice(0, 1);
    expect(resolveRangeIndexes(root, root.summaries![0])).toBeNull();
    pruneMindmapStructures(root);
    expect(root.summaries).toBeUndefined();
    // 联系线起点 a 已删除，外框仍有效
    expect(root.boundaries).toHaveLength(1);
  });

  test('联系线目标被删除后清理', () => {
    const root = sample();
    root.children.pop();
    pruneMindmapStructures(root);
    expect(root.children[0].relations).toBeUndefined();
    expect(root.boundaries).toBeUndefined();
  });

  test('选中同级节点得到首尾范围，层级不同或选中根节点给出原因', () => {
    const root = sample();
    expect(getSiblingRangeForSelection(root, ['c', 'a'])).toEqual({ ok: true, parentId: 'root', startId: 'a', endId: 'c' });
    expect(getSiblingRangeForSelection(root, ['a1'])).toEqual({ ok: true, parentId: 'a', startId: 'a1', endId: 'a1' });
    expect(getSiblingRangeForSelection(root, ['a1', 'b']).ok).toBe(false);
    expect(getSiblingRangeForSelection(root, ['root']).ok).toBe(false);
  });

  test('克隆树改写结构元素不影响原树', () => {
    const root = sample();
    const cloned = cloneMindmapTree(root);
    setStructureText(cloned, { kind: 'summary', id: 's1' }, '改写');
    removeStructure(cloned, { kind: 'boundary', id: 'b1' });
    expect(root.summaries![0].text).toBe('前两项');
    expect(root.boundaries).toHaveLength(1);
    expect(cloned.summaries![0].text).toBe('改写');
    expect(cloned.boundaries).toBeUndefined();
  });

  test('文档序列化往返保留结构元素，非法条目被丢弃', () => {
    const root = sample();
    (root.summaries as unknown[]).push({ id: 'bad' });
    const parsed = parseMindmapDocument(serializeMindmapDocument(root));
    expect(parsed.summaries).toEqual([{ id: 's1', startId: 'a', endId: 'b', text: '前两项' }]);
    expect(parsed.boundaries).toEqual([{ id: 'b1', startId: 'c', endId: 'c', title: '重点' }]);
    expect(parsed.children[0].relations).toEqual([{ id: 'r1', targetId: 'c', title: '依赖' }]);
  });
});

describe('几何跟随节点', () => {
  test.each(ALL_LAYOUTS)('%s 布局下全部元素都能生成，且概要位于被概括内容之外', (layout) => {
    const { nodes } = computeMindmapLayout(sample(), layout, 6);
    const result = computeMindmapStructures(nodes);
    expect(result.summaries).toHaveLength(1);
    expect(result.boundaries).toHaveLength(1);
    expect(result.relations).toHaveLength(1);
    const summary = result.summaries[0];
    const covered = nodes.filter((n) => ['a', 'a1', 'a2', 'b'].includes(n.node.id) && n.siblingFlow !== undefined);
    // 概要文字框不与任何被概括节点重叠
    for (const n of covered) {
      const overlap = summary.label.x < n.x + n.width && summary.label.x + summary.label.width > n.x
        && summary.label.y < n.y + n.height && summary.label.y + summary.label.height > n.y;
      expect(overlap).toBe(false);
    }
    // 外框完整包住节点 c
    const c = nodes.find((n) => n.node.id === 'c')!;
    const box = result.boundaries[0].rect;
    expect(box.x).toBeLessThan(c.x);
    expect(box.y).toBeLessThan(c.y);
    expect(box.x + box.width).toBeGreaterThan(c.x + c.width);
    expect(box.y + box.height).toBeGreaterThan(c.y + c.height);
    expect(result.bounds).not.toBeNull();
  });

  test('向右逻辑图中概要在内容右侧，大括号开口朝左', () => {
    const { nodes } = computeMindmapLayout(sample(), 'right', 6);
    const summary = computeMindmapStructures(nodes).summaries[0];
    const maxRight = Math.max(...nodes.filter((n) => ['a', 'a1', 'a2', 'b'].includes(n.node.id)).map((n) => n.x + n.width));
    expect(summary.side).toBe('right');
    expect(summary.label.x).toBeGreaterThan(maxRight);
  });

  test('折叠的父节点不显示其上的概要与外框；联系线一端不可见时不绘制', () => {
    const root = sample();
    root.isExpanded = false;
    const { nodes } = computeMindmapLayout(root, 'right', 6);
    const result = computeMindmapStructures(nodes);
    expect(result.summaries).toHaveLength(0);
    expect(result.boundaries).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
    expect(result.bounds).toBeNull();
  });

  test('同一范围的外框与概要嵌套：概要让出外框', () => {
    const root = sample();
    root.boundaries = [{ id: 'b2', startId: 'a', endId: 'b' }];
    const { nodes } = computeMindmapLayout(root, 'right', 6);
    const result = computeMindmapStructures(nodes);
    const box = result.boundaries[0].rect;
    expect(result.summaries[0].label.x).toBeGreaterThan(box.x + box.width);
  });

  test('控制点直接决定走线：拖到右侧时曲线从两端节点的右侧出线', () => {
    const { nodes } = computeMindmapLayout(sample(), 'right', 6);
    const relation = computeMindmapStructures(nodes).relations[0];
    const source = nodes.find((n) => n.node.id === 'a')!;
    const target = nodes.find((n) => n.node.id === 'c')!;
    // 两个控制点都放到节点右侧 200px
    const controls: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 200, y: 0 }, { x: 200, y: 0 }];
    const moved = computeMindmapStructures(nodes, { controlOverrides: new Map([[relation.id, controls]]) }).relations[0];
    expect(moved.cp1).toEqual({ x: moved.c1.x + 200, y: moved.c1.y });
    expect(moved.p1.x).toBeGreaterThanOrEqual(source.x + source.width);
    expect(moved.p2.x).toBeGreaterThanOrEqual(target.x + target.width);
    // 保存的控制点同样生效，且序列化往返保留
    const root = sample();
    root.children[0].relations![0].controls = controls;
    const parsed = parseMindmapDocument(serializeMindmapDocument(root));
    expect(parsed.children[0].relations![0].controls).toEqual(controls);
    const saved = computeMindmapStructures(computeMindmapLayout(parsed, 'right', 6).nodes).relations[0];
    expect(saved.p1.x).toBeGreaterThanOrEqual(source.x + source.width);
  });

  test('拖动概要端点扩大 / 缩小覆盖范围，固定端取离手柄较远的一端', () => {
    const { nodes } = computeMindmapLayout(sample(), 'right', 6);
    const owner = nodes.find((n) => n.level === 0)!;
    const summary = computeMindmapStructures(nodes).summaries[0];
    const [top, bottom] = summary.handles;
    // 拖下端：固定端为首个节点 a
    expect(rangeFixedEndId(owner, { startId: 'a', endId: 'b' }, bottom)).toBe('a');
    expect(rangeFixedEndId(owner, { startId: 'a', endId: 'b' }, top)).toBe('b');
    const c = nodes.find((n) => n.node.id === 'c')!;
    expect(dragRangeEnd(owner, 'a', { x: bottom.x, y: c.y + c.height / 2 })).toEqual({ startId: 'a', endId: 'c' });
    // 拖过固定端时顺序自动交换
    const a = nodes.find((n) => n.node.id === 'a')!;
    expect(dragRangeEnd(owner, 'b', { x: top.x, y: a.y - 100 })).toEqual({ startId: 'a', endId: 'b' });
    // 预览覆盖立即反映到几何
    const extended = computeMindmapStructures(nodes, { rangeOverrides: new Map([['s1', { startId: 'a', endId: 'c' }]]) }).summaries[0];
    expect(extended.handles[1].y).toBeGreaterThan(c.y + c.height);
  });
});

describe('XMind 双向转换', () => {
  test('导出写入外框、概要主题与画布联系线，再导入完整还原', async () => {
    const blob = await exportToXmindZip(sample());
    const buffer = await blob.arrayBuffer();
    const zip = await JSZip.loadAsync(buffer);
    const [sheet] = JSON.parse(await zip.file('content.json')!.async('text'));
    expect(sheet.rootTopic.boundaries).toEqual([{ id: 'b1', range: '(2,2)', title: '重点' }]);
    expect(sheet.rootTopic.summaries[0].range).toBe('(0,1)');
    expect(sheet.rootTopic.children.summary[0].title).toBe('前两项');
    expect(sheet.rootTopic.children.attached).toHaveLength(3);
    expect(sheet.relationships).toEqual([{ id: 'r1', end1Id: 'a', end2Id: 'c', title: '依赖' }]);

    const root = await importFromXmindZip(buffer);
    expect(root.children.map((n) => n.text)).toEqual(['分支 A', '分支 B', '分支 C']);
    expect(root.summaries).toEqual([{ id: 's1', startId: 'a', endId: 'b', text: '前两项' }]);
    expect(root.boundaries).toEqual([{ id: 'b1', startId: 'c', endId: 'c', title: '重点' }]);
    expect(root.children[0].relations).toEqual([{ id: 'r1', targetId: 'c', title: '依赖' }]);
  });

  test('经典 XML 的外框（含 master）、概要与联系线均可转换，不再提示无法转换', async () => {
    const xml = `<?xml version="1.0"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0"><sheet id="s"><topic id="r"><title>根</title>`
      + `<children><topics type="attached"><topic id="a"><title>A</title><boundaries><boundary id="m" range="master"><title>自身</title></boundary></boundaries></topic><topic id="b"><title>B</title></topic></topics>`
      + `<topics type="summary"><topic id="st"><title>小结</title></topic></topics></children>`
      + `<boundaries><boundary id="bx" range="(0,1)"/></boundaries><summaries><summary id="sx" range="(0,1)" topic-id="st"/></summaries></topic>`
      + `<relationships><relationship id="rx" end1="a" end2="b"><title>引用</title></relationship></relationships></sheet></xmap-content>`;
    const zip = new JSZip();
    zip.file('content.xml', xml);
    const archive = await inspectXmindArchive(await zip.generateAsync({ type: 'arraybuffer' }));
    const prepared = prepareXmindSheet(archive, (await readXmindSheets(archive))[0]);
    const root = prepared.root;
    expect(root.children.map((n) => n.text)).toEqual(['A', 'B']);
    expect(root.summaries).toEqual([{ id: 'sx', startId: 'a', endId: 'b', text: '小结' }]);
    expect(root.boundaries).toHaveLength(2);
    expect(root.boundaries).toEqual(expect.arrayContaining([
      { id: 'm', startId: 'a', endId: 'a', title: '自身' },
      { id: 'bx', startId: 'a', endId: 'b' },
    ]));
    expect(root.children[0].relations).toEqual([{ id: 'rx', targetId: 'b', title: '引用' }]);
    expect(prepared.warnings).toEqual([]);
  });

  test('范围越界的外框与端点缺失的联系线明确提示', async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([{
      rootTopic: { id: 'r', title: '根', boundaries: [{ id: 'x', range: '(5,6)' }], children: { attached: [{ id: 'a', title: 'A' }] } },
      relationships: [{ id: 'q', end1Id: 'a', end2Id: 'missing' }],
    }]));
    const archive = await inspectXmindArchive(await zip.generateAsync({ type: 'arraybuffer' }));
    const prepared = prepareXmindSheet(archive, (await readXmindSheets(archive))[0]);
    expect(prepared.root.boundaries).toBeUndefined();
    expect(prepared.warnings).toContain('部分外框范围无效，未转换');
    expect(prepared.warnings).toContain('部分关联线端点缺失，未转换');
  });
});

describe('跨父节点的同层范围', () => {
  /** 根 + 分支 A（a1 a2 a3）、分支 B（b1 b2）、分支 C；外框与概要都覆盖 a2..b1 */
  function cousins(): MindNode {
    return {
      id: 'root',
      text: '中心',
      boundaries: [{ id: 'x1', startId: 'a2', endId: 'b1', title: '跨父' }],
      summaries: [{ id: 'x2', startId: 'a2', endId: 'b1', text: '跨父概要' }],
      children: [
        {
          id: 'a',
          text: '分支 A',
          children: [
            { id: 'a1', text: 'A1', children: [] },
            { id: 'a2', text: 'A2', children: [] },
            { id: 'a3', text: 'A3', children: [] },
          ],
        },
        {
          id: 'b',
          text: '分支 B',
          children: [
            { id: 'b1', text: 'B1', children: [] },
            { id: 'b2', text: 'B2', children: [] },
          ],
        },
        { id: 'c', text: '分支 C', children: [] },
      ],
    };
  }

  const rectOf = (n: { x: number; y: number; width: number; height: number }) => ({ x: n.x, y: n.y, width: n.width, height: n.height });
  const overlaps = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  test('同层不同父的选中挂在共同祖先上，层级不同时给出原因', () => {
    const root = cousins();
    expect(getSiblingRangeForSelection(root, ['b1', 'a2'])).toEqual({ ok: true, parentId: 'root', startId: 'a2', endId: 'b1' });
    expect(getSiblingRangeForSelection(root, ['a1', 'b'])).toEqual({ ok: false, reason: '请选择同一层级的节点' });
  });

  test('范围覆盖首尾之间的全部同层节点，不含中间的父节点；XMind 导出提升为子主题区间', () => {
    const root = cousins();
    expect(resolveRangeNodes(root, root.boundaries![0])!.map((n) => n.id)).toEqual(['a2', 'a3', 'b1']);
    expect(resolveRangeIndexes(root, root.boundaries![0])).toEqual([0, 1]);
    // 末端被移到其他层级时退化为仍有效的一端，清理时保留
    const moved = moveMindNode(root, 'b1', 'c', 'after');
    expect(resolveRangeNodes(moved, moved.boundaries![0])!.map((n) => n.id)).toEqual(['a2']);
    pruneMindmapStructures(moved);
    expect(moved.boundaries).toHaveLength(1);
  });

  test.each(ALL_LAYOUTS)('%s 布局下跨父外框包住覆盖节点且不圈住其父节点', (layout) => {
    const { nodes } = computeMindmapLayout(cousins(), layout, 6);
    const result = computeMindmapStructures(nodes);
    expect(result.boundaries).toHaveLength(1);
    expect(result.summaries).toHaveLength(1);
    const boundary = result.boundaries[0];
    const box = boundary.rect;
    // 双向图中 A、B 分处根节点两侧时，范围只取首个节点所在一侧
    const center = nodes.find((n) => n.level === 0)!;
    const a2 = nodes.find((n) => n.node.id === 'a2')!;
    const sameSide = (n: typeof a2) => (n.x > center.x) === (a2.x > center.x);
    for (const id of ['a2', 'a3', 'b1']) {
      const n = nodes.find((item) => item.node.id === id)!;
      if (!sameSide(n)) continue;
      expect(box.x).toBeLessThan(n.x);
      expect(box.x + box.width).toBeGreaterThan(n.x + n.width);
    }
    // 概要文字框不压住任何节点
    for (const n of nodes) expect(overlaps(result.summaries[0].label, rectOf(n))).toBe(false);
  });

  test('逻辑图中阶梯外框不与父节点重叠；缩进图中被父节点隔开时分段绘制', () => {
    const right = computeMindmapLayout(cousins(), 'right', 6).nodes;
    const boundary = computeMindmapStructures(right).boundaries[0];
    expect(boundary.path).toBeDefined();
    expect(boundary.path!.match(/M/g)).toHaveLength(1);
    for (const id of ['root', 'a', 'b']) {
      expect(overlaps(boundary.rect, rectOf(right.find((n) => n.node.id === id)!))).toBe(false);
    }
    const indent = computeMindmapLayout(cousins(), 'indent-right', 6).nodes;
    expect(computeMindmapStructures(indent).boundaries[0].path!.match(/M/g)).toHaveLength(2);
    // 同父范围仍画圆角矩形
    const sibling = cousins();
    sibling.boundaries = [{ id: 'x1', startId: 'a1', endId: 'a2' }];
    sibling.summaries = undefined;
    const siblingNodes = computeMindmapLayout(sibling, 'right', 6).nodes;
    expect(computeMindmapStructures(siblingNodes).boundaries[0].path).toBeUndefined();
  });

  test('拖动跨父范围端点在同层内伸缩', () => {
    const { nodes } = computeMindmapLayout(cousins(), 'right', 6);
    const owner = nodes.find((n) => n.level === 0)!;
    const b2 = nodes.find((n) => n.node.id === 'b2')!;
    const a1 = nodes.find((n) => n.node.id === 'a1')!;
    expect(dragRangeEnd(owner, 'a2', { x: b2.x, y: b2.y + b2.height / 2 })).toEqual({ startId: 'a2', endId: 'b2' });
    expect(dragRangeEnd(owner, 'b1', { x: a1.x, y: a1.y + a1.height / 2 })).toEqual({ startId: 'a1', endId: 'b1' });
    const [top, bottom] = computeMindmapStructures(nodes).boundaries[0].handles;
    expect(rangeFixedEndId(owner, { startId: 'a2', endId: 'b1' }, bottom)).toBe('a2');
    expect(rangeFixedEndId(owner, { startId: 'a2', endId: 'b1' }, top)).toBe('b1');
  });
});
