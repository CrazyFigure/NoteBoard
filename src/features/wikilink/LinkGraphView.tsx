// NoteBoard 关系图谱画布
// Canvas 绘制力导向图：滚轮 / 双指缩放、拖动空白处平移、拖动节点调整布局、悬停高亮相邻笔记、单击打开笔记。
// 颜色全部取自主题变量，切换主题后立即重绘；布局在数据刷新时沿用已有节点位置，不会整体跳动。

import { useCallback, useEffect, useRef } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { ForceSimulation, seedPositions, type SimLink, type SimNode } from './graphLayout';
import type { GraphNode, LinkGraph } from './linkGraph';

interface LinkGraphViewProps {
  graph: LinkGraph;
  /** 当前文档对应的节点（以强调色突出） */
  focusId: string | null;
  onOpenNode: (node: GraphNode) => void;
  /** panel：侧栏局部图；full：全屏图谱 */
  variant: 'panel' | 'full';
}

/** 主题调色板（已解析为画布可用的颜色） */
interface Palette {
  text: string;
  muted: string;
  accent: string;
  link: string;
  border: string;
  surface: string;
  font: string;
}

interface Transform {
  x: number;
  y: number;
  k: number;
}

/** 指针手势状态 */
type Gesture =
  | { type: 'none' }
  | { type: 'pan'; startX: number; startY: number; origin: Transform; moved: boolean }
  | { type: 'node'; node: SimNode; startX: number; startY: number; moved: boolean }
  | { type: 'pinch'; distance: number; origin: Transform; midX: number; midY: number };

const MIN_SCALE = 0.08;
const MAX_SCALE = 6;
/** 判定为拖动而非点击的移动距离（像素） */
const DRAG_THRESHOLD = 4;
/** 标签字号（屏幕像素，不随缩放变化） */
const LABEL_SIZE = 11;
/** 标签最长显示字数 */
const LABEL_MAX_CHARS = 18;
/** 首次布局时同步预演的时间预算：打开即呈现大致成形的图，而不是从一团散开 */
const PRERUN_BUDGET_MS = 60;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 节点半径（世界坐标）：相连笔记越多越大 */
function radiusOf(node: GraphNode | undefined): number {
  return 4 + Math.min(9, Math.sqrt(node?.degree ?? 0) * 1.7);
}

/** 把任意 CSS 颜色转成画布一定能识别的 rgba（主题可能使用 color-mix 等写法） */
function normalizeColor(value: string, fallback: string): string {
  if (!value) return fallback;
  if (/^(#|rgb)/i.test(value)) return value;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return fallback;
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  } catch {
    return fallback;
  }
}

/** 通过探针元素读取主题变量的计算值 */
function readPalette(probe: HTMLElement): Palette {
  const read = (variable: string, fallback: string) => {
    probe.style.color = `var(${variable}, ${fallback})`;
    return normalizeColor(getComputedStyle(probe).color, fallback);
  };
  return {
    text: read('--editor-text', '#333333'),
    muted: read('--editor-text-muted', '#94a3b8'),
    accent: read('--accent-strong', '#3b82f6'),
    link: read('--editor-link', '#2563eb'),
    border: read('--editor-border', '#e5e7eb'),
    surface: read('--editor-surface', '#ffffff'),
    font: getComputedStyle(probe).fontFamily || 'sans-serif',
  };
}

function truncateLabel(name: string): string {
  return name.length > LABEL_MAX_CHARS ? `${name.slice(0, LABEL_MAX_CHARS - 1)}…` : name;
}

/** 图结构签名：节点与边都没变时刷新数据不重新加热布局 */
function graphSignature(graph: LinkGraph): string {
  return `${graph.nodes.map((node) => node.id).join('\n')}\n--\n${graph.edges.map((edge) => `${edge.source}>${edge.target}`).join('\n')}`;
}

export function LinkGraphView({ graph, focusId, onOpenNode, variant }: LinkGraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);

  // 渲染循环与交互状态都放在 ref 中：高频变化不触发 React 重渲染
  const simRef = useRef<ForceSimulation | null>(null);
  const signatureRef = useRef('');
  const metaRef = useRef(new Map<string, GraphNode>());
  const neighborsRef = useRef(new Map<string, Set<string>>());
  /** 各节点标签的半宽（屏幕像素），适应视图时避免标签被裁掉 */
  const labelHalfRef = useRef(new Map<string, number>());
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 });
  /** 未被用户平移 / 缩放前自动适应视图 */
  const autoFitRef = useRef(true);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const paletteRef = useRef<Palette | null>(null);
  const hoverRef = useRef<string | null>(null);
  const gestureRef = useRef<Gesture>({ type: 'none' });
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const frameRef = useRef(0);
  const focusRef = useRef(focusId);
  const onOpenRef = useRef(onOpenNode);
  focusRef.current = focusId;
  onOpenRef.current = onOpenNode;

  /** 屏幕坐标 → 世界坐标 */
  const toWorld = (x: number, y: number) => {
    const { x: tx, y: ty, k } = transformRef.current;
    return { x: (x - tx) / k, y: (y - ty) / k };
  };

  /** 计算能容纳全部节点及其标签的视图变换（标签是屏幕固定尺寸，需迭代求缩放） */
  const fitTransform = useCallback((): Transform | null => {
    const sim = simRef.current;
    const { width, height } = sizeRef.current;
    if (!sim || sim.nodes.length === 0 || width === 0 || height === 0) return null;
    const padding = variant === 'full' ? 40 : 12;
    const availableW = Math.max(width - padding * 2, 1);
    const availableH = Math.max(height - padding * 2, 1);
    /** 给定缩放下内容在屏幕上的范围 */
    const extents = (k: number) => {
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (const node of sim.nodes) {
        const r = radiusOf(metaRef.current.get(node.id)) * k;
        const half = Math.max(r, labelHalfRef.current.get(node.id) ?? 0);
        left = Math.min(left, node.x * k - half);
        right = Math.max(right, node.x * k + half);
        top = Math.min(top, node.y * k - r);
        // 标签在节点下方
        bottom = Math.max(bottom, node.y * k + r + LABEL_SIZE + 6);
      }
      return { left, right, top, bottom };
    };
    // 节点很少时不要放得过大
    let k = variant === 'full' ? 2.2 : 1.8;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const box = extents(k);
      const scale = Math.min(availableW / Math.max(box.right - box.left, 1), availableH / Math.max(box.bottom - box.top, 1));
      if (scale >= 0.995) break;
      k = Math.max(MIN_SCALE, k * scale);
      if (k === MIN_SCALE) break;
    }
    const box = extents(k);
    return { k, x: width / 2 - (box.left + box.right) / 2, y: height / 2 - (box.top + box.bottom) / 2 };
  }, [variant]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    const palette = paletteRef.current;
    const { width, height, dpr } = sizeRef.current;
    if (!canvas || !sim || !palette || width === 0 || height === 0) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const { x: tx, y: ty, k } = transformRef.current;
    const meta = metaRef.current;
    const hover = hoverRef.current;
    const focus = focusRef.current;
    const related = hover ? neighborsRef.current.get(hover) ?? new Set<string>() : null;
    const isActive = (id: string) => !hover || id === hover || related!.has(id);

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);

    // ── 边（世界坐标，线宽保持 1 像素） ──
    context.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    context.lineWidth = 1 / k;
    context.strokeStyle = palette.muted;
    context.globalAlpha = hover ? 0.1 : 0.4;
    context.beginPath();
    const highlighted: SimLink[] = [];
    for (const link of sim.links) {
      if (hover && (link.source.id === hover || link.target.id === hover)) {
        highlighted.push(link);
        continue;
      }
      context.moveTo(link.source.x, link.source.y);
      context.lineTo(link.target.x, link.target.y);
    }
    context.stroke();
    if (highlighted.length > 0) {
      context.globalAlpha = 0.95;
      context.strokeStyle = palette.accent;
      context.lineWidth = 1.6 / k;
      context.beginPath();
      for (const link of highlighted) {
        context.moveTo(link.source.x, link.source.y);
        context.lineTo(link.target.x, link.target.y);
      }
      context.stroke();
    }

    // ── 节点 ──
    for (const node of sim.nodes) {
      const info = meta.get(node.id);
      const r = radiusOf(info) + (node.id === focus ? 1.5 : 0);
      context.globalAlpha = isActive(node.id) ? 1 : 0.22;
      context.beginPath();
      if (info?.kind === 'file') {
        // 附件（画板、思维导图等）画成圆角方块：部分主题的链接色与强调色接近，靠形状区分
        const side = r * 1.7;
        // 较老的 WebKit（Linux / 旧版 macOS）没有 roundRect，退回直角方块
        if (typeof context.roundRect === 'function') context.roundRect(node.x - side / 2, node.y - side / 2, side, side, side * 0.28);
        else context.rect(node.x - side / 2, node.y - side / 2, side, side);
      } else {
        context.arc(node.x, node.y, r, 0, Math.PI * 2);
      }
      if (info?.kind === 'unresolved') {
        // 未创建的笔记：空心虚线圈
        context.fillStyle = palette.surface;
        context.fill();
        context.setLineDash([2 / k, 2 / k]);
        context.lineWidth = 1.2 / k;
        context.strokeStyle = palette.muted;
        context.stroke();
        context.setLineDash([]);
        continue;
      }
      context.fillStyle = node.id === focus || node.id === hover
        ? palette.accent
        : info?.kind === 'file'
          ? palette.link
          : palette.muted;
      context.fill();
      if (node.id === focus) {
        // 当前笔记外加一圈描边
        context.lineWidth = 2 / k;
        context.strokeStyle = palette.surface;
        context.stroke();
        context.beginPath();
        context.arc(node.x, node.y, r + 2.5 / k, 0, Math.PI * 2);
        context.lineWidth = 1.2 / k;
        context.strokeStyle = palette.accent;
        context.stroke();
      }
    }

    // ── 标签（屏幕坐标，字号不随缩放变化） ──
    const threshold = variant === 'full' ? 1.15 : 1;
    const fewNodes = sim.nodes.length <= (variant === 'full' ? 40 : 24);
    const zoomAlpha = fewNodes ? 1 : clamp((k - (threshold - 0.35)) / 0.35, 0, 1);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.font = `${LABEL_SIZE}px ${palette.font}`;
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.lineJoin = 'round';
    context.lineWidth = 3;
    context.strokeStyle = palette.surface;
    for (const node of sim.nodes) {
      const important = node.id === focus || node.id === hover || Boolean(related?.has(node.id));
      let alpha = important ? 1 : zoomAlpha;
      if (hover && !important) alpha *= 0.25;
      if (alpha <= 0.02) continue;
      const info = meta.get(node.id);
      const sx = node.x * k + tx;
      const sy = node.y * k + ty + (radiusOf(info) + 2) * k + 2;
      // 画布外的标签跳过
      if (sx < -80 || sx > width + 80 || sy < -20 || sy > height + 20) continue;
      const label = truncateLabel(info?.name ?? '');
      context.globalAlpha = alpha;
      context.strokeText(label, sx, sy);
      context.fillStyle = node.id === focus || node.id === hover ? palette.accent : info?.kind === 'unresolved' ? palette.muted : palette.text;
      context.fillText(label, sx, sy);
    }
    context.globalAlpha = 1;
  }, [variant]);

  /** 下一帧：推进布局、自动适应视图并重绘；仍有运动时继续循环 */
  const schedule = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const sim = simRef.current;
      let keepGoing = false;
      if (sim?.active) {
        sim.tick();
        keepGoing = true;
      }
      if (autoFitRef.current) {
        const target = fitTransform();
        if (target) {
          // 平滑逼近目标，避免布局抖动时视图跟着跳
          const current = transformRef.current;
          const ease = 0.2;
          const next = {
            x: current.x + (target.x - current.x) * ease,
            y: current.y + (target.y - current.y) * ease,
            k: current.k + (target.k - current.k) * ease,
          };
          transformRef.current = next;
          if (Math.abs(target.k - next.k) > 0.002 || Math.abs(target.x - next.x) > 0.5 || Math.abs(target.y - next.y) > 0.5) {
            keepGoing = true;
          }
        }
      }
      draw();
      if (keepGoing) schedule();
    });
  }, [draw, fitTransform]);

  // 数据变化：重建布局（沿用已有节点位置），结构未变时只更新节点信息
  useEffect(() => {
    metaRef.current = new Map(graph.nodes.map((node) => [node.id, node]));
    const neighbors = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      if (!neighbors.has(edge.source)) neighbors.set(edge.source, new Set());
      if (!neighbors.has(edge.target)) neighbors.set(edge.target, new Set());
      neighbors.get(edge.source)!.add(edge.target);
      neighbors.get(edge.target)!.add(edge.source);
    }
    neighborsRef.current = neighbors;
    // 量取标签宽度（字体在主题读取前未知时退回无衬线字体，误差可忽略）
    const measure = document.createElement('canvas').getContext('2d');
    const labelHalf = new Map<string, number>();
    if (measure) {
      measure.font = `${LABEL_SIZE}px ${paletteRef.current?.font ?? 'sans-serif'}`;
      for (const node of graph.nodes) labelHalf.set(node.id, measure.measureText(truncateLabel(node.name)).width / 2 + 2);
    }
    labelHalfRef.current = labelHalf;

    const signature = graphSignature(graph);
    if (signature === signatureRef.current && simRef.current) {
      schedule();
      return;
    }
    signatureRef.current = signature;
    const previousSim = simRef.current;
    const previous = new Map((previousSim?.nodes ?? []).map((node) => [node.id, { x: node.x, y: node.y }]));
    const positions = seedPositions(
      graph.nodes.map((node) => node.id),
      (id) => [...(neighbors.get(id) ?? [])],
      previous,
    );
    const nodes: SimNode[] = graph.nodes.map((node) => {
      const position = positions.get(node.id)!;
      return { id: node.id, x: position.x, y: position.y, vx: 0, vy: 0, fx: null, fy: null };
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const links: SimLink[] = graph.edges
      .map((edge) => ({ source: byId.get(edge.source)!, target: byId.get(edge.target)! }))
      .filter((link) => link.source && link.target);
    const sim = new ForceSimulation(nodes, links);
    simRef.current = sim;
    hoverRef.current = null;
    autoFitRef.current = true;

    if (!previousSim) {
      // 首次布局：同步预演一段时间，打开时直接呈现大致成形的图
      const startedAt = performance.now();
      while (sim.active && performance.now() - startedAt < PRERUN_BUDGET_MS) sim.tick();
      const fit = fitTransform();
      if (fit) transformRef.current = fit;
    } else {
      // 数据刷新：温和地重新加热，已有节点基本保持原位
      sim.alpha = 0.5;
    }
    schedule();
  }, [graph, fitTransform, schedule]);

  // 当前文档变化（全屏图谱切换笔记）后重绘高亮
  useEffect(() => {
    schedule();
  }, [focusId, schedule]);

  // 尺寸跟随容器（含设备像素比）
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { width: rect.width, height: rect.height, dpr };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      // 首次拿到尺寸时直接对齐视图
      if (autoFitRef.current) {
        const fit = fitTransform();
        if (fit) transformRef.current = fit;
      }
      schedule();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [fitTransform, schedule]);

  // 主题：读取一次，并在 data-theme / 内联变量变化时重新读取
  useEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;
    const refresh = () => {
      paletteRef.current = readPalette(probe);
      schedule();
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    return () => observer.disconnect();
  }, [schedule]);

  // 卸载时停止动画
  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }, []);

  /** 命中测试：返回指针下的节点（后绘制的在上层，倒序查找） */
  const hitTest = useCallback((screenX: number, screenY: number): SimNode | null => {
    const sim = simRef.current;
    if (!sim) return null;
    const { x, y } = toWorld(screenX, screenY);
    const k = transformRef.current.k;
    for (let index = sim.nodes.length - 1; index >= 0; index -= 1) {
      const node = sim.nodes[index];
      // 触控与小节点放宽命中范围（至少约 8 个屏幕像素）
      const r = Math.max(radiusOf(metaRef.current.get(node.id)) + 2 / k, 8 / k);
      const dx = node.x - x;
      const dy = node.y - y;
      if (dx * dx + dy * dy <= r * r) return node;
    }
    return null;
  }, []);

  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /** 以屏幕上的某点为中心缩放 */
  const zoomAt = useCallback((screenX: number, screenY: number, nextK: number, origin = transformRef.current) => {
    const k = clamp(nextK, MIN_SCALE, MAX_SCALE);
    const worldX = (screenX - origin.x) / origin.k;
    const worldY = (screenY - origin.y) / origin.k;
    transformRef.current = { k, x: screenX - worldX * k, y: screenY - worldY * k };
    autoFitRef.current = false;
    schedule();
  }, [schedule]);

  const setHover = (id: string | null) => {
    if (hoverRef.current === id) return;
    hoverRef.current = id;
    if (canvasRef.current) canvasRef.current.style.cursor = id ? 'pointer' : 'grab';
    schedule();
  };

  // 滚轮缩放需要非被动监听才能阻止页面滚动
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = localPoint(event);
      // 触控板双指滑动（无 ctrl）较细腻，鼠标滚轮单格约 100
      const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
      zoomAt(point.x, point.y, transformRef.current.k * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015)));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const releaseNode = (node: SimNode) => {
    node.fx = null;
    node.fy = null;
    if (simRef.current) simRef.current.alphaTarget = 0;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const canvas = canvasRef.current!;
    canvas.setPointerCapture(event.pointerId);
    const point = localPoint(event);
    pointersRef.current.set(event.pointerId, point);

    if (pointersRef.current.size === 2) {
      // 第二根手指落下：转为双指缩放，放开正在拖动的节点
      const gesture = gestureRef.current;
      if (gesture.type === 'node') releaseNode(gesture.node);
      const [a, b] = [...pointersRef.current.values()];
      gestureRef.current = {
        type: 'pinch',
        distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        origin: { ...transformRef.current },
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      };
      return;
    }
    if (pointersRef.current.size > 2) return;

    const node = hitTest(point.x, point.y);
    if (node) {
      gestureRef.current = { type: 'node', node, startX: point.x, startY: point.y, moved: false };
      if (event.pointerType !== 'mouse') setHover(node.id);
    } else {
      gestureRef.current = { type: 'pan', startX: point.x, startY: point.y, origin: { ...transformRef.current }, moved: false };
      canvas.style.cursor = 'grabbing';
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, point);
    const gesture = gestureRef.current;

    if (gesture.type === 'none') {
      // 仅鼠标悬停时高亮
      if (event.pointerType === 'mouse') setHover(hitTest(point.x, point.y)?.id ?? null);
      return;
    }
    if (gesture.type === 'pinch') {
      const [a, b] = [...pointersRef.current.values()];
      if (!a || !b) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      // 先按缩放比例绕起始中点缩放，再叠加中点的平移
      const { origin } = gesture;
      const k = clamp(origin.k * (distance / gesture.distance), MIN_SCALE, MAX_SCALE);
      const worldX = (gesture.midX - origin.x) / origin.k;
      const worldY = (gesture.midY - origin.y) / origin.k;
      transformRef.current = { k, x: midX - worldX * k, y: midY - worldY * k };
      autoFitRef.current = false;
      schedule();
      return;
    }
    const moved = Math.hypot(point.x - gesture.startX, point.y - gesture.startY) > DRAG_THRESHOLD;
    if (gesture.type === 'pan') {
      if (!gesture.moved && !moved) return;
      gesture.moved = true;
      transformRef.current = {
        k: gesture.origin.k,
        x: gesture.origin.x + point.x - gesture.startX,
        y: gesture.origin.y + point.y - gesture.startY,
      };
      autoFitRef.current = false;
      schedule();
      return;
    }
    // 拖动节点：超过阈值后才固定节点并加热布局，单击不会扰动布局
    if (!gesture.moved && !moved) return;
    if (!gesture.moved) {
      gesture.moved = true;
      autoFitRef.current = false;
      if (simRef.current) {
        simRef.current.alphaTarget = 0.25;
        simRef.current.reheat(0.25);
      }
      setHover(gesture.node.id);
    }
    const world = toWorld(point.x, point.y);
    gesture.node.fx = world.x;
    gesture.node.fy = world.y;
    schedule();
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(event.pointerId);
    const gesture = gestureRef.current;
    const canvas = canvasRef.current!;

    if (gesture.type === 'pinch') {
      // 抬起一根手指后用剩下的手指继续平移
      const rest = [...pointersRef.current.values()][0];
      gestureRef.current = rest
        ? { type: 'pan', startX: rest.x, startY: rest.y, origin: { ...transformRef.current }, moved: true }
        : { type: 'none' };
      return;
    }
    if (pointersRef.current.size > 0) return;
    gestureRef.current = { type: 'none' };

    if (gesture.type === 'node') {
      releaseNode(gesture.node);
      if (event.type === 'pointerup' && !gesture.moved) {
        const info = metaRef.current.get(gesture.node.id);
        if (info) {
          // 打开笔记：移除面板保留标记，让移动端大纲面板随之收起（click 在 pointerup 之后派发）
          canvas.removeAttribute('data-sheet-keep');
          window.setTimeout(() => canvas.setAttribute('data-sheet-keep', ''), 0);
          onOpenRef.current(info);
        }
      }
      if (event.pointerType !== 'mouse') setHover(null);
      schedule();
    }
    canvas.style.cursor = hoverRef.current ? 'pointer' : 'grab';
  };

  const zoomBy = (factor: number) => {
    const { width, height } = sizeRef.current;
    zoomAt(width / 2, height / 2, transformRef.current.k * factor);
  };

  return (
    <div ref={containerRef} className={`nb-graph-view is-${variant}`}>
      {/* 探针：读取主题变量的计算值与界面字体 */}
      <span ref={probeRef} className="nb-graph-probe" aria-hidden="true" />
      <canvas
        ref={canvasRef}
        className="nb-graph-canvas"
        data-sheet-keep=""
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse' && gestureRef.current.type === 'none') setHover(null);
        }}
      />
      <div className="nb-graph-controls" data-sheet-keep="">
        <Tooltip content="放大">
          <button type="button" className="nb-graph-control" aria-label="放大" onClick={() => zoomBy(1.3)}>
            <Plus size={14} />
          </button>
        </Tooltip>
        <Tooltip content="缩小">
          <button type="button" className="nb-graph-control" aria-label="缩小" onClick={() => zoomBy(1 / 1.3)}>
            <Minus size={14} />
          </button>
        </Tooltip>
        <Tooltip content="适应视图">
          <button
            type="button"
            className="nb-graph-control"
            aria-label="适应视图"
            onClick={() => {
              autoFitRef.current = true;
              schedule();
            }}
          >
            <Maximize size={13} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
