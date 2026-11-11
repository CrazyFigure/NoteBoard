// 关系图谱：构图规则、局部子图、显示过滤与力导向布局（路径按 Windows 语义）
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/ipc/commands', () => ({
  readDir: vi.fn(),
  readDocument: vi.fn(),
}));

import { buildSnapshot, type NoteEntry } from '../../src/features/wikilink/noteIndex';
import { computeLinkGraph, filterLinkGraph, localSubgraph, graphNodeIdOf } from '../../src/features/wikilink/linkGraph';
import { extractWikiLinks } from '../../src/features/wikilink/wikiLinkSyntax';
import { ForceSimulation, seedPositions, type SimNode } from '../../src/features/wikilink/graphLayout';

const ROOT = 'C:\\vault';

function entry(relPath: string): NoteEntry {
  const name = relPath.split('/').pop()!;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const segments = relPath.split('/');
  segments.pop();
  return {
    path: `${ROOT}\\${relPath.replace(/\//g, '\\')}`,
    name,
    stem: dot > 0 ? name.slice(0, dot) : name,
    ext,
    relPath,
    dir: segments.length ? `${ROOT}\\${segments.join('\\')}` : ROOT,
    isMarkdown: ext === 'md',
    kind: ext === 'md' ? 'markdown' : null,
    mtime: 0,
    size: 10,
  };
}

const pathOf = (relPath: string) => `${ROOT}\\${relPath.replace(/\//g, '\\')}`;
const idOf = (relPath: string) => graphNodeIdOf(pathOf(relPath));

const snapshot = buildSnapshot(ROOT, [
  entry('首页.md'),
  entry('项目/计划.md'),
  entry('项目/周报.md'),
  entry('孤立.md'),
  entry('图片/封面.png'),
  entry('画板/架构.excalidraw'),
]);

function graphOf(sources: Record<string, string>) {
  const links = new Map(Object.entries(sources).map(([rel, markdown]) => [pathOf(rel), extractWikiLinks(markdown)]));
  return computeLinkGraph(snapshot, links);
}

describe('computeLinkGraph', () => {
  const graph = graphOf({
    '首页.md': '见 [[计划]] 与 [[计划|再次]]，还有 [[周报#本周]] 和 [[#目录]]、[[首页]]',
    '项目/计划.md': '回到 [[首页]]，图 ![[封面.png]]，架构 [[架构.excalidraw]]，待写 [[未来想法]]、![[缺失.png]]',
  });

  it('全部 Markdown 笔记都是节点，孤立笔记也在内', () => {
    expect(graph.nodes.find((node) => node.id === idOf('孤立.md'))).toMatchObject({ kind: 'note', degree: 0 });
  });

  it('同一对笔记的多次链接合并为一条边并计数', () => {
    const edge = graph.edges.find((item) => item.source === idOf('首页.md') && item.target === idOf('项目/计划.md'));
    expect(edge?.count).toBe(2);
  });

  it('忽略指向自身的链接与 [[#标题]]', () => {
    expect(graph.edges.some((edge) => edge.source === edge.target)).toBe(false);
  });

  it('图片不进入图谱，其它附件作为 file 节点', () => {
    expect(graph.nodes.some((node) => node.name.endsWith('.png'))).toBe(false);
    expect(graph.nodes.find((node) => node.id === idOf('画板/架构.excalidraw'))).toMatchObject({ kind: 'file', degree: 1 });
  });

  it('未找到的目标成为未创建节点', () => {
    const ghost = graph.nodes.find((node) => node.kind === 'unresolved');
    expect(ghost).toMatchObject({ name: '未来想法', path: null });
  });

  it('度数按相连笔记数统计，互链只算一次', () => {
    // 首页 ↔ 计划（互链）、首页 → 周报
    expect(graph.nodes.find((node) => node.id === idOf('首页.md'))?.degree).toBe(2);
  });
});

describe('localSubgraph / filterLinkGraph', () => {
  const graph = graphOf({
    '首页.md': '[[计划]]',
    '项目/计划.md': '[[周报]] [[未来想法]]',
  });

  it('按层数展开且不区分链接方向', () => {
    const one = localSubgraph(graph, idOf('项目/周报.md'), 1);
    expect(one.nodes.map((node) => node.name).sort()).toEqual(['周报', '计划'].sort());
    const two = localSubgraph(graph, idOf('项目/周报.md'), 2);
    expect(two.nodes.map((node) => node.name).sort()).toEqual(['周报', '未来想法', '计划', '首页'].sort());
    expect(two.edges).toHaveLength(3);
  });

  it('中心不在图中时返回空图', () => {
    expect(localSubgraph(graph, 'c:\\elsewhere\\x.md', 2).nodes).toEqual([]);
  });

  it('隐藏孤立笔记与未创建笔记，焦点始终保留', () => {
    const filtered = filterLinkGraph(graph, { orphans: false, unresolved: false, focusId: idOf('孤立.md') });
    const names = filtered.nodes.map((node) => node.name);
    expect(names).toContain('孤立');
    expect(names).not.toContain('未来想法');
    expect(filtered.edges.every((edge) => !edge.target.startsWith('unresolved:'))).toBe(true);
  });
});

describe('ForceSimulation', () => {
  it('布局收敛：相连节点靠近、互不重合，且会停止', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const positions = seedPositions(ids, () => [], new Map());
    const nodes: SimNode[] = ids.map((id) => ({ ...positions.get(id)!, id, vx: 0, vy: 0, fx: null, fy: null }));
    const [a, b, c, d] = nodes;
    const sim = new ForceSimulation(nodes, [{ source: a, target: b }, { source: b, target: c }]);
    let ticks = 0;
    while (sim.active && ticks < 2000) {
      sim.tick();
      ticks += 1;
    }
    expect(sim.active).toBe(false);
    const dist = (p: SimNode, q: SimNode) => Math.hypot(p.x - q.x, p.y - q.y);
    expect(dist(a, b)).toBeGreaterThan(10);
    expect(dist(a, b)).toBeLessThan(dist(a, d) + 40);
    for (const node of nodes) {
      expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
    }
  });

  it('沿用已有位置，新节点放在邻居附近', () => {
    const positions = seedPositions(['old', 'new'], (id) => (id === 'new' ? ['old'] : []), new Map([['old', { x: 500, y: 500 }]]));
    expect(positions.get('old')).toEqual({ x: 500, y: 500 });
    const fresh = positions.get('new')!;
    expect(Math.hypot(fresh.x - 500, fresh.y - 500)).toBeLessThan(30);
  });
});
