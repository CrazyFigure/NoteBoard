// NoteBoard 关系图谱数据
// 把仓库内全部 Markdown 笔记中的双链汇总为「笔记 → 笔记」的图：
// 1. 链接提取复用反向链接的缓存（按修改时间与大小），已打开的文档使用内存中的最新内容；
// 2. 目标解析与正文中的双链完全一致（resolveWikiTarget），同一对笔记的多次链接合并为一条边；
// 3. 图片等嵌入资源不进入图谱，其它非 Markdown 文件（画板、思维导图等）被链接时作为附件节点出现；
// 4. 尚未创建的目标作为「未创建」节点，与 Obsidian 的显示方式一致。

import { pathKey } from '../explorer/pathUtils';
import { readWikiLinks } from './backlinks';
import { loadNoteIndex, resolveVaultRoot, resolveWikiTarget, type NoteEntry, type NoteIndexSnapshot } from './noteIndex';
import { EMBED_IMAGE_EXTENSIONS, parseWikiLinkInner, type WikiLinkOccurrence } from './wikiLinkSyntax';

/** 并发读取文件数（与反向链接一致） */
const READ_CONCURRENCY = 6;
/** 未创建节点 id 前缀（与路径比较键区分） */
const UNRESOLVED_PREFIX = 'unresolved:';

export type GraphNodeKind = 'note' | 'file' | 'unresolved';

/** 图谱节点 */
export interface GraphNode {
  /** 唯一 id：已有文件为路径比较键，未创建目标为 `unresolved:` + 小写目标 */
  id: string;
  kind: GraphNodeKind;
  /** 显示名（笔记主名 / 附件文件名 / 未创建的链接目标） */
  name: string;
  /** 绝对路径；未创建节点为 null */
  path: string | null;
  /** 相对仓库根的路径（悬停提示用）；未创建节点为链接目标原文 */
  relPath: string;
  /** 关联的边数（不区分方向） */
  degree: number;
}

/** 图谱边（有向：source 链接到 target） */
export interface GraphEdge {
  source: string;
  target: string;
  /** 同一对笔记之间的链接次数 */
  count: number;
}

export interface LinkGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 索引是否因数量上限而不完整 */
  truncated: boolean;
}

/** 节点 id 对应的已有文件条目 */
function nodeFromEntry(entry: NoteEntry): GraphNode {
  return {
    id: pathKey(entry.path),
    kind: entry.isMarkdown ? 'note' : 'file',
    name: entry.isMarkdown ? entry.stem : entry.name,
    path: entry.path,
    relPath: entry.relPath,
    degree: 0,
  };
}

/**
 * 由索引快照与各笔记的双链构建图谱（纯函数，便于测试）。
 * linksBySource 的键为来源笔记的绝对路径。
 */
export function computeLinkGraph(
  snapshot: NoteIndexSnapshot,
  linksBySource: Map<string, WikiLinkOccurrence[]>,
): LinkGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  // 全部 Markdown 笔记都是节点（没有任何链接的为孤立笔记）
  for (const entry of snapshot.entries) {
    if (entry.isMarkdown) nodes.set(pathKey(entry.path), nodeFromEntry(entry));
  }

  for (const [sourcePath, occurrences] of linksBySource) {
    const sourceKey = pathKey(sourcePath);
    const sourceEntry = snapshot.byPathKey.get(sourceKey);
    // 来源不在索引中（仓库外的已打开文档等）：不参与
    if (!sourceEntry || !nodes.has(sourceKey)) continue;
    for (const occurrence of occurrences) {
      const parts = parseWikiLinkInner(occurrence.inner);
      // `[[#标题]]` 指向自身，不构成笔记间关系
      if (!parts.target) continue;
      const resolved = resolveWikiTarget(snapshot, parts.target, sourcePath);
      let targetId: string;
      if (resolved) {
        // 图片嵌入是资源而非笔记关系，不画入图谱
        if (!resolved.isMarkdown && EMBED_IMAGE_EXTENSIONS.has(resolved.ext)) continue;
        targetId = pathKey(resolved.path);
        if (!nodes.has(targetId)) nodes.set(targetId, nodeFromEntry(resolved));
      } else {
        const target = parts.target.trim();
        // 未找到的图片同样忽略（扩展名判断）
        const ext = target.includes('.') ? target.slice(target.lastIndexOf('.') + 1).toLowerCase() : '';
        if (EMBED_IMAGE_EXTENSIONS.has(ext)) continue;
        targetId = `${UNRESOLVED_PREFIX}${target.toLowerCase()}`;
        if (!nodes.has(targetId)) {
          nodes.set(targetId, {
            id: targetId,
            kind: 'unresolved',
            name: target.replace(/\.(md|markdown)$/i, '').split('/').pop() || target,
            path: null,
            relPath: target,
            degree: 0,
          });
        }
      }
      // 链接到自身不画边
      if (targetId === sourceKey) continue;
      const edgeKey = `${sourceKey}\n${targetId}`;
      const edge = edges.get(edgeKey);
      if (edge) edge.count += 1;
      else edges.set(edgeKey, { source: sourceKey, target: targetId, count: 1 });
    }
  }

  // 度数按「相连的笔记数」统计：互相链接的两篇笔记只算一次
  const neighbors = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    let set = neighbors.get(from);
    if (!set) neighbors.set(from, (set = new Set()));
    set.add(to);
  };
  for (const edge of edges.values()) {
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }
  for (const node of nodes.values()) node.degree = neighbors.get(node.id)?.size ?? 0;

  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated: snapshot.truncated };
}

/** 文档所在仓库根；anchorPath 为空时使用资源管理器根 */
export function linkGraphRootOf(anchorPath: string | null): string | null {
  return resolveVaultRoot(anchorPath);
}

/** 收集仓库的完整图谱 */
export async function collectLinkGraph(root: string, signal?: AbortSignal): Promise<LinkGraph | null> {
  const snapshot = await loadNoteIndex(root);
  const sources = snapshot.entries.filter((entry) => entry.isMarkdown);
  const linksBySource = new Map<string, WikiLinkOccurrence[]>();
  for (let start = 0; start < sources.length; start += READ_CONCURRENCY) {
    if (signal?.aborted) return null;
    const batch = sources.slice(start, start + READ_CONCURRENCY);
    const results = await Promise.all(batch.map(readWikiLinks));
    batch.forEach((source, index) => {
      if (results[index].length > 0) linksBySource.set(source.path, results[index]);
    });
  }
  if (signal?.aborted) return null;
  return computeLinkGraph(snapshot, linksBySource);
}

/** 文档路径对应的节点 id */
export function graphNodeIdOf(path: string): string {
  return pathKey(path);
}

/**
 * 以某节点为中心、沿链接（不分方向）展开 depth 层的局部图。
 * 中心节点不在图中（新建后尚未进入索引等）时只返回空图。
 */
export function localSubgraph(graph: LinkGraph, centerId: string, depth: number): LinkGraph {
  if (!graph.nodes.some((node) => node.id === centerId)) {
    return { nodes: [], edges: [], truncated: graph.truncated };
  }
  const adjacency = new Map<string, string[]>();
  const push = (from: string, to: string) => {
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  };
  for (const edge of graph.edges) {
    push(edge.source, edge.target);
    push(edge.target, edge.source);
  }
  // 广度优先展开
  const kept = new Set([centerId]);
  let frontier = [centerId];
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (kept.has(neighbor)) continue;
        kept.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return {
    nodes: graph.nodes.filter((node) => kept.has(node.id)),
    // 保留展开范围内节点之间的全部边（包括外层节点之间的横向关系）
    edges: graph.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
    truncated: graph.truncated,
  };
}

/** 按显示选项过滤：隐藏孤立笔记 / 未创建笔记（focusId 始终保留） */
export function filterLinkGraph(
  graph: LinkGraph,
  options: { orphans: boolean; unresolved: boolean; focusId?: string | null },
): LinkGraph {
  if (options.orphans && options.unresolved) return graph;
  const removed = new Set<string>();
  for (const node of graph.nodes) {
    if (node.id === options.focusId) continue;
    if (!options.unresolved && node.kind === 'unresolved') removed.add(node.id);
  }
  let edges = graph.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
  if (!options.orphans) {
    // 隐藏未创建节点后才判断孤立：只链接到未创建笔记的笔记也视为孤立
    const connected = new Set<string>();
    for (const edge of edges) {
      connected.add(edge.source);
      connected.add(edge.target);
    }
    for (const node of graph.nodes) {
      if (node.id !== options.focusId && !connected.has(node.id)) removed.add(node.id);
    }
    edges = edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
  }
  return { nodes: graph.nodes.filter((node) => !removed.has(node.id)), edges, truncated: graph.truncated };
}
