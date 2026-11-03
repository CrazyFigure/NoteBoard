// NoteBoard 思维导图结构元素：概要（大括号 + 概要主题）/ 外框 / 联系线
// 数据挂在节点上（概要、外框挂父节点并以首尾子节点 id 表示范围；联系线挂起点节点），
// 几何在排版之后按节点实际坐标计算，因此始终跟随节点位置，不随布局切换错位。
// 概要主题是完整节点，可继续挂子节点：排版阶段已度量其子树并在同级方向预留空间，
// 这里按大括号尖端位置定位整棵概要子树。
// 详见 docs/09-开发路线图.md

import type { MindBoundary, MindmapEdgeStyle, MindNode, MindNodeRange, MindPoint, MindRelation, MindSummary } from './mindmapTypes';
import type { LayoutLink, LayoutNode } from './layouts/layoutTypes';
import { buildFont, ellipsizeLine, estimateTextWidth, wrapText, type TextMeasure } from './mindmapTextMeasure';
import { getTopLevelMindNodeIds, walkMindNodes } from './mindmapTree';
import { adjustMarksForTextChange } from './mindmapRichText';
import { placeSummaryTopicTree } from './mindmapLayout';

// ── 数据操作 ──

/** 结构元素种类 */
export type MindStructureKind = 'summary' | 'boundary' | 'relation';

/** 结构元素引用：所属节点 + 元素 id */
export interface MindStructureRef {
  kind: MindStructureKind;
  ownerId: string;
  id: string;
}

/** 结构元素在节点上的字段名 */
const FIELD_OF: Record<MindStructureKind, 'summaries' | 'boundaries' | 'relations'> = {
  summary: 'summaries',
  boundary: 'boundaries',
  relation: 'relations',
};

let nextStructureId = 1;
/** 生成结构元素 id（与节点 id 区分前缀，便于排查） */
export function generateStructureId(kind: MindStructureKind): string {
  return `${kind}-${Date.now()}-${nextStructureId++}`;
}

/** 非空字符串校验 */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 旧版概要只有文字：迁移为概要主题时使用的确定性 id（与 XMind 导出的概要主题 id 一致） */
export function legacySummaryTopicId(summaryId: string): string {
  return `${summaryId}-topic`;
}

/**
 * 反序列化时校验结构元素字段，只保留合法条目；空数组不写回节点
 * @param normalizeTopic 概要主题子树的节点规范化（由解析器提供，与普通节点同一套规则）
 */
export function normalizeNodeStructures(
  source: Partial<MindNode>,
  normalizeTopic: (topic: Partial<MindNode>) => MindNode,
): Pick<MindNode, 'summaries' | 'boundaries' | 'relations'> {
  const result: Pick<MindNode, 'summaries' | 'boundaries' | 'relations'> = {};
  const range = (item: Partial<MindNodeRange> | null | undefined): item is MindNodeRange =>
    Boolean(item) && isText(item!.id) && isText(item!.startId) && isText(item!.endId);
  if (Array.isArray(source.summaries)) {
    const list = (source.summaries as Array<Partial<MindSummary> & { text?: unknown }>)
      .filter((item): item is MindNodeRange & Partial<MindSummary> & { text?: unknown } => range(item))
      .map((item): MindSummary => {
        const raw = item.topic;
        // 新版：概要主题为完整节点；旧版：只有概要文字，迁移为无子节点的概要主题
        const topic = raw && typeof raw === 'object' && typeof raw.text === 'string'
          ? normalizeTopic(raw)
          : { id: legacySummaryTopicId(item.id), text: typeof item.text === 'string' ? item.text : '', isExpanded: true, children: [] };
        return { id: item.id, startId: item.startId, endId: item.endId, topic };
      });
    if (list.length > 0) result.summaries = list;
  }
  if (Array.isArray(source.boundaries)) {
    const list = (source.boundaries.filter(range) as MindBoundary[]).map((item): MindBoundary => {
      const boundary: MindBoundary = { id: item.id, startId: item.startId, endId: item.endId };
      if (isText(item.title)) boundary.title = item.title;
      return boundary;
    });
    if (list.length > 0) result.boundaries = list;
  }
  if (Array.isArray(source.relations)) {
    const list = source.relations
      .filter((item): item is MindRelation => Boolean(item) && isText(item.id) && isText(item.targetId))
      .map((item) => {
        const relation: MindRelation = { id: item.id, targetId: item.targetId };
        if (isText(item.title)) relation.title = item.title;
        if (typeof item.bend === 'number' && Number.isFinite(item.bend)) relation.bend = item.bend;
        const finite = (point: unknown): point is MindPoint => Boolean(point) && Number.isFinite((point as MindPoint).x) && Number.isFinite((point as MindPoint).y);
        if (Array.isArray(item.controls) && item.controls.length === 2 && item.controls.every(finite)) {
          relation.controls = [{ x: item.controls[0].x, y: item.controls[0].y }, { x: item.controls[1].x, y: item.controls[1].y }];
        }
        return relation;
      });
    if (list.length > 0) result.relations = list;
  }
  return result;
}

/** 树访问方式：数据树（MindNode）与排版树（LayoutNode）共用范围解析 */
interface TreeAccess<T> {
  children: (node: T) => readonly T[];
  id: (node: T) => string;
}

const MIND_ACCESS: TreeAccess<MindNode> = { children: (node) => node.children, id: (node) => node.id };
const LAYOUT_ACCESS: TreeAccess<LayoutNode> = { children: (node) => node.children, id: (node) => node.node.id };

/** 后代相对 owner 的层级（直接子节点为 1）；不在子树内返回 -1 */
function depthBelow<T>(owner: T, id: string, access: TreeAccess<T>): number {
  const stack: Array<{ node: T; depth: number }> = [{ node: owner, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > 0 && access.id(node) === id) return depth;
    for (const child of access.children(node)) stack.push({ node: child, depth: depth + 1 });
  }
  return -1;
}

/** owner 下第 depth 层的全部后代及其父节点，按先序排列（即画布上的同层排列顺序） */
function nodesAtDepth<T>(owner: T, depth: number, access: TreeAccess<T>): Array<{ node: T; parent: T }> {
  const result: Array<{ node: T; parent: T }> = [];
  const stack: Array<{ node: T; parent: T; depth: number }> = [];
  const children = access.children(owner);
  for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ node: children[i], parent: owner, depth: 1 });
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.depth === depth) {
      result.push({ node: item.node, parent: item.parent });
      continue;
    }
    const next = access.children(item.node);
    for (let i = next.length - 1; i >= 0; i -= 1) stack.push({ node: next[i], parent: item.node, depth: item.depth + 1 });
  }
  return result;
}

/**
 * 解析范围覆盖的节点（含父节点）：首尾可以是同父子节点，也可以是 owner 下同一层级、父节点不同的后代，
 * 此时覆盖两者之间（先序）的全部同层节点。首尾之一失效或层级不再一致时退化为仍有效的一端；都失效返回 null
 */
function resolveRangeEntries<T>(owner: T, range: Pick<MindNodeRange, 'startId' | 'endId'>, access: TreeAccess<T>): Array<{ node: T; parent: T }> | null {
  // 同父范围（最常见）直接按子节点下标截取，免去整棵子树遍历
  const children = access.children(owner);
  const start = children.findIndex((child) => access.id(child) === range.startId);
  const end = children.findIndex((child) => access.id(child) === range.endId);
  if (start >= 0 && end >= 0) {
    const [lo, hi] = start <= end ? [start, end] : [end, start];
    return children.slice(lo, hi + 1).map((node) => ({ node, parent: owner }));
  }
  const startDepth = depthBelow(owner, range.startId, access);
  const endDepth = depthBelow(owner, range.endId, access);
  if (startDepth < 0 && endDepth < 0) return null;
  const depth = startDepth >= 0 ? startDepth : endDepth;
  const level = nodesAtDepth(owner, depth, access);
  const startIndex = level.findIndex((item) => access.id(item.node) === range.startId);
  const endIndex = endDepth === depth ? level.findIndex((item) => access.id(item.node) === range.endId) : -1;
  if (startIndex < 0) return [level[endIndex]];
  if (endIndex < 0) return [level[startIndex]];
  const [lo, hi] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
  return level.slice(lo, hi + 1);
}

/** 范围覆盖的节点（先序）；全部失效时返回 null */
export function resolveRangeNodes(owner: MindNode, range: Pick<MindNodeRange, 'startId' | 'endId'>): MindNode[] | null {
  return resolveRangeEntries(owner, range, MIND_ACCESS)?.map((item) => item.node) ?? null;
}

/** 后代所在的 owner 直接子节点下标（自身为直接子节点时即其下标） */
function topChildIndex(owner: MindNode, id: string): number {
  return owner.children.findIndex((child) => child.id === id || depthBelow(child, id, MIND_ACCESS) > 0);
}

/**
 * 解析范围在父节点子数组中的下标区间
 * 首尾节点之一被移走时退化为仅剩的一端；两端都不在时返回 null（视为失效）。
 * 跨父节点的同层范围提升为包含首尾节点的子节点区间（XMind 只支持同父范围，导出时据此降级）
 */
export function resolveRangeIndexes(parent: MindNode, range: Pick<MindNodeRange, 'startId' | 'endId'>): [number, number] | null {
  const covered = resolveRangeNodes(parent, range);
  if (!covered) return null;
  return [topChildIndex(parent, covered[0].id), topChildIndex(parent, covered[covered.length - 1].id)];
}

/**
 * 清理失效引用（原地修改）：范围两端都已不在父节点下的概要 / 外框、
 * 目标节点已删除或指向自身的联系线一并移除。用于解析文件与导入之后。
 */
export function pruneMindmapStructures(root: MindNode): void {
  const ids = new Set<string>();
  let hasRelations = false;
  for (const node of walkMindNodes(root)) {
    ids.add(node.id);
    if (node.relations) hasRelations = true;
  }
  for (const node of walkMindNodes(root)) {
    if (node.summaries) {
      node.summaries = node.summaries.filter((item) => resolveRangeNodes(node, item));
      if (node.summaries.length === 0) delete node.summaries;
    }
    if (node.boundaries) {
      node.boundaries = node.boundaries.filter((item) => resolveRangeNodes(node, item));
      if (node.boundaries.length === 0) delete node.boundaries;
    }
    if (hasRelations && node.relations) {
      node.relations = node.relations.filter((item) => item.targetId !== node.id && ids.has(item.targetId));
      if (node.relations.length === 0) delete node.relations;
    }
  }
}

/** 选中节点能否挂概要 / 外框：求出共同父节点与首尾子节点 */
export type SiblingRangeResult =
  | { ok: true; parentId: string; startId: string; endId: string }
  | { ok: false; reason: string };

/**
 * 选中项无法按同层规则概括时（层级不同、含概要主题、分属主树与概要子树），提升到共同上级再概括：
 * 逐级上溯到全部选中项的最近共同上级，概括该上级下包含它们的连续子节点
 * （例如分属两个一级分支时，概括这两个一级分支）。
 * 概要主题自成一棵子树，不在所属节点的 children 中：视作挂在所属节点下、占据其所概括的那段子节点的位置。
 * @param always false 时只处理涉及概要子树的选择，其余返回 null 交由同层规则处理
 */
function liftRangeToCommonAncestor(root: MindNode, ids: readonly string[], always: boolean): SiblingRangeResult | null {
  const selected = new Set(ids);
  if (selected.size === 0 || selected.has(root.id)) return null;
  // 每个节点的上级：普通子节点为父节点及自身下标；概要主题为所属节点及所概括子节点的下标区间
  const upOf = new Map<string, { parent: MindNode; lo: number; hi: number }>();
  // 节点所在的树：主树记根节点 id，概要子树记概要主题 id
  const treeOf = new Map<string, string>();
  const topicIds = new Set<string>();
  const stack: Array<{ node: MindNode; tree: string }> = [{ node: root, tree: root.id }];
  while (stack.length > 0) {
    const { node, tree } = stack.pop()!;
    treeOf.set(node.id, tree);
    const summaries = node.summaries ?? [];
    for (let i = summaries.length - 1; i >= 0; i -= 1) {
      const topic = summaries[i]?.topic;
      const indexes = topic ? resolveRangeIndexes(node, summaries[i]) : null;
      if (!topic || !indexes) continue;
      upOf.set(topic.id, { parent: node, lo: Math.min(indexes[0], indexes[1]), hi: Math.max(indexes[0], indexes[1]) });
      topicIds.add(topic.id);
      stack.push({ node: topic, tree: topic.id });
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      upOf.set(node.children[i].id, { parent: node, lo: i, hi: i });
      stack.push({ node: node.children[i], tree });
    }
  }
  /** 从根节点到直接上级的上溯链（经概要主题时跨到所属节点） */
  const chainOf = (id: string): MindNode[] => {
    const chain: MindNode[] = [];
    for (let up = upOf.get(id); up; up = upOf.get(up.parent.id)) chain.push(up.parent);
    return chain.reverse();
  };
  // 只保留「顶层」选中项：上溯链中已有选中节点的随祖先一起被概括
  const items: Array<{ id: string; chain: MindNode[] }> = [];
  for (const id of selected) {
    if (!upOf.has(id)) continue;
    const chain = chainOf(id);
    if (!chain.some((node) => selected.has(node.id))) items.push({ id, chain });
  }
  if (items.length === 0) return null;
  const crossesTrees = new Set(items.map((item) => treeOf.get(item.id))).size > 1;
  if (!always && !crossesTrees && !items.some((item) => topicIds.has(item.id))) return null;
  // 最近共同上级：各上溯链的最长公共前缀的末端（链首都是根节点）
  let common = items[0].chain.length;
  for (const item of items) {
    let k = 0;
    while (k < common && k < item.chain.length && item.chain[k] === items[0].chain[k]) k += 1;
    common = k;
  }
  const owner = items[0].chain[common - 1];
  // 每个选中项在共同上级下占据的子节点区间，合并为一段连续范围
  let lo = Infinity;
  let hi = -Infinity;
  for (const item of items) {
    const up = upOf.get(item.chain.length === common ? item.id : item.chain[common].id)!;
    lo = Math.min(lo, up.lo);
    hi = Math.max(hi, up.hi);
  }
  return { ok: true, parentId: owner.id, startId: owner.children[lo].id, endId: owner.children[hi].id };
}

/**
 * 由选中节点求出连续的同层范围（中间未选中的同层节点一并纳入，与 XMind 一致）。
 * 同父时挂在父节点上；父节点不同但层级相同时挂在最近共同祖先上，只覆盖选中层级，不含中间的父节点；
 * 层级不同时提升到最近共同上级，概括其下包含选中项的连续子节点
 */
export function getSiblingRangeForSelection(root: MindNode, ids: Iterable<string>): SiblingRangeResult {
  const selected = [...ids];
  // 选中概要主题，或选中项分属主树与概要子树（不在同一棵树里）时，提升到共同上级再概括
  const lifted = liftRangeToCommonAncestor(root, selected, false);
  if (lifted) return lifted;
  const sameLevelError: SiblingRangeResult = { ok: false, reason: '请选择同一层级的节点' };
  // 顶层 id 已按先序排列，首尾即范围两端（根节点与概要主题不会出现在其中）
  const topIds = getTopLevelMindNodeIds(root, selected);
  if (topIds.length === 0) return { ok: false, reason: '中心主题不能添加' };
  const parentOf = new Map<string, MindNode>();
  const depthOf = new Map<string, number>();
  const stack: Array<{ node: MindNode; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    depthOf.set(node.id, depth);
    for (const child of node.children) {
      parentOf.set(child.id, node);
      stack.push({ node: child, depth: depth + 1 });
    }
    // 概要主题自成一棵子树（不记父节点），层级按所属节点的下一层计
    for (const summary of node.summaries ?? []) stack.push({ node: summary.topic, depth: depth + 1 });
  }
  if (topIds.some((id) => !parentOf.has(id))) return { ok: false, reason: '节点不存在' };
  const depth = depthOf.get(topIds[0]);
  // 层级不同：提升到共同上级概括
  if (topIds.some((id) => depthOf.get(id) !== depth)) return liftRangeToCommonAncestor(root, selected, true) ?? sameLevelError;
  // 同层节点逐级上溯直到汇合：同父时第一步即汇合于父节点（跨树的选择已在前面提升处理）
  let ancestors = topIds.map((id) => parentOf.get(id)!);
  while (ancestors.some((node) => node !== ancestors[0])) {
    const next = ancestors.map((node) => parentOf.get(node.id));
    if (next.some((node) => !node)) return liftRangeToCommonAncestor(root, selected, true) ?? sameLevelError;
    ancestors = next as MindNode[];
  }
  return { ok: true, parentId: ancestors[0].id, startId: topIds[0], endId: topIds[topIds.length - 1] };
}

/** 读取结构元素（找不到返回 null） */
export function findStructure(owner: MindNode | null, ref: Pick<MindStructureRef, 'kind' | 'id'>): MindSummary | MindBoundary | MindRelation | null {
  const list = owner?.[FIELD_OF[ref.kind]] as Array<{ id: string }> | undefined;
  return (list?.find((item) => item.id === ref.id) as MindSummary | MindBoundary | MindRelation | undefined) ?? null;
}

/** 删除结构元素（原地修改所属节点），返回是否删除成功 */
export function removeStructure(owner: MindNode, ref: Pick<MindStructureRef, 'kind' | 'id'>): boolean {
  const field = FIELD_OF[ref.kind];
  const list = owner[field] as Array<{ id: string }> | undefined;
  if (!list) return false;
  const next = list.filter((item) => item.id !== ref.id);
  if (next.length === list.length) return false;
  if (next.length > 0) (owner as unknown as Record<string, unknown>)[field] = next;
  else delete owner[field];
  return true;
}

/** 改写结构元素的文字（概要主题标题 / 外框标题 / 联系线说明），原地修改；空标题移除字段 */
export function setStructureText(owner: MindNode, ref: Pick<MindStructureRef, 'kind' | 'id'>, text: string): boolean {
  const item = findStructure(owner, ref);
  if (!item) return false;
  if (ref.kind === 'summary') {
    const topic = (item as MindSummary).topic;
    // 标题富文本格式随文字变化平移，避免区间越界
    const marks = adjustMarksForTextChange(topic.text, text, topic.marks);
    topic.text = text;
    if (marks && marks.length > 0) topic.marks = marks;
    else delete topic.marks;
  } else if (text) (item as MindBoundary | MindRelation).title = text;
  else delete (item as MindBoundary | MindRelation).title;
  return true;
}

/** 结构元素当前文字 */
export function getStructureText(item: MindSummary | MindBoundary | MindRelation, kind: MindStructureKind): string {
  return kind === 'summary' ? (item as MindSummary).topic.text : (item as MindBoundary | MindRelation).title ?? '';
}

// ── 几何计算 ──

/** 概要大括号与内容的间距、括号深度（括号尖端到概要主题的间距见 SUMMARY_TOPIC_GAP） */
export const SUMMARY_GAP = 10;
export const BRACE_DEPTH = 14;
/** 外框内边距与标题排版 */
export const BOUNDARY_PADDING = 8;
export const BOUNDARY_TITLE_FONT_SIZE = 11;
export const BOUNDARY_TITLE_HEIGHT = 18;
const BOUNDARY_TITLE_PAD_X = 7;
/** 联系线说明文字排版 */
export const RELATION_FONT_SIZE = 12;
export const RELATION_LINE_HEIGHT = 16;
const RELATION_PAD_X = 6;
const RELATION_PAD_Y = 2;
const RELATION_MAX_TEXT_WIDTH = 160;
/** 联系线箭头尺寸 */
const ARROW_LENGTH = 10;
const ARROW_HALF_WIDTH = 5;

/** 新建概要时概要主题的默认标题 */
export const SUMMARY_PLACEHOLDER = '概要';

type Point = MindPoint;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 概要所在侧：内容向哪一侧延伸，大括号就开在哪一侧 */
export type StructureSide = 'left' | 'right' | 'top' | 'bottom';

export interface LayoutSummary {
  ownerId: string;
  id: string;
  /** 概要主题节点 id */
  topicId: string;
  side: StructureSide;
  /** 所覆盖首个子节点的分支配色序号 */
  branchIndex: number;
  /** 大括号路径 */
  bracePath: string;
  /** 概要主题节点框（工具条、范围手柄等的定位参照） */
  label: Rect;
  /** 大括号两端（拖动可扩大 / 缩小覆盖范围） */
  handles: [Point, Point];
}

export interface LayoutBoundary {
  ownerId: string;
  id: string;
  title?: string;
  branchIndex: number;
  /** 外框外接矩形；同父范围即外框本身 */
  rect: Rect;
  /** 跨父范围的阶梯形轮廓（可能含多段子路径）；为空时按 rect 画圆角矩形 */
  path?: string;
  /** 标题与标题输入框的左上锚点（首段外框左上角内缩处） */
  titleAnchor: Point;
  /** 标题标签（无标题时为空） */
  titleBox?: Rect;
  titleText?: string;
  side: StructureSide;
  /** 外框沿同级排列方向的两端（拖动可扩大 / 缩小覆盖范围） */
  handles: [Point, Point];
}

export interface LayoutRelation {
  ownerId: string;
  id: string;
  title?: string;
  path: string;
  arrowPath: string;
  /** 曲线中点（说明文字位置） */
  mid: Point;
  /** 起点 / 终点节点中心 */
  c1: Point;
  c2: Point;
  /** 曲线两端（节点边框上）与两个控制点 */
  p1: Point;
  p2: Point;
  cp1: Point;
  cp2: Point;
  labelBox?: Rect;
  lines: string[];
  /** 包围盒（含控制点，用于视口与导出范围） */
  bounds: Rect;
}

export interface MindmapStructureLayout {
  summaries: LayoutSummary[];
  boundaries: LayoutBoundary[];
  relations: LayoutRelation[];
  /** 已定位的概要主题及其子孙节点（与排版结果的节点一同渲染） */
  nodes: LayoutNode[];
  /** 概要子树内部的父子连线 */
  links: LayoutLink[];
  /** 全部结构元素（含概要子树）的外接矩形；没有元素时为 null */
  bounds: Rect | null;
}

/** 概要 / 外框的目标范围；ownerId 为空表示仍挂在当前所属节点上 */
export interface RangeTarget extends Pick<MindNodeRange, 'startId' | 'endId'> {
  ownerId?: string;
}

export interface StructureLayoutOptions {
  measure?: TextMeasure;
  fontFamily?: string;
  /** 概要子树的连线样式（与主树一致） */
  edgeStyle?: MindmapEdgeStyle;
  /** 临时控制点覆盖（拖动联系线控制点时的实时预览，偏移相对两端节点中心） */
  controlOverrides?: ReadonlyMap<string, [Point, Point]>;
  /** 临时范围覆盖（拖动概要 / 外框端点时的实时预览）；ownerId 不同于当前所属节点时表示换挂到该节点 */
  rangeOverrides?: ReadonlyMap<string, RangeTarget>;
}

/** 保留两位小数 */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function union(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function nodeRect(n: LayoutNode): Rect {
  return { x: n.x, y: n.y, width: n.width, height: n.height };
}

/**
 * 大括号路径：沿 u 轴从 u0 到 u1，开口朝 v 正方向，尖端在中点深度 depth 处
 * @param toWorld 局部 (u, v) → 世界坐标
 */
export function bracePath(u0: number, u1: number, depth: number, toWorld: (u: number, v: number) => [number, number]): string {
  const m = (u0 + u1) / 2;
  const h = depth / 2;
  const r = Math.max(0, Math.min(6, (u1 - u0) / 4));
  const p = (u: number, v: number) => {
    const [x, y] = toWorld(u, v);
    return `${fmt(x)} ${fmt(y)}`;
  };
  return [
    `M ${p(u0, 0)}`,
    `Q ${p(u0, h)} ${p(u0 + r, h)}`,
    `L ${p(m - r, h)}`,
    `Q ${p(m, h)} ${p(m, depth)}`,
    `Q ${p(m, h)} ${p(m + r, h)}`,
    `L ${p(u1 - r, h)}`,
    `Q ${p(u1, h)} ${p(u1, 0)}`,
  ].join(' ');
}

/** 子节点相对父节点的延伸侧：同级纵排时看自由边，横排时看上下 */
export function sideOf(parent: LayoutNode, child: LayoutNode): StructureSide {
  if (child.siblingFlow === 'down') return child.freeEdge;
  return child.y + child.height / 2 >= parent.y + parent.height / 2 ? 'bottom' : 'top';
}

/** 按最大宽度断行，返回行文字与实际最大行宽 */
function wrapLabel(text: string, maxWidth: number, measure: TextMeasure, font: string): { lines: string[]; width: number } {
  const lines = wrapText(text, maxWidth, measure, font).map((line) => line.text);
  let width = 0;
  for (const line of lines) width = Math.max(width, measure(line, font));
  return { lines, width: Math.ceil(width) };
}

/** 从节点中心朝 toward 方向射出，与节点边框（外扩 pad）的交点 */
function boxExit(n: LayoutNode, toward: { x: number; y: number }, pad = 3): { x: number; y: number } {
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return { x: cx, y: cy };
  const hw = n.width / 2 + pad;
  const hh = n.height / 2 + pad;
  const t = Math.min(Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Infinity);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** 联系线默认弯曲量：随两端距离增大，限制在合理区间 */
export function defaultRelationBend(distance: number): number {
  return Math.min(140, Math.max(30, distance * 0.25));
}

/**
 * 自动弯曲：依次尝试两侧、逐级加大的弯曲量，选第一条不穿过其他节点的曲线；
 * 都会穿过时取穿过最少的一条。仅用于未手动调整过弯曲的联系线。
 */
function pickAutoBend(
  nodes: readonly LayoutNode[],
  source: LayoutNode,
  target: LayoutNode,
  distance: number,
  geometry: (bend: number) => { cp1: Point; cp2: Point; p1: Point; p2: Point; mid: Point },
  /** 说明文字框的半宽 / 半高（无文字时为 0） */
  labelHalf: { x: number; y: number },
): number {
  const base = defaultRelationBend(distance);
  const candidates = [base, -base, base * 2, -base * 2, base * 3, -base * 3];
  // 只检查可能与候选曲线相交的节点：两端中心外扩最大弯曲量
  const reach = base * 3 + 24;
  const left = Math.min(source.x, target.x) - reach;
  const right = Math.max(source.x + source.width, target.x + target.width) + reach;
  const top = Math.min(source.y, target.y) - reach;
  const bottom = Math.max(source.y + source.height, target.y + target.height) + reach;
  const obstacles = nodes.filter((n) => n !== source && n !== target
    && n.x < right && n.x + n.width > left && n.y < bottom && n.y + n.height > top);
  if (obstacles.length === 0) return base;
  const pad = 4;
  const hits = (p: Point) => obstacles.some((n) => p.x > n.x - pad && p.x < n.x + n.width + pad && p.y > n.y - pad && p.y < n.y + n.height + pad);
  let best = base;
  let bestHits = Infinity;
  for (const bend of candidates) {
    const { cp1, cp2, p1, p2, mid } = geometry(bend);
    let count = 0;
    // 说明文字框四角
    if (labelHalf.x > 0) {
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        if (hits({ x: mid.x + sx * labelHalf.x, y: mid.y + sy * labelHalf.y })) count += 1;
      }
    }
    // 沿曲线采样（含说明文字所在的中点）
    for (let i = 1; i < 16; i += 1) {
      const t = i / 16;
      const u = 1 - t;
      const point = {
        x: u * u * u * p1.x + 3 * u * u * t * cp1.x + 3 * u * t * t * cp2.x + t * t * t * p2.x,
        y: u * u * u * p1.y + 3 * u * u * t * cp1.y + 3 * u * t * t * cp2.y + t * t * t * p2.y,
      };
      if (hits(point)) count += 1;
    }
    if (count === 0) return bend;
    if (count < bestHits) {
      best = bend;
      bestHits = count;
    }
  }
  return best;
}

/**
 * 圆角多边形路径：去掉重合与共线顶点后，每个拐角以二次曲线倒圆（凹角同样适用），
 * 半径不超过相邻边长的一半
 */
function roundedPolygonPath(points: readonly Point[], radius: number): string {
  const pts: Point[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.01 || Math.abs(last.y - p.y) > 0.01) pts.push(p);
  }
  if (pts.length > 1 && Math.abs(pts[0].x - pts[pts.length - 1].x) <= 0.01 && Math.abs(pts[0].y - pts[pts.length - 1].y) <= 0.01) pts.pop();
  // 共线点（同一直线上的中间点）不形成拐角
  const corners = pts.filter((p, i) => {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const next = pts[(i + 1) % pts.length];
    return Math.abs((p.x - prev.x) * (next.y - p.y) - (p.y - prev.y) * (next.x - p.x)) > 0.01;
  });
  const n = corners.length;
  let d = '';
  corners.forEach((cur, i) => {
    const prev = corners[(i - 1 + n) % n];
    const next = corners[(i + 1) % n];
    const lp = Math.hypot(prev.x - cur.x, prev.y - cur.y);
    const ln = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, lp / 2, ln / 2);
    const a = { x: cur.x + ((prev.x - cur.x) / lp) * r, y: cur.y + ((prev.y - cur.y) / lp) * r };
    const b = { x: cur.x + ((next.x - cur.x) / ln) * r, y: cur.y + ((next.y - cur.y) / ln) * r };
    d += `${i === 0 ? 'M' : ' L'} ${fmt(a.x)} ${fmt(a.y)} Q ${fmt(cur.x)} ${fmt(cur.y)} ${fmt(b.x)} ${fmt(b.y)}`;
  });
  return `${d} Z`;
}

/**
 * 一组沿同级排列方向相接的外框段 → 阶梯形轮廓顶点：相邻两段在间隙中点处衔接，
 * 两侧边按各段自身的横向范围形成台阶
 * @param vertical 同级纵排（段沿 y 方向排列）
 */
function steppedOutline(pieces: readonly Rect[], vertical: boolean): Point[] {
  // 统一到 (u 沿排列方向, v 横向) 坐标计算，最后换回世界坐标
  const spans = pieces.map((r) => vertical
    ? { u0: r.y, u1: r.y + r.height, v0: r.x, v1: r.x + r.width }
    : { u0: r.x, u1: r.x + r.width, v0: r.y, v1: r.y + r.height });
  const cuts = spans.slice(0, -1).map((s, i) => (s.u1 + spans[i + 1].u0) / 2);
  const uv: Array<[number, number]> = [[spans[0].u0, spans[0].v0], [spans[0].u0, spans[0].v1]];
  cuts.forEach((cut, i) => uv.push([cut, spans[i].v1], [cut, spans[i + 1].v1]));
  const last = spans[spans.length - 1];
  uv.push([last.u1, last.v1], [last.u1, last.v0]);
  for (let i = cuts.length - 1; i >= 0; i -= 1) uv.push([cuts[i], spans[i + 1].v0], [cuts[i], spans[i].v0]);
  return uv.map(([u, v]) => (vertical ? { x: v, y: u } : { x: u, y: v }));
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 概要子树与其他节点之间至少保留的间距 */
const SUMMARY_CLEARANCE = 4;
/** 概要子树避让时单步移动量与最大移动量 */
const SUMMARY_SHIFT_STEP = 6;
const SUMMARY_SHIFT_LIMIT = 240;

/**
 * 概要子树沿同级方向（vertical 为 y 方向，否则 x 方向）需要的最小偏移，使其不压住其他节点；
 * 原位不冲突返回 0，找不到无冲突位置时也返回 0（保持贴着大括号）
 */
function findClearShift(placed: readonly LayoutNode[], others: readonly LayoutNode[], vertical: boolean): number {
  if (placed.length === 0) return 0;
  let box: Rect | null = null;
  for (const n of placed) box = union(box, nodeRect(n));
  // 只考虑可能进入移动范围内的节点
  const reach = SUMMARY_SHIFT_LIMIT + SUMMARY_CLEARANCE;
  const band: Rect = vertical
    ? { x: box!.x - SUMMARY_CLEARANCE, y: box!.y - reach, width: box!.width + SUMMARY_CLEARANCE * 2, height: box!.height + reach * 2 }
    : { x: box!.x - reach, y: box!.y - SUMMARY_CLEARANCE, width: box!.width + reach * 2, height: box!.height + SUMMARY_CLEARANCE * 2 };
  const obstacles = others.filter((n) => intersects(nodeRect(n), band));
  if (obstacles.length === 0) return 0;
  const collides = (shift: number) => placed.some((p) => {
    const r: Rect = {
      x: p.x + (vertical ? 0 : shift) - SUMMARY_CLEARANCE,
      y: p.y + (vertical ? shift : 0) - SUMMARY_CLEARANCE,
      width: p.width + SUMMARY_CLEARANCE * 2,
      height: p.height + SUMMARY_CLEARANCE * 2,
    };
    return obstacles.some((o) => intersects(r, nodeRect(o)));
  });
  if (!collides(0)) return 0;
  for (let step = SUMMARY_SHIFT_STEP; step <= SUMMARY_SHIFT_LIMIT; step += SUMMARY_SHIFT_STEP) {
    if (!collides(-step)) return -step;
    if (!collides(step)) return step;
  }
  return 0;
}

/** 子树（含自身）沿同级排列方向的覆盖区间 */
function subtreeSpan(root: LayoutNode, vertical: boolean): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    lo = Math.min(lo, vertical ? n.y : n.x);
    hi = Math.max(hi, vertical ? n.y + n.height : n.x + n.width);
    for (const child of n.children) stack.push(child);
  }
  return [lo, hi];
}

/**
 * 拖动概要 / 外框某一端时的固定端：首尾两个子节点中离被拖手柄较远的那个
 * （与布局方向无关，鱼骨图等反向排列时同样成立）
 */
export function rangeFixedEndId(owner: LayoutNode, range: Pick<MindNodeRange, 'startId' | 'endId'>, handle: Point): string {
  // 首尾可能是跨父节点的同层后代，按范围解析结果取两端
  const covered = resolveRangeEntries(owner, range, LAYOUT_ACCESS);
  const start = covered?.find((item) => item.node.node.id === range.startId)?.node;
  const end = covered?.find((item) => item.node.node.id === range.endId)?.node;
  if (!start || !end) return (start ?? end)?.node.id ?? range.startId;
  const distance = (n: LayoutNode) => Math.hypot(n.x + n.width / 2 - handle.x, n.y + n.height / 2 - handle.y);
  return distance(start) >= distance(end) ? start.node.id : end.node.id;
}

/**
 * 拖动概要 / 外框端点：在整棵树（treeRoot，主树或所在的概要子树）中与固定端同层、同侧的节点里，
 * 沿同级排列方向找指针所在（或最近）的子树，返回固定端与它之间的新范围。
 * 新端点仍在 owner 下时所属节点不变；拖到 owner 之外的同层节点（如相邻分支的子节点）时，
 * 改挂到两端的最近共同祖先上，成为跨父节点的同层范围
 */
export function dragRangeEnd(owner: LayoutNode, fixedId: string, point: Point, treeRoot: LayoutNode = owner): Required<RangeTarget> | null {
  const ownerDepth = depthBelow(owner, fixedId, LAYOUT_ACCESS);
  if (ownerDepth < 0) return null;
  const rootDepth = treeRoot === owner ? ownerDepth : depthBelow(treeRoot, fixedId, LAYOUT_ACCESS);
  // treeRoot 不含 owner 时退回只在 owner 下伸缩
  const scope = rootDepth < 0 ? owner : treeRoot;
  const depth = rootDepth < 0 ? ownerDepth : rootDepth;
  const level = nodesAtDepth(scope, depth, LAYOUT_ACCESS);
  const a = level.findIndex((item) => item.node.node.id === fixedId);
  const fixed = level[a];
  const side = sideOf(fixed.parent, fixed.node);
  const vertical = side === 'left' || side === 'right';
  const value = vertical ? point.y : point.x;
  let b = a;
  let bestDistance = Infinity;
  level.forEach((item, index) => {
    if (sideOf(item.parent, item.node) !== side) return;
    const [lo, hi] = subtreeSpan(item.node, vertical);
    const distance = value < lo ? lo - value : value > hi ? value - hi : 0;
    if (distance < bestDistance) {
      b = index;
      bestDistance = distance;
    }
  });
  const best = level[b].node;
  const range = a <= b ? { startId: fixed.node.node.id, endId: best.node.id } : { startId: best.node.id, endId: fixed.node.node.id };
  // 新端点与固定端相对 owner 同层：仍挂在 owner 上（保持原有的跨父范围不被收窄成同父）
  if (scope === owner || depthBelow(owner, best.node.id, LAYOUT_ACCESS) === ownerDepth) return { ownerId: owner.node.id, ...range };
  return { ownerId: lowestCommonAncestor(scope, fixed.node.node.id, best.node.id)?.node.id ?? owner.node.id, ...range };
}

/** 排版节点所在的树根：主树根节点，或其所在概要子树的概要主题 */
export function layoutTreeRootOf(nodes: readonly LayoutNode[], target: LayoutNode): LayoutNode {
  return nodes.find((n) => (n.level === 0 || n.summaryOf) && (n === target || depthBelow(n, target.node.id, LAYOUT_ACCESS) > 0)) ?? target;
}

/** 树中两个节点的最近共同祖先（不含两者自身）；找不到返回 null */
function lowestCommonAncestor(treeRoot: LayoutNode, a: string, b: string): LayoutNode | null {
  const parentOf = new Map<LayoutNode, LayoutNode>();
  const byId = new Map<string, LayoutNode>();
  const stack = [treeRoot];
  while (stack.length > 0) {
    const n = stack.pop()!;
    byId.set(n.node.id, n);
    for (const child of n.children) {
      parentOf.set(child, n);
      stack.push(child);
    }
  }
  const ancestors = new Set<LayoutNode>();
  for (let cur = byId.get(a) && parentOf.get(byId.get(a)!); cur; cur = parentOf.get(cur)) ancestors.add(cur);
  for (let cur = byId.get(b) && parentOf.get(byId.get(b)!); cur; cur = parentOf.get(cur)) if (ancestors.has(cur)) return cur;
  return null;
}

/**
 * 计算全部结构元素的几何：只处理已排版（展开可见）的节点，
 * 外框与概要自内向外累加，嵌套时外层自动让出内层的空间
 */
export function computeMindmapStructures(nodes: readonly LayoutNode[], options: StructureLayoutOptions = {}): MindmapStructureLayout {
  const measure = options.measure ?? estimateTextWidth;
  const family = options.fontFamily ?? '';
  const edgeStyle = options.edgeStyle ?? 'curve';
  const titleFont = buildFont(BOUNDARY_TITLE_FONT_SIZE, 500, family);
  const relationFont = buildFont(RELATION_FONT_SIZE, 400, family);
  const result: MindmapStructureLayout = { summaries: [], boundaries: [], relations: [], nodes: [], links: [], bounds: null };
  const root = nodes.find((n) => n.level === 0);
  if (!root) return result;
  // 主树节点 + 已定位的概要子树节点（外框间隙判定与联系线都要算上概要子树）
  const allNodes: LayoutNode[] = [...nodes];

  /** 节点及其全部子孙（跨父外框判定间隙中是否夹着其他节点时排除） */
  const collectSubtrees = (tops: readonly LayoutNode[]): Set<LayoutNode> => {
    const set = new Set<LayoutNode>();
    const pending = [...tops];
    while (pending.length > 0) {
      const n = pending.pop()!;
      set.add(n);
      pending.push(...n.children);
    }
    return set;
  };

  // 拖动端点预览：覆盖里带 ownerId 且不同于当前所属节点的概要 / 外框，视为换挂到该节点
  const movedFrom = new Map<string, string>();
  const movedIn = new Map<string, { summaries: MindSummary[]; boundaries: MindBoundary[] }>();
  const movedTopics = new Map<string, LayoutNode>();
  const overrides = options.rangeOverrides;
  if (overrides && [...overrides.values()].some((item) => item.ownerId)) {
    for (const dataNode of walkMindNodes(root.node)) {
      const collect = (list: ReadonlyArray<MindSummary | MindBoundary> | undefined, kind: 'summaries' | 'boundaries') => {
        for (const item of list ?? []) {
          const ownerId = overrides.get(item.id)?.ownerId;
          if (!ownerId || ownerId === dataNode.id) continue;
          movedFrom.set(item.id, dataNode.id);
          if (!movedIn.has(ownerId)) movedIn.set(ownerId, { summaries: [], boundaries: [] });
          (movedIn.get(ownerId)![kind] as Array<MindSummary | MindBoundary>).push(item);
        }
      };
      collect(dataNode.summaries, 'summaries');
      collect(dataNode.boundaries, 'boundaries');
    }
  }
  const movedAway = (ownerId: string, id: string) => movedFrom.get(id) === ownerId;
  /** 节点上实际参与排版的条目：去掉换挂走的，追加换挂进来的 */
  const withMoved = <T extends MindNodeRange>(ownerId: string, list: readonly T[] | undefined, moved: readonly T[] | undefined): T[] => {
    const kept = movedFrom.size > 0 ? (list ?? []).filter((item) => !movedAway(ownerId, item.id)) : [...(list ?? [])];
    return moved ? kept.concat(moved) : kept;
  };

  // 每个节点「含子树与其上结构元素」的外接矩形
  const extent = new Map<LayoutNode, Rect>();
  // 已排好的外框（含标题）/ 概要（含大括号与概要子树）及其覆盖节点：外层外框 / 概要据此让出内层（后序保证内层先算）
  const boundaryRects: Array<{ owner: LayoutNode; children: Set<LayoutNode>; rect: Rect }> = [];

  /**
   * 后序处理一棵树（主树或某棵概要子树）上的外框与概要，返回树根「含子树与结构元素」的外接矩形。
   * 概要子树在所属概要定位后递归处理，其中的外框 / 概要同样生效
   */
  const processTree = (treeRoot: LayoutNode): Rect => {
  // 显式栈先序遍历，逆序即为子节点先于父节点的后序
  const order: LayoutNode[] = [];
  const stack = [treeRoot];
  while (stack.length > 0) {
    const n = stack.pop()!;
    order.push(n);
    for (let i = n.children.length - 1; i >= 0; i -= 1) stack.push(n.children[i]);
  }
  for (let oi = order.length - 1; oi >= 0; oi -= 1) {
    const n = order[oi];
    let rect = nodeRect(n);
    for (const child of n.children) rect = union(rect, extent.get(child)!);
    const node = n.node;
    // 拖动端点预览中换挂了所属节点的概要 / 外框：从原节点移走，挂到新节点上（新节点是原节点的祖先，后序保证原节点先处理）
    const boundaryList = withMoved(node.id, node.boundaries, movedIn.get(node.id)?.boundaries);
    const summaryList = withMoved(node.id, node.summaries, movedIn.get(node.id)?.summaries);
    for (const summary of node.summaries ?? []) {
      if (movedAway(node.id, summary.id)) {
        const measuredTopic = n.summaryTopics?.get(summary.id);
        if (measuredTopic) movedTopics.set(summary.id, measuredTopic);
      }
    }
    if (n.children.length > 0 && (boundaryList.length > 0 || summaryList.length > 0)) {
      /** 范围内与首个节点同侧的节点（双向图根节点两侧分开），按父节点分成连续的段 */
      const covered = (range: MindNodeRange): { side: StructureSide; children: LayoutNode[]; runs: LayoutNode[][] } | null => {
        const entries = resolveRangeEntries(n, options.rangeOverrides?.get(range.id) ?? range, LAYOUT_ACCESS);
        if (!entries || entries.length === 0) return null;
        const side = sideOf(entries[0].parent, entries[0].node);
        const runs: LayoutNode[][] = [];
        let lastParent: LayoutNode | null = null;
        for (const entry of entries) {
          if (sideOf(entry.parent, entry.node) !== side) continue;
          if (entry.parent !== lastParent) runs.push([]);
          runs[runs.length - 1].push(entry.node);
          lastParent = entry.parent;
        }
        return { side, children: runs.flat(), runs };
      };
      /** 范围内容的外接矩形：子树 + 中间层级上与之重叠的外框 / 概要（让出内层结构） */
      const contentRect = (children: readonly LayoutNode[], withSameOwner: boolean): Rect => {
        let inner: Rect | null = null;
        for (const child of children) inner = union(inner, extent.get(child)!);
        for (const item of boundaryRects) {
          if (!withSameOwner && item.owner === n) continue;
          if (children.some((child) => item.children.has(child))) inner = union(inner, item.rect);
        }
        return inner!;
      };
      // 1. 外框：圈住范围内子树，记录「已占用」矩形，供概要与外层外框避让
      for (const boundary of boundaryList) {
        const info = covered(boundary);
        if (!info) continue;
        const vertical = info.side === 'left' || info.side === 'right';
        // 每个父节点下的连续段各自外扩，沿同级排列方向排序
        const pieces = info.runs.map((run): Rect => {
          const inner = contentRect(run, false);
          return {
            x: inner.x - BOUNDARY_PADDING,
            y: inner.y - BOUNDARY_PADDING,
            width: inner.width + BOUNDARY_PADDING * 2,
            height: inner.height + BOUNDARY_PADDING * 2,
          };
        }).sort((a, b) => (vertical ? a.y - b.y : a.x - b.x));
        let box = pieces[0];
        for (const piece of pieces) box = union(box, piece);
        let path: string | undefined;
        if (pieces.length > 1) {
          // 相邻两段之间若夹着范围外的节点（如缩进图中的父节点）或横向不重叠，则断开分段绘制
          const inside = collectSubtrees(info.children);
          const others = allNodes.filter((item) => !inside.has(item));
          const groups: Rect[][] = [[pieces[0]]];
          for (let i = 1; i < pieces.length; i += 1) {
            const prev = pieces[i - 1];
            const cur = pieces[i];
            const overlap = vertical
              ? Math.min(prev.x + prev.width, cur.x + cur.width) > Math.max(prev.x, cur.x)
              : Math.min(prev.y + prev.height, cur.y + cur.height) > Math.max(prev.y, cur.y);
            // 两段在间隙中点衔接，衔接区域即两段各自延伸到中点的部分
            const gap: Rect = vertical
              ? { x: Math.min(prev.x, cur.x), y: prev.y + prev.height, width: Math.max(prev.x + prev.width, cur.x + cur.width) - Math.min(prev.x, cur.x), height: cur.y - prev.y - prev.height }
              : { x: prev.x + prev.width, y: Math.min(prev.y, cur.y), width: cur.x - prev.x - prev.width, height: Math.max(prev.y + prev.height, cur.y + cur.height) - Math.min(prev.y, cur.y) };
            const blocked = (gap.width > 0 && gap.height > 0) && others.some((item) => intersects(nodeRect(item), gap));
            if (overlap && !blocked) groups[groups.length - 1].push(cur);
            else groups.push([cur]);
          }
          path = groups.map((group) => roundedPolygonPath(steppedOutline(group, vertical), 12)).join(' ');
        }
        const first = pieces[0];
        const lastPiece = pieces[pieces.length - 1];
        const layoutBoundary: LayoutBoundary = {
          ownerId: node.id,
          id: boundary.id,
          title: boundary.title,
          branchIndex: info.children[0].branchIndex,
          rect: box,
          path,
          titleAnchor: { x: first.x + 10, y: first.y },
          side: info.side,
          // 同级纵排时手柄在首段上边与末段下边，横排时在首段左边与末段右边
          handles: vertical
            ? [{ x: first.x + first.width / 2, y: first.y }, { x: lastPiece.x + lastPiece.width / 2, y: lastPiece.y + lastPiece.height }]
            : [{ x: first.x, y: first.y + first.height / 2 }, { x: lastPiece.x + lastPiece.width, y: lastPiece.y + lastPiece.height / 2 }],
        };
        let occupied = box;
        if (boundary.title) {
          // 标题标签压在首段框的左上边线上，过长时按框宽省略
          const maxText = Math.max(24, first.width - 20 - BOUNDARY_TITLE_PAD_X * 2);
          // ellipsizeLine 总会补省略号，只在确实超宽时调用
          const text = measure(boundary.title, titleFont) <= maxText
            ? boundary.title
            : ellipsizeLine(boundary.title, maxText, measure, titleFont);
          const width = Math.ceil(measure(text, titleFont)) + BOUNDARY_TITLE_PAD_X * 2;
          layoutBoundary.titleText = text;
          layoutBoundary.titleBox = { x: first.x + 10, y: first.y - BOUNDARY_TITLE_HEIGHT / 2, width, height: BOUNDARY_TITLE_HEIGHT };
          occupied = union(occupied, layoutBoundary.titleBox);
        }
        result.boundaries.push(layoutBoundary);
        boundaryRects.push({ owner: n, children: new Set(info.children), rect: occupied });
        rect = union(rect, occupied);
      }
      // 2. 概要：大括号放在范围内子树（及重叠的外框 / 先排好的概要）最外侧之外，概要主题子树从括号尖端向外展开。
      // 先排好的概要同样登记为已占用：同一节点上后加的「概要的概要」、跨父范围外层概要都会整体让出
      for (const summary of summaryList) {
        const info = covered(summary);
        if (!info) continue;
        const area = contentRect(info.children, true);
        const { side } = info;
        let path: string;
        let handles: [Point, Point];
        let tip: Point;
        if (side === 'left' || side === 'right') {
          const sign = side === 'right' ? 1 : -1;
          const base = side === 'right' ? area.x + area.width + SUMMARY_GAP : area.x - SUMMARY_GAP;
          path = bracePath(area.y, area.y + area.height, BRACE_DEPTH, (u, v) => [base + v * sign, u]);
          handles = [{ x: base, y: area.y }, { x: base, y: area.y + area.height }];
          tip = { x: base + BRACE_DEPTH * sign, y: area.y + area.height / 2 };
        } else {
          const sign = side === 'bottom' ? 1 : -1;
          const base = side === 'bottom' ? area.y + area.height + SUMMARY_GAP : area.y - SUMMARY_GAP;
          path = bracePath(area.x, area.x + area.width, BRACE_DEPTH, (u, v) => [u, base + v * sign]);
          handles = [{ x: area.x, y: base }, { x: area.x + area.width, y: base }];
          tip = { x: area.x + area.width / 2, y: base + BRACE_DEPTH * sign };
        }
        const branchIndex = info.children[0].branchIndex;
        // 排版阶段已度量好的概要主题子树（手工构造的排版节点可能没有，此时只画括号）；
        // 拖动端点预览中换挂到上级的概要沿用原所属节点上度量好的子树
        const measured = movedTopics.get(summary.id) ?? n.summaryTopics?.get(summary.id);
        let label: Rect = { x: tip.x, y: tip.y, width: 0, height: 0 };
        // 本概要占据的区域：所概括内容 + 大括号 + 概要子树
        let occupied = union(area, { x: tip.x, y: tip.y, width: 0, height: 0 });
        if (measured) {
          const owner = { ownerId: node.id, id: summary.id };
          let placed = placeSummaryTopicTree(measured, side, tip, branchIndex, edgeStyle, owner);
          // 未预留空间的布局（跨父范围、时间轴、鱼骨图等）中概要子树可能压住其他节点：沿同级方向微移避让
          const shift = findClearShift(placed.nodes, allNodes, side === 'left' || side === 'right');
          if (shift !== 0) {
            const shifted = side === 'left' || side === 'right' ? { x: tip.x, y: tip.y + shift } : { x: tip.x + shift, y: tip.y };
            placed = placeSummaryTopicTree(measured, side, shifted, branchIndex, edgeStyle, owner);
          }
          result.nodes.push(...placed.nodes);
          result.links.push(...placed.links);
          allNodes.push(...placed.nodes);
          label = nodeRect(placed.root);
          // 概要子树内部的外框 / 概要（递归），外接矩形计入所属节点
          occupied = union(occupied, processTree(placed.root));
          rect = union(rect, occupied);
        }
        boundaryRects.push({ owner: n, children: new Set(info.children), rect: occupied });
        result.summaries.push({
          ownerId: node.id,
          id: summary.id,
          topicId: summary.topic.id,
          side,
          branchIndex,
          bracePath: path,
          label,
          handles,
        });
        rect = union(union(rect, area), label);
      }
    }
    extent.set(n, rect);
  }
  return extent.get(treeRoot)!;
  };
  processTree(root);

  // 3. 联系线：两端都可见时绘制，曲线从节点边框出发
  const byId = new Map<string, LayoutNode>();
  for (const n of allNodes) byId.set(n.node.id, n);
  for (const source of allNodes) {
    for (const relation of source.node.relations ?? []) {
      const target = byId.get(relation.targetId);
      if (!target || target === source) continue;
      const c1 = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
      const c2 = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
      const dx = c2.x - c1.x;
      const dy = c2.y - c1.y;
      const length = Math.hypot(dx, dy);
      if (length < 1) continue;
      const normal = { x: -dy / length, y: dx / length };
      /** 给定控制点时的端点（从节点边框朝控制点方向出线）与 t = 0.5 处的曲线中点 */
      const geometry = (cp1: Point, cp2: Point) => {
        const p1 = boxExit(source, cp1);
        const p2 = boxExit(target, cp2, 4);
        const mid = {
          x: 0.125 * p1.x + 0.375 * cp1.x + 0.375 * cp2.x + 0.125 * p2.x,
          y: 0.125 * p1.y + 0.375 * cp1.y + 0.375 * cp2.y + 0.125 * p2.y,
        };
        return { cp1, cp2, p1, p2, mid };
      };
      /** 自动 / 旧版弯曲量：两个控制点沿两端连线的法向同侧偏移 */
      const bendGeometry = (bend: number) => geometry(
        { x: c1.x + dx * 0.3 + normal.x * bend, y: c1.y + dy * 0.3 + normal.y * bend },
        { x: c1.x + dx * 0.7 + normal.x * bend, y: c1.y + dy * 0.7 + normal.y * bend },
      );
      const wrapped = relation.title ? wrapLabel(relation.title, RELATION_MAX_TEXT_WIDTH, measure, relationFont) : null;
      const labelSize = wrapped
        ? { width: wrapped.width + RELATION_PAD_X * 2, height: wrapped.lines.length * RELATION_LINE_HEIGHT + RELATION_PAD_Y * 2 }
        : { width: 0, height: 0 };
      // 控制点优先（手动拖动过）；其次旧版弯曲量；都没有时自动避让节点
      const controls = options.controlOverrides?.get(relation.id) ?? relation.controls;
      const { cp1, cp2, p1, p2, mid } = controls
        ? geometry({ x: c1.x + controls[0].x, y: c1.y + controls[0].y }, { x: c2.x + controls[1].x, y: c2.y + controls[1].y })
        : bendGeometry(relation.bend ?? pickAutoBend(allNodes, source, target, length, bendGeometry, { x: labelSize.width / 2, y: labelSize.height / 2 }));
      // 箭头沿终点切线方向
      let ax = p2.x - cp2.x;
      let ay = p2.y - cp2.y;
      const al = Math.hypot(ax, ay) || 1;
      ax /= al;
      ay /= al;
      const baseX = p2.x - ax * ARROW_LENGTH;
      const baseY = p2.y - ay * ARROW_LENGTH;
      const arrowPath = `M ${fmt(p2.x)} ${fmt(p2.y)} L ${fmt(baseX - ay * ARROW_HALF_WIDTH)} ${fmt(baseY + ax * ARROW_HALF_WIDTH)} L ${fmt(baseX + ay * ARROW_HALF_WIDTH)} ${fmt(baseY - ax * ARROW_HALF_WIDTH)} Z`;
      // 曲线主体止于箭头底部，避免虚线端头穿出箭头尖
      const path = `M ${fmt(p1.x)} ${fmt(p1.y)} C ${fmt(cp1.x)} ${fmt(cp1.y)}, ${fmt(cp2.x)} ${fmt(cp2.y)}, ${fmt(baseX)} ${fmt(baseY)}`;
      let bounds: Rect = { x: Math.min(p1.x, p2.x, cp1.x, cp2.x), y: Math.min(p1.y, p2.y, cp1.y, cp2.y), width: 0, height: 0 };
      bounds.width = Math.max(p1.x, p2.x, cp1.x, cp2.x) - bounds.x;
      bounds.height = Math.max(p1.y, p2.y, cp1.y, cp2.y) - bounds.y;
      const layoutRelation: LayoutRelation = {
        ownerId: source.node.id,
        id: relation.id,
        title: relation.title,
        path,
        arrowPath,
        mid,
        c1,
        c2,
        p1,
        p2,
        cp1,
        cp2,
        lines: [],
        bounds,
      };
      if (wrapped) {
        const { width, height } = labelSize;
        layoutRelation.lines = wrapped.lines;
        layoutRelation.labelBox = { x: mid.x - width / 2, y: mid.y - height / 2, width, height };
        bounds = union(bounds, layoutRelation.labelBox);
        layoutRelation.bounds = bounds;
      }
      result.relations.push(layoutRelation);
    }
  }

  for (const item of result.boundaries) result.bounds = union(result.bounds, item.titleBox ? union(item.rect, item.titleBox) : item.rect);
  for (const item of result.summaries) {
    result.bounds = union(result.bounds, item.label);
  }
  // 概要子树中的其余节点同样可能伸出主树范围
  for (const item of result.nodes) result.bounds = union(result.bounds, nodeRect(item));
  for (const item of result.relations) result.bounds = union(result.bounds, item.bounds);
  return result;
}
