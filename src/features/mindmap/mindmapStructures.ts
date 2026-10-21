// NoteBoard 思维导图结构元素：概要（大括号）/ 外框 / 联系线
// 数据挂在节点上（概要、外框挂父节点并以首尾子节点 id 表示范围；联系线挂起点节点），
// 几何在排版之后按节点实际坐标计算，因此始终跟随节点位置，不随布局切换错位。
// 详见 docs/09-开发路线图.md

import type { MindBoundary, MindNode, MindNodeRange, MindPoint, MindRelation, MindSummary } from './mindmapTypes';
import type { LayoutNode } from './layouts/layoutTypes';
import { buildFont, ellipsizeLine, estimateTextWidth, wrapText, type TextMeasure } from './mindmapTextMeasure';
import { getTopLevelMindNodeIds, walkMindNodes } from './mindmapTree';

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

/**
 * 反序列化时校验结构元素字段，只保留合法条目；空数组不写回节点
 */
export function normalizeNodeStructures(source: Partial<MindNode>): Pick<MindNode, 'summaries' | 'boundaries' | 'relations'> {
  const result: Pick<MindNode, 'summaries' | 'boundaries' | 'relations'> = {};
  const range = (item: Partial<MindNodeRange> | null | undefined): item is MindNodeRange =>
    Boolean(item) && isText(item!.id) && isText(item!.startId) && isText(item!.endId);
  if (Array.isArray(source.summaries)) {
    const list = source.summaries
      .filter(range)
      .map((item): MindSummary => ({ id: item.id, startId: item.startId, endId: item.endId, text: typeof item.text === 'string' ? item.text : '' }));
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
 * 由选中节点求出连续的同层范围（中间未选中的同层节点一并纳入，与 XMind 一致）。
 * 同父时挂在父节点上；父节点不同但层级相同时挂在最近共同祖先上，只覆盖选中层级，不含中间的父节点
 */
export function getSiblingRangeForSelection(root: MindNode, ids: Iterable<string>): SiblingRangeResult {
  // 顶层 id 已按先序排列，首尾即范围两端
  const topIds = getTopLevelMindNodeIds(root, ids);
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
  }
  if (topIds.some((id) => !parentOf.has(id))) return { ok: false, reason: '节点不存在' };
  const depth = depthOf.get(topIds[0]);
  if (topIds.some((id) => depthOf.get(id) !== depth)) return { ok: false, reason: '请选择同一层级的节点' };
  // 同层节点逐级上溯直到汇合：同父时第一步即汇合于父节点
  let ancestors = topIds.map((id) => parentOf.get(id)!);
  while (ancestors.some((node) => node !== ancestors[0])) ancestors = ancestors.map((node) => parentOf.get(node.id)!);
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

/** 改写结构元素的文字（概要文字 / 外框标题 / 联系线说明），原地修改；空标题移除字段 */
export function setStructureText(owner: MindNode, ref: Pick<MindStructureRef, 'kind' | 'id'>, text: string): boolean {
  const item = findStructure(owner, ref);
  if (!item) return false;
  if (ref.kind === 'summary') (item as MindSummary).text = text;
  else if (text) (item as MindBoundary | MindRelation).title = text;
  else delete (item as MindBoundary | MindRelation).title;
  return true;
}

/** 结构元素当前文字 */
export function getStructureText(item: MindSummary | MindBoundary | MindRelation, kind: MindStructureKind): string {
  return kind === 'summary' ? (item as MindSummary).text : (item as MindBoundary | MindRelation).title ?? '';
}

// ── 几何计算 ──

/** 概要大括号与内容的间距、括号深度、括号到概要文字的间距 */
export const SUMMARY_GAP = 10;
export const BRACE_DEPTH = 14;
export const SUMMARY_LABEL_GAP = 8;
/** 概要文字排版 */
export const SUMMARY_FONT_SIZE = 13;
export const SUMMARY_LINE_HEIGHT = 18;
export const SUMMARY_PAD_X = 10;
export const SUMMARY_PAD_Y = 6;
const SUMMARY_MAX_TEXT_WIDTH = 200;
const SUMMARY_MIN_WIDTH = 48;
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

/** 概要占位文字（空文字时显示） */
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
  text: string;
  side: StructureSide;
  /** 所覆盖首个子节点的分支配色序号 */
  branchIndex: number;
  /** 大括号路径 */
  bracePath: string;
  /** 概要文字框 */
  label: Rect;
  lines: string[];
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
  /** 全部结构元素的外接矩形；没有元素时为 null */
  bounds: Rect | null;
}

export interface StructureLayoutOptions {
  measure?: TextMeasure;
  fontFamily?: string;
  /** 临时控制点覆盖（拖动联系线控制点时的实时预览，偏移相对两端节点中心） */
  controlOverrides?: ReadonlyMap<string, [Point, Point]>;
  /** 临时范围覆盖（拖动概要 / 外框端点时的实时预览） */
  rangeOverrides?: ReadonlyMap<string, Pick<MindNodeRange, 'startId' | 'endId'>>;
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
 * 拖动概要 / 外框端点：在 owner 下与固定端同层、同侧的节点中，沿同级排列方向找指针所在（或最近）的子树，
 * 返回固定端与它之间的新范围（跨父范围同样只在该层内伸缩）
 */
export function dragRangeEnd(owner: LayoutNode, fixedId: string, point: Point): Pick<MindNodeRange, 'startId' | 'endId'> | null {
  const depth = depthBelow(owner, fixedId, LAYOUT_ACCESS);
  if (depth < 0) return null;
  const level = nodesAtDepth(owner, depth, LAYOUT_ACCESS);
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
  return a <= b ? { startId: fixed.node.node.id, endId: best.node.id } : { startId: best.node.id, endId: fixed.node.node.id };
}

/**
 * 计算全部结构元素的几何：只处理已排版（展开可见）的节点，
 * 外框与概要自内向外累加，嵌套时外层自动让出内层的空间
 */
export function computeMindmapStructures(nodes: readonly LayoutNode[], options: StructureLayoutOptions = {}): MindmapStructureLayout {
  const measure = options.measure ?? estimateTextWidth;
  const family = options.fontFamily ?? '';
  const summaryFont = buildFont(SUMMARY_FONT_SIZE, 500, family);
  const titleFont = buildFont(BOUNDARY_TITLE_FONT_SIZE, 500, family);
  const relationFont = buildFont(RELATION_FONT_SIZE, 400, family);
  const result: MindmapStructureLayout = { summaries: [], boundaries: [], relations: [], bounds: null };
  const root = nodes.find((n) => n.level === 0);
  if (!root) return result;

  // 显式栈先序遍历，逆序即为子节点先于父节点的后序
  const order: LayoutNode[] = [];
  const parentOf = new Map<LayoutNode, LayoutNode>();
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    order.push(n);
    for (let i = n.children.length - 1; i >= 0; i -= 1) {
      parentOf.set(n.children[i], n);
      stack.push(n.children[i]);
    }
  }

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

  // 每个节点「含子树与其上结构元素」的外接矩形
  const extent = new Map<LayoutNode, Rect>();
  // 已排好的外框（含标题）及其覆盖节点：外层外框 / 概要据此让出内层外框（后序保证内层先算）
  const boundaryRects: Array<{ owner: LayoutNode; children: Set<LayoutNode>; rect: Rect }> = [];
  for (let oi = order.length - 1; oi >= 0; oi -= 1) {
    const n = order[oi];
    let rect = nodeRect(n);
    for (const child of n.children) rect = union(rect, extent.get(child)!);
    const node = n.node;
    if (n.children.length > 0 && (node.boundaries || node.summaries)) {
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
      /** 范围内容的外接矩形：子树 + 中间层级上与之重叠的外框（让出内层外框） */
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
      for (const boundary of node.boundaries ?? []) {
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
          const others = nodes.filter((item) => !inside.has(item));
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
      // 2. 概要：大括号放在范围内子树（及重叠外框）最外侧之外
      for (const summary of node.summaries ?? []) {
        const info = covered(summary);
        if (!info) continue;
        const inner = contentRect(info.children, true);
        const area = inner!;
        const text = summary.text || SUMMARY_PLACEHOLDER;
        const wrapped = wrapLabel(text, SUMMARY_MAX_TEXT_WIDTH, measure, summaryFont);
        // 宽高含 1.5px 边框（两侧共 3px）与 1px 取整余量
        const labelWidth = Math.max(SUMMARY_MIN_WIDTH, wrapped.width + SUMMARY_PAD_X * 2 + 4);
        const labelHeight = wrapped.lines.length * SUMMARY_LINE_HEIGHT + SUMMARY_PAD_Y * 2 + 3;
        const { side } = info;
        let path: string;
        let label: Rect;
        let handles: [Point, Point];
        if (side === 'left' || side === 'right') {
          const sign = side === 'right' ? 1 : -1;
          const base = side === 'right' ? area.x + area.width + SUMMARY_GAP : area.x - SUMMARY_GAP;
          path = bracePath(area.y, area.y + area.height, BRACE_DEPTH, (u, v) => [base + v * sign, u]);
          handles = [{ x: base, y: area.y }, { x: base, y: area.y + area.height }];
          const tip = base + BRACE_DEPTH * sign;
          const midY = area.y + area.height / 2;
          label = {
            x: side === 'right' ? tip + SUMMARY_LABEL_GAP : tip - SUMMARY_LABEL_GAP - labelWidth,
            y: midY - labelHeight / 2,
            width: labelWidth,
            height: labelHeight,
          };
        } else {
          const sign = side === 'bottom' ? 1 : -1;
          const base = side === 'bottom' ? area.y + area.height + SUMMARY_GAP : area.y - SUMMARY_GAP;
          path = bracePath(area.x, area.x + area.width, BRACE_DEPTH, (u, v) => [u, base + v * sign]);
          handles = [{ x: area.x, y: base }, { x: area.x + area.width, y: base }];
          const tip = base + BRACE_DEPTH * sign;
          const midX = area.x + area.width / 2;
          label = {
            x: midX - labelWidth / 2,
            y: side === 'bottom' ? tip + SUMMARY_LABEL_GAP : tip - SUMMARY_LABEL_GAP - labelHeight,
            width: labelWidth,
            height: labelHeight,
          };
        }
        result.summaries.push({
          ownerId: node.id,
          id: summary.id,
          text: summary.text,
          side,
          branchIndex: info.children[0].branchIndex,
          bracePath: path,
          label,
          lines: wrapped.lines,
          handles,
        });
        rect = union(union(rect, area), label);
      }
    }
    extent.set(n, rect);
  }

  // 3. 联系线：两端都可见时绘制，曲线从节点边框出发
  const byId = new Map<string, LayoutNode>();
  for (const n of nodes) byId.set(n.node.id, n);
  for (const source of nodes) {
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
        : bendGeometry(relation.bend ?? pickAutoBend(nodes, source, target, length, bendGeometry, { x: labelSize.width / 2, y: labelSize.height / 2 }));
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
  for (const item of result.relations) result.bounds = union(result.bounds, item.bounds);
  return result;
}
