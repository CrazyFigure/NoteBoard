// 概要主题（节点化的概要）测试：
// 旧版概要文字的平滑迁移、树操作对概要子树的支持、概要子树的排版与避让、XMind 往返，以及画布交互。
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
import { MindmapRenderer } from '@/features/mindmap/MindmapRenderer';
import { getMindmapTheme } from '@/features/mindmap/mindmapTheme';
import type { MindNode, MindmapLayout } from '@/features/mindmap/mindmapTypes';
import { computeMindmapLayout } from '@/features/mindmap/mindmapLayout';
import { computeMindmapStructures, getSiblingRangeForSelection } from '@/features/mindmap/mindmapStructures';
import {
  exportToXmindZip,
  importFromXmindZip,
  moveMindNodes,
  parseMindmapDocument,
  serializeMindmapDocument,
} from '@/features/mindmap/mindmapConverter';
import {
  cloneMindmapTree,
  findMindNode,
  findMindNodeParent,
  findSummaryByTopicId,
  getMindmapTreeStats,
  getTopLevelMindNodeIds,
  updateMindmapNode,
  walkMindNodes,
} from '@/features/mindmap/mindmapTree';
import { expandMindmapAncestors, findMindmapMatches } from '@/features/mindmap/mindmapSearch';

const ALL_LAYOUTS: MindmapLayout[] = ['right', 'left', 'balanced', 'tree', 'tree-up', 'indent-right', 'indent-left', 'timeline', 'fishbone'];

/** 根 + 三个一级分支；概要覆盖 a..b，概要主题下挂 t1（含 t11）、t2 */
function sample(): MindNode {
  return {
    id: 'root',
    text: '中心',
    isExpanded: true,
    summaries: [{
      id: 's1',
      startId: 'a',
      endId: 'b',
      topic: {
        id: 'st',
        text: '小结',
        isExpanded: true,
        children: [
          { id: 't1', text: '要点 1', isExpanded: true, children: [{ id: 't11', text: '细节', children: [] }] },
          { id: 't2', text: '要点 2', children: [] },
        ],
      },
    }],
    children: [
      { id: 'a', text: '分支 A', isExpanded: true, children: [] },
      { id: 'b', text: '分支 B', isExpanded: true, children: [] },
      { id: 'c', text: '分支 C', isExpanded: true, children: [] },
    ],
  };
}

const rectOf = (n: { x: number; y: number; width: number; height: number }) => ({ x: n.x, y: n.y, width: n.width, height: n.height });
const overlaps = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe('旧版文档平滑迁移', () => {
  const legacy = JSON.stringify({
    version: 1,
    layout: 'right',
    root: {
      id: 'root',
      text: '中心',
      summaries: [{ id: 's1', startId: 'a', endId: 'b', text: '旧概要' }],
      children: [
        { id: 'a', text: 'A', children: [] },
        { id: 'b', text: 'B', children: [] },
      ],
    },
  });

  test('旧版概要文字迁移为概要主题，id 固定，重复打开不变', () => {
    const first = parseMindmapDocument(legacy);
    const second = parseMindmapDocument(legacy);
    expect(first.summaries).toEqual([{ id: 's1', startId: 'a', endId: 'b', topic: { id: 's1-topic', text: '旧概要', isExpanded: true, children: [] } }]);
    expect(second.summaries![0].topic.id).toBe(first.summaries![0].topic.id);
  });

  test('保存时同时写入概要主题与旧版 text，旧版本仍能读到概要文字；再次打开无损', () => {
    const root = parseMindmapDocument(legacy);
    root.summaries![0].topic.children.push({ id: 'n1', text: '新子节点', children: [] });
    const saved = serializeMindmapDocument(root);
    const raw = JSON.parse(saved);
    expect(raw.root.summaries[0].text).toBe('旧概要');
    expect(raw.root.summaries[0].topic.children[0].text).toBe('新子节点');
    const reopened = parseMindmapDocument(saved);
    expect(reopened.summaries![0].topic.text).toBe('旧概要');
    expect(reopened.summaries![0].topic.children.map((n) => n.text)).toEqual(['新子节点']);
  });

  test('旧版本写回的文件（只有 text，丢了 topic）也能再次迁移', () => {
    const root = parseMindmapDocument(legacy);
    const raw = JSON.parse(serializeMindmapDocument(root));
    delete raw.root.summaries[0].topic;
    raw.root.summaries[0].text = '旧版本改过';
    const reopened = parseMindmapDocument(JSON.stringify(raw));
    expect(reopened.summaries![0].topic).toMatchObject({ id: 's1-topic', text: '旧版本改过' });
  });

  test('概要主题子树按普通节点规则规范化（缺 id 补齐、非法字段丢弃）', () => {
    const doc = JSON.parse(serializeMindmapDocument(sample()));
    delete doc.root.summaries[0].topic.children[1].id;
    doc.root.summaries[0].topic.children[1].width = -5;
    const parsed = parseMindmapDocument(JSON.stringify(doc));
    const second = parsed.summaries![0].topic.children[1];
    expect(second.id).toMatch(/^node-/);
    expect(second.width).toBeUndefined();
  });
});

describe('树操作覆盖概要子树', () => {
  test('遍历、查找、统计都包含概要主题及其子孙', () => {
    const root = sample();
    expect([...walkMindNodes(root)].map((n) => n.id)).toEqual(['root', 'a', 'b', 'c', 'st', 't1', 't11', 't2']);
    expect(findMindNode(root, 't11')?.text).toBe('细节');
    // 概要主题自身没有父节点（不能作为同级插入 / 搬移），其子节点的父节点是概要主题
    expect(findMindNodeParent(root, 'st')).toBeNull();
    expect(findMindNodeParent(root, 't2')?.parent.id).toBe('st');
    expect(findSummaryByTopicId(root, 'st')?.summary.id).toBe('s1');
    expect(getMindmapTreeStats(root)).toEqual({ nodeCount: 8, maxDepth: 4 });
  });

  test('顶层节点不含概要主题，但含概要子树中的节点', () => {
    const root = sample();
    expect(getTopLevelMindNodeIds(root, ['st', 't1', 't11', 'a'])).toEqual(['a', 't1']);
  });

  test('克隆深拷贝概要子树；路径复制改写概要子树中的节点并可展开祖先', () => {
    const root = sample();
    const cloned = cloneMindmapTree(root);
    cloned.summaries![0].topic.children[0].text = '改';
    expect(root.summaries![0].topic.children[0].text).toBe('要点 1');

    const updated = updateMindmapNode(root, 't11', (node) => ({ ...node, text: '新细节' }));
    expect(findMindNode(updated, 't11')?.text).toBe('新细节');
    expect(findMindNode(root, 't11')?.text).toBe('细节');
    // 未改动的分支共享引用
    expect(updated.children[0]).toBe(root.children[0]);

    root.isExpanded = false;
    root.summaries![0].topic.isExpanded = false;
    const expanded = expandMindmapAncestors(root, 't11');
    expect(expanded.isExpanded).toBe(true);
    expect(expanded.summaries![0].topic.isExpanded).toBe(true);
  });

  test('搜索能命中概要主题与其子节点', () => {
    const matches = findMindmapMatches(sample(), /要点|小结/g);
    expect(matches.map((m) => m.nodeId)).toEqual(['st', 't1', 't2']);
  });

  test('节点可拖入概要主题；不能作为概要主题的同级；概要主题本身不可搬移', () => {
    const root = sample();
    const inside = moveMindNodes(root, ['c'], 'st', 'inside');
    expect(findMindNodeParent(inside, 'c')?.parent.id).toBe('st');
    expect(moveMindNodes(root, ['c'], 'st', 'after')).toBe(root);
    expect(moveMindNodes(root, ['st'], 'c', 'inside')).toBe(root);
    // 概要子树中的节点可以搬回主树
    const back = moveMindNodes(root, ['t2'], 'c', 'inside');
    expect(findMindNodeParent(back, 't2')?.parent.id).toBe('c');
  });

  test('概要子树中的同层节点可以再加概要；选中概要主题或与主树节点混选时提升到共同上级', () => {
    const root = sample();
    expect(getSiblingRangeForSelection(root, ['t1', 't2'])).toEqual({ ok: true, parentId: 'st', startId: 't1', endId: 't2' });
    // 单个概要主题：概括它所概括的那段节点（概要的概要）
    expect(getSiblingRangeForSelection(root, ['st'])).toEqual({ ok: true, parentId: 'root', startId: 'a', endId: 'b' });
    // 概要子树节点 + 主树节点：概要主题占据 a..b 的位置，与 c 合并
    expect(getSiblingRangeForSelection(root, ['t11', 'c'])).toEqual({ ok: true, parentId: 'root', startId: 'a', endId: 'c' });
    // 概要子树内的不同层级仍按同层规则提示
    expect(getSiblingRangeForSelection(root, ['t11', 't2'])).toEqual({ ok: false, reason: '请选择同一层级的节点' });
    expect(getSiblingRangeForSelection(root, ['root', 'st'])).toEqual({ ok: false, reason: '中心主题不能添加' });
  });

  test('分属两个分支的概要主题 / 概要子节点：概括这两个分支', () => {
    const root: MindNode = {
      id: 'root',
      text: '中心',
      isExpanded: true,
      children: [
        {
          id: 'p1',
          text: '分支 1',
          isExpanded: true,
          summaries: [{ id: 's1', startId: 'p11', endId: 'p12', topic: { id: 'st1', text: '概要', isExpanded: true, children: [{ id: 'x3', text: '3', children: [] }] } }],
          children: [{ id: 'p11', text: '1.1', children: [] }, { id: 'p12', text: '1.2', children: [] }],
        },
        {
          id: 'p2',
          text: '分支 2',
          isExpanded: true,
          summaries: [{ id: 's2', startId: 'p21', endId: 'p21', topic: { id: 'st2', text: '概要', isExpanded: true, children: [] } }],
          children: [{ id: 'p21', text: '2.1', isExpanded: true, children: [{ id: 'x1', text: '1', isExpanded: true, children: [{ id: 'x2', text: '2', children: [] }] }] }],
        },
        { id: 'p3', text: '分支 3', children: [] },
      ],
    };
    const both = { ok: true, parentId: 'root', startId: 'p1', endId: 'p2' };
    expect(getSiblingRangeForSelection(root, ['st1', 'st2'])).toEqual(both);
    expect(getSiblingRangeForSelection(root, ['x3', 'x2'])).toEqual(both);
    // 概要子节点 + 同一分支下的节点：在该分支内概括
    expect(getSiblingRangeForSelection(root, ['x3', 'p12'])).toEqual({ ok: true, parentId: 'p1', startId: 'p11', endId: 'p12' });
  });

  test('同一节点上的「概要的概要」：外层大括号让出内层概要主题', () => {
    const root = sample();
    root.summaries!.push({ id: 's2', startId: 'a', endId: 'b', topic: { id: 'st2', text: '总结', isExpanded: true, children: [] } });
    const { nodes } = computeMindmapLayout(root, 'right', 6);
    const result = computeMindmapStructures(nodes);
    const inner = result.nodes.filter((n) => n.summaryOf?.id !== 's2' && ['st', 't1', 't11', 't2'].includes(n.node.id));
    const outer = result.summaries.find((s) => s.id === 's2')!;
    const innerRight = Math.max(...inner.map((n) => n.x + n.width));
    expect(outer.handles[0].x).toBeGreaterThan(innerRight);
    expect(outer.label.x).toBeGreaterThan(innerRight);
  });

  test('跨父范围的外层概要让出中间层节点上的概要', () => {
    const root: MindNode = {
      id: 'root',
      text: '中心',
      isExpanded: true,
      // 外层：挂根节点，覆盖 a1 ~ b1（跨父）
      summaries: [{ id: 'outer', startId: 'a1', endId: 'b1', topic: { id: 'outer-topic', text: '外层', isExpanded: true, children: [] } }],
      children: [
        { id: 'a', text: 'A', isExpanded: true, children: [{ id: 'a1', text: 'A1', children: [] }] },
        {
          id: 'b',
          text: 'B',
          isExpanded: true,
          // 内层：挂 b，只覆盖 b1
          summaries: [{ id: 'inner', startId: 'b1', endId: 'b1', topic: { id: 'inner-topic', text: '内层概要', isExpanded: true, children: [] } }],
          children: [{ id: 'b1', text: 'B1', children: [] }],
        },
      ],
    };
    const { nodes } = computeMindmapLayout(root, 'right', 6);
    const result = computeMindmapStructures(nodes);
    const innerTopic = result.nodes.find((n) => n.node.id === 'inner-topic')!;
    const outer = result.summaries.find((s) => s.id === 'outer')!;
    expect(outer.handles[0].x).toBeGreaterThan(innerTopic.x + innerTopic.width);
  });
});

describe('概要子树排版', () => {
  test('向右逻辑图：概要主题在大括号右侧，子节点继续向右展开并有连线', () => {
    const { nodes } = computeMindmapLayout(sample(), 'right', 6);
    const result = computeMindmapStructures(nodes);
    const byId = new Map(result.nodes.map((n) => [n.node.id, n]));
    expect([...byId.keys()].sort()).toEqual(['st', 't1', 't11', 't2']);
    const topic = byId.get('st')!;
    const maxRight = Math.max(...nodes.filter((n) => ['a', 'b'].includes(n.node.id)).map((n) => n.x + n.width));
    expect(topic.x).toBeGreaterThan(maxRight);
    expect(topic.summaryOf).toEqual({ ownerId: 'root', id: 's1' });
    expect(byId.get('t1')!.x).toBeGreaterThan(topic.x + topic.width);
    expect(byId.get('t11')!.x).toBeGreaterThan(byId.get('t1')!.x + byId.get('t1')!.width);
    expect(result.links.map((l) => `${l.from.node.id}>${l.to.node.id}`).sort()).toEqual(['st>t1', 'st>t2', 't1>t11']);
    expect(result.summaries[0].topicId).toBe('st');
    expect(result.summaries[0].label).toEqual(rectOf(topic));
  });

  test.each(ALL_LAYOUTS)('%s 布局下概要子树不与任何节点重叠', (layout) => {
    const { nodes } = computeMindmapLayout(sample(), layout, 6);
    const result = computeMindmapStructures(nodes);
    expect(result.nodes).toHaveLength(4);
    for (const s of result.nodes) {
      for (const n of nodes) expect(overlaps(rectOf(s), rectOf(n))).toBe(false);
      for (const other of result.nodes) if (other !== s) expect(overlaps(rectOf(s), rectOf(other))).toBe(false);
    }
  });

  test('概要子树比所覆盖内容高时为其预留空间，后续分支随之下移', () => {
    const plain = sample();
    plain.summaries![0].topic.children = [];
    const tall = sample();
    tall.summaries![0].topic.children.push(...Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, text: `更多 ${i}`, children: [] })));
    const yOf = (root: MindNode) => computeMindmapLayout(root, 'right', 6).nodes.find((n) => n.node.id === 'c')!.y;
    expect(yOf(tall)).toBeGreaterThan(yOf(plain));
  });

  test('折叠概要主题时只显示概要主题；概要子树内部还能继续挂概要', () => {
    const collapsed = sample();
    collapsed.summaries![0].topic.isExpanded = false;
    const nodes1 = computeMindmapLayout(collapsed, 'right', 6).nodes;
    expect(computeMindmapStructures(nodes1).nodes.map((n) => n.node.id)).toEqual(['st']);

    const nested = sample();
    nested.summaries![0].topic.summaries = [{ id: 's2', startId: 't1', endId: 't2', topic: { id: 'st2', text: '再概括', children: [] } }];
    const nodes2 = computeMindmapLayout(nested, 'right', 6).nodes;
    const result = computeMindmapStructures(nodes2);
    expect(result.summaries.map((s) => s.id).sort()).toEqual(['s1', 's2']);
    const inner = result.nodes.find((n) => n.node.id === 'st2')!;
    const t11 = result.nodes.find((n) => n.node.id === 't11')!;
    expect(inner.x).toBeGreaterThan(t11.x + t11.width);
  });

  test('联系线可以连到概要子树中的节点', () => {
    const root = sample();
    root.children[2].relations = [{ id: 'r1', targetId: 't2' }];
    const result = computeMindmapStructures(computeMindmapLayout(root, 'right', 6).nodes);
    expect(result.relations).toHaveLength(1);
  });
});

describe('XMind 往返', () => {
  test('概要主题及其子树导出到 children.summary，导入后完整还原', async () => {
    const buffer = await (await exportToXmindZip(sample())).arrayBuffer();
    const [sheet] = JSON.parse(await (await JSZip.loadAsync(buffer)).file('content.json')!.async('text'));
    expect(sheet.rootTopic.summaries).toEqual([{ id: 's1', range: '(0,1)', topicId: 'st' }]);
    expect(sheet.rootTopic.children.summary[0].children.attached.map((t: { title: string }) => t.title)).toEqual(['要点 1', '要点 2']);

    const root = await importFromXmindZip(buffer);
    expect(root.children.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    const topic = root.summaries![0].topic;
    expect(topic).toMatchObject({ id: 'st', text: '小结' });
    expect(topic.children.map((n) => n.text)).toEqual(['要点 1', '要点 2']);
    expect(topic.children[0].children[0].text).toBe('细节');
  });
});

describe('画布交互', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onChange = vi.fn<(tree: MindNode) => void>();

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onChange.mockClear();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(1200);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    function Harness() {
      const [tree, setTree] = useState(sample);
      const theme = getMindmapTheme();
      return <MindmapRenderer root={tree} onChange={(next) => { onChange(next); setTree(next); }}
        zoom={1} onZoomChange={() => {}} layout="right" theme={theme} edgeStyle={theme.edgeStyle}
        maxNodeWidth={300} defaultTextAlign="left" defaultImageFit="original" />;
    }
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  const select = async (id: string) => {
    const node = host.querySelector(`[data-node-id="${id}"]`)!;
    await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  };
  /** 键盘事件从 body 冒泡到 window（与焦点不在输入框时一致） */
  const press = async (key: string, target: EventTarget = document.body) => {
    await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
  };
  const latestTree = () => onChange.mock.lastCall![0];

  it('概要主题与其子节点以普通节点渲染', () => {
    for (const id of ['st', 't1', 't11', 't2']) expect(host.querySelector(`[data-node-id="${id}"]`)).toBeTruthy();
    expect(host.querySelector('.nb-mindmap-summary-brace')).toBeTruthy();
  });

  it('选中概要主题按 Tab / Enter 都新增子节点', async () => {
    await select('st');
    await press('Tab');
    expect(latestTree().summaries![0].topic.children).toHaveLength(3);
    // 新节点进入编辑：先在编辑框内 Esc 退出编辑，再选回概要主题按 Enter
    await press('Escape', host.querySelector('[role="textbox"]')!);
    await select('st');
    await press('Enter');
    expect(latestTree().summaries![0].topic.children).toHaveLength(4);
    expect(latestTree().children).toHaveLength(3);
  });

  it('概要子树中的节点按 Enter 新增同级', async () => {
    await select('t2');
    await press('Enter');
    expect(latestTree().summaries![0].topic.children.map((n) => n.id).slice(0, 2)).toEqual(['t1', 't2']);
    expect(latestTree().summaries![0].topic.children).toHaveLength(3);
  });

  it('删除概要子树中的节点；删除概要主题即删除整个概要', async () => {
    await select('t2');
    await press('Delete');
    expect(latestTree().summaries![0].topic.children.map((n) => n.id)).toEqual(['t1']);
    await select('st');
    await press('Delete');
    // 概要主题还有子节点：先弹确认
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === '删除');
    expect(confirm).toBeTruthy();
    await act(async () => { confirm!.click(); });
    expect(latestTree().summaries).toBeUndefined();
    expect(latestTree().children.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('删除所覆盖的全部节点后概要随之清理', async () => {
    await select('a');
    await press('Delete');
    expect(latestTree().summaries).toHaveLength(1);
    await select('b');
    await press('Delete');
    expect(latestTree().summaries).toBeUndefined();
  });
});
