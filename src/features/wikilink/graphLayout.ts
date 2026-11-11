// NoteBoard 关系图谱力导向布局
// 参照 d3-force 的模型自行实现（不引入额外依赖）：
// - 斥力：Barnes-Hut 四叉树近似，节点数较多时每帧 O(n log n)；
// - 引力：边按「弹簧」拉向目标距离，度数大的一端移动更少；
// - 向心力：把孤立笔记与各个连通块拉回中心附近；
// - alpha 逐帧衰减，降到阈值后停止，拖动节点时重新加热。

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 固定位置（拖动中）；null 表示自由 */
  fx: number | null;
  fy: number | null;
}

export interface SimLink {
  source: SimNode;
  target: SimNode;
}

/** 四叉树节点 */
interface Quad {
  x0: number;
  y0: number;
  size: number;
  /** 质心与质量（节点数） */
  cx: number;
  cy: number;
  mass: number;
  /** 叶子中的节点（深度达到上限时可能有多个重合节点） */
  bodies: SimNode[] | null;
  children: (Quad | null)[] | null;
}

const MAX_QUAD_DEPTH = 24;
/** Barnes-Hut 精度参数（θ²） */
const THETA2 = 0.81;
/** 两点距离平方的下限：避免重合节点产生极大的力 */
const MIN_DIST2 = 1;

function newQuad(x0: number, y0: number, size: number): Quad {
  return { x0, y0, size, cx: 0, cy: 0, mass: 0, bodies: null, children: null };
}

function childIndex(quad: Quad, node: SimNode): number {
  const half = quad.size / 2;
  return (node.x >= quad.x0 + half ? 1 : 0) + (node.y >= quad.y0 + half ? 2 : 0);
}

function insert(quad: Quad, node: SimNode, depth: number): void {
  if (quad.children) {
    insertIntoChild(quad, node, depth);
    return;
  }
  if (!quad.bodies) {
    quad.bodies = [node];
    return;
  }
  // 已有节点的叶子：达到深度上限时直接并存，否则拆分
  if (depth >= MAX_QUAD_DEPTH) {
    quad.bodies.push(node);
    return;
  }
  const existing = quad.bodies;
  quad.bodies = null;
  quad.children = [null, null, null, null];
  for (const body of existing) insertIntoChild(quad, body, depth);
  insertIntoChild(quad, node, depth);
}

function insertIntoChild(quad: Quad, node: SimNode, depth: number): void {
  const index = childIndex(quad, node);
  const half = quad.size / 2;
  let child = quad.children![index];
  if (!child) {
    child = newQuad(quad.x0 + (index & 1 ? half : 0), quad.y0 + (index & 2 ? half : 0), half);
    quad.children![index] = child;
  }
  insert(child, node, depth + 1);
}

/** 自底向上累计质心 */
function accumulate(quad: Quad): void {
  let mass = 0;
  let cx = 0;
  let cy = 0;
  if (quad.bodies) {
    for (const body of quad.bodies) {
      cx += body.x;
      cy += body.y;
      mass += 1;
    }
  } else if (quad.children) {
    for (const child of quad.children) {
      if (!child) continue;
      accumulate(child);
      cx += child.cx * child.mass;
      cy += child.cy * child.mass;
      mass += child.mass;
    }
  }
  quad.mass = mass;
  quad.cx = mass > 0 ? cx / mass : 0;
  quad.cy = mass > 0 ? cy / mass : 0;
}

function buildQuadTree(nodes: SimNode[]): Quad | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  const size = Math.max(maxX - minX, maxY - minY, 1) + 1;
  const root = newQuad(minX, minY, size);
  for (const node of nodes) insert(root, node, 0);
  accumulate(root);
  return root;
}

/** 重合节点之间的微小随机偏移 */
function jiggle(): number {
  return (Math.random() - 0.5) * 1e-3;
}

export interface ForceOptions {
  /** 弹簧目标长度 */
  linkDistance: number;
  /** 斥力强度（负值为排斥） */
  charge: number;
  /** 向心力强度 */
  gravity: number;
}

export const DEFAULT_FORCE_OPTIONS: ForceOptions = {
  linkDistance: 46,
  charge: -150,
  gravity: 0.045,
};

export class ForceSimulation {
  nodes: SimNode[];
  links: SimLink[];
  alpha = 1;
  /** alpha 衰减的目标值（拖动时提高，保持布局活跃） */
  alphaTarget = 0;
  readonly alphaMin = 0.003;
  private readonly alphaDecay = 1 - Math.pow(0.003, 1 / 300);
  private readonly velocityDecay = 0.42;
  private readonly options: ForceOptions;
  /** 每条边的强度与偏置（按两端度数计算，构造时缓存） */
  private linkStrength: number[] = [];
  private linkBias: number[] = [];

  constructor(nodes: SimNode[], links: SimLink[], options: ForceOptions = DEFAULT_FORCE_OPTIONS) {
    this.nodes = nodes;
    this.links = links;
    this.options = options;
    const count = new Map<SimNode, number>();
    for (const link of links) {
      count.set(link.source, (count.get(link.source) ?? 0) + 1);
      count.set(link.target, (count.get(link.target) ?? 0) + 1);
    }
    for (const link of links) {
      const sourceCount = count.get(link.source) ?? 1;
      const targetCount = count.get(link.target) ?? 1;
      this.linkStrength.push(1 / Math.min(sourceCount, targetCount));
      this.linkBias.push(sourceCount / (sourceCount + targetCount));
    }
  }

  /** 是否仍在运动 */
  get active(): boolean {
    return this.alpha >= this.alphaMin || this.alphaTarget > 0;
  }

  /** 重新加热（数据变化、拖动开始时） */
  reheat(alpha = 0.3): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  tick(): void {
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
    const alpha = this.alpha;
    this.applyLinks(alpha);
    this.applyCharge(alpha);
    this.applyGravity(alpha);
    for (const node of this.nodes) {
      if (node.fx !== null) {
        node.x = node.fx;
        node.vx = 0;
      } else {
        node.vx *= 1 - this.velocityDecay;
        node.x += node.vx;
      }
      if (node.fy !== null) {
        node.y = node.fy;
        node.vy = 0;
      } else {
        node.vy *= 1 - this.velocityDecay;
        node.y += node.vy;
      }
    }
  }

  private applyLinks(alpha: number): void {
    const distance = this.options.linkDistance;
    this.links.forEach((link, index) => {
      const { source, target } = link;
      let dx = target.x + target.vx - source.x - source.vx || jiggle();
      let dy = target.y + target.vy - source.y - source.vy || jiggle();
      let length = Math.sqrt(dx * dx + dy * dy);
      length = ((length - distance) / length) * alpha * this.linkStrength[index];
      dx *= length;
      dy *= length;
      const bias = this.linkBias[index];
      target.vx -= dx * bias;
      target.vy -= dy * bias;
      source.vx += dx * (1 - bias);
      source.vy += dy * (1 - bias);
    });
  }

  private applyCharge(alpha: number): void {
    const root = buildQuadTree(this.nodes);
    if (!root) return;
    const strength = this.options.charge;
    for (const node of this.nodes) {
      // 显式栈遍历，避免深递归
      const stack: Quad[] = [root];
      while (stack.length > 0) {
        const quad = stack.pop()!;
        if (quad.mass === 0) continue;
        let dx = quad.cx - node.x;
        let dy = quad.cy - node.y;
        let dist2 = dx * dx + dy * dy;
        // 足够远的区域整体近似为一个质点
        if (quad.children && (quad.size * quad.size) / dist2 < THETA2) {
          if (dist2 < MIN_DIST2) dist2 = Math.sqrt(MIN_DIST2 * dist2);
          const factor = (strength * alpha * quad.mass) / dist2;
          node.vx += dx * factor;
          node.vy += dy * factor;
          continue;
        }
        if (quad.children) {
          for (const child of quad.children) if (child) stack.push(child);
          continue;
        }
        // 叶子：逐个计算
        for (const body of quad.bodies ?? []) {
          if (body === node) continue;
          dx = body.x - node.x || jiggle();
          dy = body.y - node.y || jiggle();
          dist2 = dx * dx + dy * dy;
          if (dist2 < MIN_DIST2) dist2 = Math.sqrt(MIN_DIST2 * dist2);
          const factor = (strength * alpha) / dist2;
          node.vx += dx * factor;
          node.vy += dy * factor;
        }
      }
    }
  }

  private applyGravity(alpha: number): void {
    const strength = this.options.gravity * alpha;
    for (const node of this.nodes) {
      node.vx -= node.x * strength;
      node.vy -= node.y * strength;
    }
  }
}

/**
 * 初始位置：沿用上一次布局中同 id 节点的位置；新节点放在已布局的邻居附近，
 * 都没有时按向日葵螺旋均匀排布（与 d3 一致，避免全部重合）。
 */
export function seedPositions(
  ids: string[],
  neighborsOf: (id: string) => string[],
  previous: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const golden = Math.PI * (3 - Math.sqrt(5));
  let spiralIndex = 0;
  for (const id of ids) {
    const kept = previous.get(id);
    if (kept) positions.set(id, { x: kept.x, y: kept.y });
  }
  for (const id of ids) {
    if (positions.has(id)) continue;
    const anchor = neighborsOf(id).map((neighbor) => positions.get(neighbor)).find(Boolean);
    if (anchor) {
      const angle = Math.random() * Math.PI * 2;
      positions.set(id, { x: anchor.x + Math.cos(angle) * 24, y: anchor.y + Math.sin(angle) * 24 });
      continue;
    }
    const radius = 12 * Math.sqrt(0.5 + spiralIndex);
    const angle = spiralIndex * golden;
    spiralIndex += 1;
    positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }
  return positions;
}
