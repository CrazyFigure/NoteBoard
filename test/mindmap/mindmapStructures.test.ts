// NoteBoard 思维导图结构元素测试
// 覆盖概要 / 外框 / 联系线的数据范围解析、失效清理、几何跟随节点，以及 XMind 双向转换
// 详见 docs/09-开发路线图.md

import { describe, expect, test } from 'vitest';
import JSZip from 'jszip';
import type { MindNode, MindmapLayout } from '@/features/mindmap/mindmapTypes';
import {
  bendFromPoint,
  computeMindmapStructures,
  getSiblingRangeForSelection,
  pruneMindmapStructures,
  removeStructure,
  resolveRangeIndexes,
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

  test('选中同级节点得到首尾范围，跨父节点或选中根节点给出原因', () => {
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

  test('拖动手柄换算的弯曲量使曲线中点经过指针位置', () => {
    const { nodes } = computeMindmapLayout(sample(), 'right', 6);
    const relation = computeMindmapStructures(nodes).relations[0];
    const target = { x: relation.chordMid.x + relation.normal.x * 60, y: relation.chordMid.y + relation.normal.y * 60 };
    const bend = bendFromPoint(relation, target);
    const moved = computeMindmapStructures(nodes, { bendOverrides: new Map([[relation.id, bend]]) }).relations[0];
    expect(Math.hypot(moved.mid.x - target.x, moved.mid.y - target.y)).toBeLessThan(12);
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
