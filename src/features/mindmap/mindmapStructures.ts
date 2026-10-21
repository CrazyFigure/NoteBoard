// NoteBoard 思维导图结构元素：概要（大括号）/ 外框 / 联系线
// 数据挂在节点上（概要、外框挂父节点并以首尾子节点 id 表示范围；联系线挂起点节点），
// 几何在排版之后按节点实际坐标计算，因此始终跟随节点位置，不随布局切换错位。
// 详见 docs/09-开发路线图.md

import type { MindBoundary, MindNode, MindNodeRange, MindRelation, MindSummary } from './mindmapTypes';
import type { LayoutNode } from './layouts/layoutTypes';
import { buildFont, ellipsizeLine, estimateTextWidth, wrapText, type TextMeasure } from './mindmapTextMeasure';
import { findMindNodeParent, getTopLevelMindNodeIds, walkMindNodes } from './mindmapTree';

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
        return relation;
      });
    if (list.length > 0) result.relations = list;
  }
  return result;
}

/**
 * 解析范围在父节点子数组中的下标区间
 * 首尾节点之一被移走时退化为仅剩的一端；两端都不在时返回 null（视为失效）
 */
export function resolveRangeIndexes(parent: MindNode, range: Pick<MindNodeRange, 'startId' | 'endId'>): [number, number] | null {
  const start = parent.children.findIndex((child) => child.id === range.startId);
  const end = parent.children.findIndex((child) => child.id === range.endId);
  if (start < 0 && end < 0) return null;
  if (start < 0) return [end, end];
  if (end < 0) return [start, start];
  return start <= end ? [start, end] : [end, start];
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
      node.summaries = node.summaries.filter((item) => resolveRangeIndexes(node, item));
      if (node.summaries.length === 0) delete node.summaries;
    }
    if (node.boundaries) {
      node.boundaries = node.boundaries.filter((item) => resolveRangeIndexes(node, item));
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
 * 由选中节点求出连续的同级范围（中间未选中的同级节点一并纳入，与 XMind 一致）
 */
export function getSiblingRangeForSelection(root: MindNode, ids: Iterable<string>): SiblingRangeResult {
  const topIds = getTopLevelMindNodeIds(root, ids);
  if (topIds.length === 0) return { ok: false, reason: '中心主题不能添加' };
  let parent: MindNode | null = null;
  let min = Infinity;
  let max = -Infinity;
  for (const id of topIds) {
    const info = findMindNodeParent(root, id);
    if (!info) return { ok: false, reason: '节点不存在' };
    if (parent && info.parent !== parent) return { ok: false, reason: '请选择同一父节点下的节点' };
    parent = info.parent;
    min = Math.min(min, info.index);
    max = Math.max(max, info.index);
  }
  return { ok: true, parentId: parent!.id, startId: parent!.children[min].id, endId: parent!.children[max].id };
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
}

export interface LayoutBoundary {
  ownerId: string;
  id: string;
  title?: string;
  branchIndex: number;
  rect: Rect;
  /** 标题标签（无标题时为空） */
  titleBox?: Rect;
  titleText?: string;
}

export interface LayoutRelation {
  ownerId: string;
  id: string;
  title?: string;
  path: string;
  arrowPath: string;
  /** 曲线中点（文字与调整手柄位置） */
  mid: { x: number; y: number };
  /** 两端中心连线的中点与左法向（拖动手柄换算弯曲量用） */
  chordMid: { x: number; y: number };
  normal: { x: number; y: number };
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
  /** 临时弯曲量覆盖（拖动联系线手柄时的实时预览） */
  bendOverrides?: ReadonlyMap<string, number>;
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
function sideOf(parent: LayoutNode, child: LayoutNode): StructureSide {
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

type Point = { x: number; y: number };

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
 * 拖动手柄时换算弯曲量：曲线中点 ≈ 弦中点 + 法向 × 弯曲量 × 0.75
 */
export function bendFromPoint(relation: Pick<LayoutRelation, 'chordMid' | 'normal'>, point: { x: number; y: number }): number {
  const dot = (point.x - relation.chordMid.x) * relation.normal.x + (point.y - relation.chordMid.y) * relation.normal.y;
  return Math.round(dot / 0.75);
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
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    order.push(n);
    for (let i = n.children.length - 1; i >= 0; i -= 1) stack.push(n.children[i]);
  }

  // 每个节点「含子树与其上结构元素」的外接矩形
  const extent = new Map<LayoutNode, Rect>();
  for (let oi = order.length - 1; oi >= 0; oi -= 1) {
    const n = order[oi];
    let rect = nodeRect(n);
    for (const child of n.children) rect = union(rect, extent.get(child)!);
    const node = n.node;
    if (n.children.length > 0 && (node.boundaries || node.summaries)) {
      /** 范围内与首个子节点同侧的子节点（双向图根节点两侧分开） */
      const covered = (range: MindNodeRange): { side: StructureSide; children: LayoutNode[] } | null => {
        const indexes = resolveRangeIndexes(node, range);
        if (!indexes) return null;
        const list = n.children.slice(indexes[0], indexes[1] + 1);
        if (list.length === 0) return null;
        const side = sideOf(n, list[0]);
        return { side, children: list.filter((child) => sideOf(n, child) === side) };
      };
      // 1. 外框：圈住范围内子树，记录到按子节点索引的「已占用」矩形，供同父概要避让
      const boundaryRects: Array<{ children: Set<LayoutNode>; rect: Rect }> = [];
      for (const boundary of node.boundaries ?? []) {
        const info = covered(boundary);
        if (!info) continue;
        let inner: Rect | null = null;
        for (const child of info.children) inner = union(inner, extent.get(child)!);
        const box: Rect = {
          x: inner!.x - BOUNDARY_PADDING,
          y: inner!.y - BOUNDARY_PADDING,
          width: inner!.width + BOUNDARY_PADDING * 2,
          height: inner!.height + BOUNDARY_PADDING * 2,
        };
        const layoutBoundary: LayoutBoundary = {
          ownerId: node.id,
          id: boundary.id,
          title: boundary.title,
          branchIndex: info.children[0].branchIndex,
          rect: box,
        };
        let occupied = box;
        if (boundary.title) {
          // 标题标签压在框的左上边线上，过长时按框宽省略
          const maxText = Math.max(24, box.width - 20 - BOUNDARY_TITLE_PAD_X * 2);
          // ellipsizeLine 总会补省略号，只在确实超宽时调用
          const text = measure(boundary.title, titleFont) <= maxText
            ? boundary.title
            : ellipsizeLine(boundary.title, maxText, measure, titleFont);
          const width = Math.ceil(measure(text, titleFont)) + BOUNDARY_TITLE_PAD_X * 2;
          layoutBoundary.titleText = text;
          layoutBoundary.titleBox = { x: box.x + 10, y: box.y - BOUNDARY_TITLE_HEIGHT / 2, width, height: BOUNDARY_TITLE_HEIGHT };
          occupied = union(occupied, layoutBoundary.titleBox);
        }
        result.boundaries.push(layoutBoundary);
        boundaryRects.push({ children: new Set(info.children), rect: occupied });
        rect = union(rect, occupied);
      }
      // 2. 概要：大括号放在范围内子树（及重叠外框）最外侧之外
      for (const summary of node.summaries ?? []) {
        const info = covered(summary);
        if (!info) continue;
        let inner: Rect | null = null;
        for (const child of info.children) inner = union(inner, extent.get(child)!);
        for (const item of boundaryRects) {
          if (info.children.some((child) => item.children.has(child))) inner = union(inner, item.rect);
        }
        const area = inner!;
        const text = summary.text || SUMMARY_PLACEHOLDER;
        const wrapped = wrapLabel(text, SUMMARY_MAX_TEXT_WIDTH, measure, summaryFont);
        // 宽高含 1.5px 边框（两侧共 3px）与 1px 取整余量
        const labelWidth = Math.max(SUMMARY_MIN_WIDTH, wrapped.width + SUMMARY_PAD_X * 2 + 4);
        const labelHeight = wrapped.lines.length * SUMMARY_LINE_HEIGHT + SUMMARY_PAD_Y * 2 + 3;
        const { side } = info;
        let path: string;
        let label: Rect;
        if (side === 'left' || side === 'right') {
          const sign = side === 'right' ? 1 : -1;
          const base = side === 'right' ? area.x + area.width + SUMMARY_GAP : area.x - SUMMARY_GAP;
          path = bracePath(area.y, area.y + area.height, BRACE_DEPTH, (u, v) => [base + v * sign, u]);
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
      /** 给定弯曲量的控制点、端点与 t = 0.5 处的曲线中点 */
      const geometry = (bend: number) => {
        const cp1 = { x: c1.x + dx * 0.3 + normal.x * bend, y: c1.y + dy * 0.3 + normal.y * bend };
        const cp2 = { x: c1.x + dx * 0.7 + normal.x * bend, y: c1.y + dy * 0.7 + normal.y * bend };
        const p1 = boxExit(source, cp1);
        const p2 = boxExit(target, cp2, 4);
        const mid = {
          x: 0.125 * p1.x + 0.375 * cp1.x + 0.375 * cp2.x + 0.125 * p2.x,
          y: 0.125 * p1.y + 0.375 * cp1.y + 0.375 * cp2.y + 0.125 * p2.y,
        };
        return { cp1, cp2, p1, p2, mid };
      };
      const wrapped = relation.title ? wrapLabel(relation.title, RELATION_MAX_TEXT_WIDTH, measure, relationFont) : null;
      const labelSize = wrapped
        ? { width: wrapped.width + RELATION_PAD_X * 2, height: wrapped.lines.length * RELATION_LINE_HEIGHT + RELATION_PAD_Y * 2 }
        : { width: 0, height: 0 };
      const bend = options.bendOverrides?.get(relation.id) ?? relation.bend
        ?? pickAutoBend(nodes, source, target, length, geometry, { x: labelSize.width / 2, y: labelSize.height / 2 });
      const { cp1, cp2, p1, p2, mid } = geometry(bend);
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
        chordMid: { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 },
        normal,
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
