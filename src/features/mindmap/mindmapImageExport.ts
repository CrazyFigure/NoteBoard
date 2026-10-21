// NoteBoard 思维导图导出 PNG / JPG
// 不克隆页面 DOM（会带入选中框、悬停工具栏等交互元素，且 SVG 图片无法使用页面网页字体），
// 而是按当前布局 / 配色 / 连线样式 / 宽度设置独立排版一次，再用 Canvas 2D 逐一绘制节点与连线。
// 画布尺寸取排版包围盒加四周留白，因此导出内容始终位于图片正中，与当前视口位置无关。
// 详见 docs/09-开发路线图.md

import type {
  MindNode,
  MindmapEdgeStyle,
  MindmapImageFit,
  MindmapLayout,
  MindmapTextAlign,
} from './mindmapTypes';
import { boldWeight, splitStyledRuns } from './mindmapRichText';
import type { MindmapTheme } from './mindmapTheme';
import {
  computeMindmapLayout,
  titleBlockHeight,
  type LayoutDecoration,
  type LayoutLink,
  type LayoutNode,
} from './mindmapLayout';
import {
  buildFont,
  getNodeTextStyle,
  getSharedTextMeasurer,
  NODE_BORDER_WIDTH,
  NOTE_FONT_SIZE,
  NOTE_LINE_HEIGHT,
} from './mindmapTextMeasure';
import {
  computeMindmapStructures,
  BOUNDARY_TITLE_FONT_SIZE,
  BOUNDARY_TITLE_HEIGHT,
  RELATION_FONT_SIZE,
  RELATION_LINE_HEIGHT,
  SUMMARY_FONT_SIZE,
  SUMMARY_LINE_HEIGHT,
  type MindmapStructureLayout,
  type Rect,
} from './mindmapStructures';

export type MindmapImageFormat = 'png' | 'jpeg';

export interface MindmapImageExportOptions {
  root: MindNode;
  layout: MindmapLayout;
  theme: MindmapTheme;
  edgeStyle: MindmapEdgeStyle;
  maxNodeWidth: number;
  defaultTextAlign?: MindmapTextAlign;
  defaultImageFit?: MindmapImageFit;
  fontFamily: string;
  format: MindmapImageFormat;
  /** 输出倍率，默认 3 倍 */
  scale?: number;
}

/** 图片四周留白 */
export const EXPORT_PADDING = 48;
/** 单边像素上限与总像素上限（超出后自动降低倍率，避免浏览器画布创建失败） */
const MAX_CANVAS_SIDE = 16000;
const MAX_CANVAS_AREA = 60_000_000;
/** 图片框上边距 */
const IMAGE_THUMB_MARGIN = 4;

// ── 纯函数工具（便于单元测试） ──

/** 解析 path 中所有坐标点的包围盒（本模块生成的 path 只含绝对坐标的 M / L / Q / C / Z） */
export function pathBounds(d: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const nums = (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi) ?? []).map(Number);
  if (nums.length < 2) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minX = Math.min(minX, nums[i]);
    maxX = Math.max(maxX, nums[i]);
    minY = Math.min(minY, nums[i + 1]);
    maxY = Math.max(maxY, nums[i + 1]);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 计算导出画布尺寸与内容平移量：包围盒涵盖节点、连线与装饰线，四周统一留白
 */
export function computeExportFrame(
  nodes: LayoutNode[],
  links: LayoutLink[],
  decorations: LayoutDecoration[],
  padding = EXPORT_PADDING,
  /** 概要 / 外框 / 联系线等伸出节点范围的元素 */
  extraBounds?: Rect | null,
): { width: number; height: number; offsetX: number; offsetY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  if (extraBounds) {
    minX = Math.min(minX, extraBounds.x);
    minY = Math.min(minY, extraBounds.y);
    maxX = Math.max(maxX, extraBounds.x + extraBounds.width);
    maxY = Math.max(maxY, extraBounds.y + extraBounds.height);
  }
  for (const d of [...links.map((l) => l.path), ...decorations.map((dec) => dec.path)]) {
    const b = pathBounds(d);
    if (!b) continue;
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  return {
    width: Math.ceil(maxX - minX + padding * 2),
    height: Math.ceil(maxY - minY + padding * 2),
    offsetX: padding - minX,
    offsetY: padding - minY,
  };
}

/** 按顶层逗号拆分（忽略括号内的逗号） */
function splitTopLevel(input: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * 把 var(--x, fallback) 替换为计算后的具体值（支持嵌套与带括号的回退值）
 * @param lookup 读取 CSS 自定义属性的函数，缺省读 documentElement 的计算样式
 */
export function resolveCssVars(value: string, lookup?: (name: string) => string): string {
  const read =
    lookup ??
    ((name: string) => window.getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  let result = value;
  // 由内向外逐个替换，限制次数避免异常输入死循环
  for (let guard = 0; guard < 32; guard += 1) {
    const start = result.lastIndexOf('var(');
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = start + 3; i < result.length; i += 1) {
      if (result[i] === '(') depth += 1;
      else if (result[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    const inner = result.slice(start + 4, end);
    const [name, ...rest] = splitTopLevel(inner);
    const fallback = rest.join(',').trim();
    const resolved = read(name.trim()) || fallback;
    result = result.slice(0, start) + resolved + result.slice(end + 1);
  }
  return result.trim();
}

/** RGBA 颜色分量（0-255，alpha 0-1） */
export type Rgba = [number, number, number, number];

/** 解析 #rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba()，无法解析时返回 null */
export function parseColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase();
  if (value === 'transparent') return [0, 0, 0, 0];
  const hex = value.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  const fn = value.match(/^rgba?\(([^)]*)\)$/);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
  }
  return null;
}

/** 输出 rgba() 字符串 */
export function formatRgba([r, g, b, a]: Rgba): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(a * 1000) / 1000})`;
}

/** 等价于 CSS color-mix(in srgb, a percent%, b) */
export function mixColors(a: string, b: string, percentOfA: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return b;
  const t = Math.min(100, Math.max(0, percentOfA)) / 100;
  return formatRgba([
    ca[0] * t + cb[0] * (1 - t),
    ca[1] * t + cb[1] * (1 - t),
    ca[2] * t + cb[2] * (1 - t),
    ca[3] * t + cb[3] * (1 - t),
  ]);
}

/** 解析 linear-gradient(角度, 色标...)；非渐变返回 null */
export function parseLinearGradient(value: string): { angle: number; stops: string[] } | null {
  const match = value.trim().match(/^linear-gradient\((.*)\)$/i);
  if (!match) return null;
  const parts = splitTopLevel(match[1]);
  let angle = 180;
  if (parts[0] && /^-?\d+(\.\d+)?deg$/i.test(parts[0])) {
    angle = parseFloat(parts.shift()!);
  } else if (parts[0] && /^to\s/i.test(parts[0])) {
    const dir = parts.shift()!.toLowerCase();
    angle = dir.includes('right') ? 90 : dir.includes('left') ? 270 : dir.includes('top') ? 0 : 180;
  }
  // 色标只取颜色部分，忽略位置百分比
  const stops = parts.map((p) => splitTopLevel(p, ' ')[0]).filter(Boolean);
  return stops.length > 0 ? { angle, stops } : null;
}

/** 解析单层 box-shadow：offsetX offsetY blur color */
export function parseBoxShadow(value: string): { x: number; y: number; blur: number; color: string } | null {
  const parts = splitTopLevel(value.trim(), ' ');
  const lengths: number[] = [];
  let color = '';
  for (const p of parts) {
    if (/^-?\d+(\.\d+)?(px)?$/.test(p)) lengths.push(parseFloat(p));
    else color = p;
  }
  if (lengths.length < 2 || !color) return null;
  return { x: lengths[0], y: lengths[1], blur: lengths[2] ?? 0, color };
}

// ── 绘制 ──

/** 加载图片；跨域或损坏时返回 null（跳过绘制而不是让整次导出失败） */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    if (!src.startsWith('data:') && !src.startsWith('blob:')) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** 绘制圆角矩形路径 */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** 把 CSS 背景值（纯色 / 线性渐变）转成 canvas 填充样式 */
function resolveFill(
  ctx: CanvasRenderingContext2D,
  value: string,
  rect: { x: number; y: number; w: number; h: number },
): string | CanvasGradient {
  const resolved = resolveCssVars(value);
  const gradient = parseLinearGradient(resolved);
  if (!gradient) return resolved;
  // CSS 角度：0deg 指向上方，顺时针增加；渐变线长度按矩形对角投影计算
  const rad = (gradient.angle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const half = (Math.abs(rect.w * dx) + Math.abs(rect.h * dy)) / 2;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  gradient.stops.forEach((stop, idx) => {
    g.addColorStop(gradient.stops.length === 1 ? 0 : idx / (gradient.stops.length - 1), stop);
  });
  return g;
}

/** 以「裁切填满」方式绘制图片 */
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih || w <= 0 || h <= 0) return;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

/** 绘制单个节点卡片 */
function drawNode(
  ctx: CanvasRenderingContext2D,
  n: LayoutNode,
  theme: MindmapTheme,
  fontFamily: string,
  images: Map<string, HTMLImageElement | null>,
) {
  const isRoot = n.level === 0;
  const style = getNodeTextStyle(n.level);
  const branchColor = theme.branchColors[n.branchIndex % theme.branchColors.length] ?? theme.branchColors[0];
  const surface = resolveCssVars('var(--editor-surface, #ffffff)');
  const radius = isRoot ? 10 : 8;
  const rect = { x: n.x, y: n.y, w: n.width, h: n.height };

  // 1. 背景与投影
  ctx.save();
  const shadow = parseBoxShadow(isRoot ? theme.rootShadow : '0 2px 6px rgba(0, 0, 0, 0.05)');
  if (shadow) {
    ctx.shadowColor = shadow.color;
    ctx.shadowOffsetX = shadow.x;
    ctx.shadowOffsetY = shadow.y;
    ctx.shadowBlur = shadow.blur;
  }
  roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
  if (isRoot) {
    ctx.fillStyle = resolveFill(ctx, theme.rootBackground, rect);
  } else {
    ctx.fillStyle = theme.nodeTint ? mixColors(branchColor, surface, theme.nodeTint) : surface;
  }
  ctx.fill();
  ctx.restore();

  // 2. 边框（border-box：描边向内收半个线宽）
  if (!isRoot) {
    const bw = NODE_BORDER_WIDTH;
    roundRectPath(ctx, rect.x + bw / 2, rect.y + bw / 2, rect.w - bw, rect.h - bw, radius - bw / 2);
    ctx.lineWidth = bw;
    ctx.strokeStyle = n.level === 1 ? branchColor : resolveCssVars('var(--editor-border, #cbd5e1)');
    ctx.stroke();
  }

  const textColor = isRoot ? theme.rootText : resolveCssVars('var(--editor-text, #1e293b)');
  const hasNote = n.noteLines.length > 0;
  const hasImage = Boolean(n.node.image);
  const contentLeft = n.x + style.insetX;
  const contentWidth = n.width - style.insetX * 2;
  const titleHeight = titleBlockHeight(n.level, n.titleLines.length);
  const titleTop = n.y + style.insetY;
  const iconWidth = n.node.icon ? style.iconWidth : 0;

  ctx.textBaseline = 'middle';

  // 3. 前置图标（与 DOM 中图标按钮居中位置一致）
  if (n.node.icon) {
    ctx.font = buildFont(style.iconSize, 400, fontFamily);
    ctx.textAlign = 'center';
    ctx.fillStyle = textColor;
    ctx.fillText(n.node.icon, contentLeft + (iconWidth - 4) / 2, titleTop + titleHeight / 2);
  }

  // 4. 标题各行（行块在标题区内垂直居中）：按富文本片段逐段绘制字体、颜色、高亮与划线
  const alignCenter = n.textAlign === 'center';
  ctx.textAlign = 'left';
  const linesLeft = contentLeft + iconWidth;
  const linesWidth = contentWidth - iconWidth;
  const linesTop = titleTop + (titleHeight - n.titleLines.length * style.lineHeight) / 2;
  n.titleLines.forEach((line, idx) => {
    if (!line.text) return;
    const lineTop = linesTop + idx * style.lineHeight;
    const midY = lineTop + style.lineHeight / 2;
    const runs = splitStyledRuns(n.marks, line.start, line.start + line.text.length).map((run) => {
      const font = buildFont(
        style.fontSize,
        run.style.bold ? boldWeight(style.fontWeight) : style.fontWeight,
        fontFamily,
        Boolean(run.style.italic),
      );
      const text = line.text.slice(run.start - line.start, run.end - line.start);
      ctx.font = font;
      return { ...run, text, font, width: ctx.measureText(text).width };
    });
    const total = runs.reduce((sum, r) => sum + r.width, 0);
    let x = alignCenter ? linesLeft + (linesWidth - total) / 2 : linesLeft;
    for (const run of runs) {
      if (run.style.highlight) {
        ctx.fillStyle = run.style.highlight;
        ctx.fillRect(x, lineTop + 1, run.width, style.lineHeight - 2);
      }
      const color = run.style.color ?? textColor;
      ctx.font = run.font;
      ctx.fillStyle = color;
      ctx.fillText(run.text, x, midY);
      // 下划线 / 删除线
      const lines: number[] = [];
      if (run.style.underline) lines.push(midY + style.fontSize * 0.55);
      if (run.style.strike) lines.push(midY + style.fontSize * 0.05);
      for (const y of lines) {
        ctx.fillRect(x, Math.round(y), run.width, 1);
      }
      x += run.width;
    }
  });

  let cursorY = titleTop + titleHeight;

  // 5. 备注：分隔线 + 浅色小字
  if (hasNote) {
    const dividerY = cursorY + 3;
    ctx.fillStyle = isRoot ? 'rgba(255, 255, 255, 0.2)' : resolveCssVars('var(--editor-border, #f1f5f9)');
    ctx.fillRect(contentLeft, dividerY, contentWidth, 1);
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.font = buildFont(NOTE_FONT_SIZE, 400, fontFamily);
    ctx.textAlign = 'left';
    ctx.fillStyle = isRoot ? 'rgba(255, 255, 255, 0.85)' : resolveCssVars('var(--editor-text-secondary, #64748b)');
    const notesTop = dividerY + 1 + 3;
    n.noteLines.forEach((line, idx) => {
      if (line) ctx.fillText(line, contentLeft, notesTop + idx * NOTE_LINE_HEIGHT + NOTE_LINE_HEIGHT / 2);
    });
    ctx.restore();
    cursorY = notesTop + n.noteLines.length * NOTE_LINE_HEIGHT;
  }

  // 6. 图片：原始比例完整绘制，宽度填充裁切铺满
  if (hasImage && n.imageBox) {
    const img = images.get(n.node.image!);
    const boxWidth = n.imageBox.width + 2;
    const boxHeight = n.imageBox.height + 2;
    const boxLeft = alignCenter ? contentLeft + (contentWidth - boxWidth) / 2 : contentLeft;
    const boxTop = cursorY + IMAGE_THUMB_MARGIN;
    ctx.save();
    roundRectPath(ctx, boxLeft, boxTop, boxWidth, boxHeight, 4);
    ctx.clip();
    if (img) {
      if (n.imageBox.fit === 'fill') {
        drawImageCover(ctx, img, boxLeft + 1, boxTop + 1, n.imageBox.width, n.imageBox.height);
      } else {
        ctx.drawImage(img, boxLeft + 1, boxTop + 1, n.imageBox.width, n.imageBox.height);
      }
    }
    ctx.restore();
    roundRectPath(ctx, boxLeft + 0.5, boxTop + 0.5, boxWidth - 1, boxHeight - 1, 4);
    ctx.lineWidth = 1;
    ctx.strokeStyle = resolveCssVars('var(--editor-border, rgba(0,0,0,0.08))');
    ctx.stroke();
  }
}

/** 结构元素绘制阶段：外框在连线下方，概要在节点同层，联系线在节点上方 */
type StructurePhase = 'below' | 'middle' | 'above';

/** 绘制概要 / 外框 / 联系线（与画布 DOM 渲染保持同样的颜色与线型） */
function drawStructures(
  ctx: CanvasRenderingContext2D,
  structures: MindmapStructureLayout,
  theme: MindmapTheme,
  fontFamily: string,
  phase: StructurePhase,
) {
  const branchColor = (index: number) => theme.branchColors[index % theme.branchColors.length] ?? theme.branchColors[0];
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.textBaseline = 'middle';
  if (phase === 'below') {
    // 外框：浅色底 + 虚线边
    for (const b of structures.boundaries) {
      const color = branchColor(b.branchIndex);
      roundRectPath(ctx, b.rect.x, b.rect.y, b.rect.width, b.rect.height, 12);
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 0.75;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  } else if (phase === 'middle') {
    const surface = resolveCssVars('var(--editor-surface, #ffffff)');
    // 外框标题标签
    for (const b of structures.boundaries) {
      if (!b.titleBox || !b.titleText) continue;
      const box = b.titleBox;
      roundRectPath(ctx, box.x, box.y, box.width, box.height, BOUNDARY_TITLE_HEIGHT / 2);
      ctx.fillStyle = branchColor(b.branchIndex);
      ctx.fill();
      ctx.font = buildFont(BOUNDARY_TITLE_FONT_SIZE, 500, fontFamily);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(b.titleText, box.x + 7, box.y + box.height / 2);
    }
    // 概要：大括号 + 文字框
    for (const s of structures.summaries) {
      const color = branchColor(s.branchIndex);
      ctx.globalAlpha = theme.edgeOpacity;
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = color;
      ctx.stroke(new Path2D(s.bracePath));
      ctx.globalAlpha = 1;
      const { label } = s;
      roundRectPath(ctx, label.x, label.y, label.width, label.height, 8);
      ctx.fillStyle = theme.nodeTint ? mixColors(color, surface, theme.nodeTint) : surface;
      ctx.fill();
      roundRectPath(ctx, label.x + 0.75, label.y + 0.75, label.width - 1.5, label.height - 1.5, 7.25);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = buildFont(SUMMARY_FONT_SIZE, 500, fontFamily);
      ctx.textAlign = 'center';
      ctx.fillStyle = resolveCssVars('var(--editor-text, #1e293b)');
      if (!s.text) ctx.globalAlpha = 0.5;
      const top = label.y + (label.height - s.lines.length * SUMMARY_LINE_HEIGHT) / 2;
      s.lines.forEach((line, idx) => ctx.fillText(line, label.x + label.width / 2, top + idx * SUMMARY_LINE_HEIGHT + SUMMARY_LINE_HEIGHT / 2));
      ctx.globalAlpha = 1;
    }
  } else {
    // 联系线：虚线曲线 + 实心箭头 + 底色文字
    const color = resolveCssVars('var(--editor-text-secondary, #64748b)');
    const background = resolveCssVars('var(--editor-bg, #ffffff)');
    for (const r of structures.relations) {
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = color;
      ctx.stroke(new Path2D(r.path));
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fill(new Path2D(r.arrowPath));
      if (r.labelBox && r.lines.length > 0) {
        const box = r.labelBox;
        roundRectPath(ctx, box.x, box.y, box.width, box.height, 4);
        ctx.fillStyle = background;
        ctx.fill();
        ctx.font = buildFont(RELATION_FONT_SIZE, 400, fontFamily);
        ctx.textAlign = 'center';
        ctx.fillStyle = color;
        const top = box.y + (box.height - r.lines.length * RELATION_LINE_HEIGHT) / 2;
        r.lines.forEach((line, idx) => ctx.fillText(line, box.x + box.width / 2, top + idx * RELATION_LINE_HEIGHT + RELATION_LINE_HEIGHT / 2));
      }
    }
  }
  ctx.restore();
}

/**
 * 按当前导图外观生成 PNG / JPG 图片
 */
export async function exportMindmapImageBlob(options: MindmapImageExportOptions): Promise<Blob> {
  const { root, layout, theme, edgeStyle, maxNodeWidth, fontFamily, format } = options;

  // 先加载全部节点图片：原始比例排版需要图片固有尺寸
  const images = new Map<string, HTMLImageElement | null>();
  const sources = new Set<string>();
  const collect = (node: MindNode) => {
    if (node.image) sources.add(node.image);
    if (node.isExpanded !== false) node.children.forEach(collect);
  };
  collect(root);
  await Promise.all([...sources].map(async (src) => images.set(src, await loadImage(src))));

  const { nodes, links, decorations } = computeMindmapLayout(root, layout, theme.branchColors.length, {
    maxNodeWidth,
    measure: getSharedTextMeasurer(),
    fontFamily,
    edgeStyle,
    defaultTextAlign: options.defaultTextAlign,
    defaultImageFit: options.defaultImageFit,
    imageSize: (src) => {
      const img = images.get(src);
      return img ? { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height } : undefined;
    },
  });
  const structures = computeMindmapStructures(nodes, { measure: getSharedTextMeasurer(), fontFamily });
  const frame = computeExportFrame(nodes, links, decorations, EXPORT_PADDING, structures.bounds);

  // 倍率：默认 3 倍（高分屏与放大查看都清晰），超出浏览器画布上限时自动降低
  const requested = options.scale && options.scale > 0 ? options.scale : 3;
  const scale = Math.max(
    0.25,
    Math.min(
      requested,
      MAX_CANVAS_SIDE / frame.width,
      MAX_CANVAS_SIDE / frame.height,
      Math.sqrt(MAX_CANVAS_AREA / (frame.width * frame.height)),
    ),
  );

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(frame.width * scale));
  canvas.height = Math.max(1, Math.round(frame.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 绘图上下文');

  // 背景跟随编辑器底色（深色主题下导出深色图）
  ctx.fillStyle = resolveCssVars('var(--editor-bg, #ffffff)');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(frame.offsetX, frame.offsetY);

  // 外框（最底层）
  drawStructures(ctx, structures, theme, fontFamily, 'below');

  // 装饰线（主轴 / 脊柱）
  const decoColor = resolveCssVars('var(--editor-text-secondary, #64748b)');
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const deco of decorations) {
    const path = new Path2D(deco.path);
    if (deco.filled) {
      ctx.fillStyle = decoColor;
      ctx.fill(path);
    }
    ctx.strokeStyle = decoColor;
    ctx.lineWidth = deco.strokeWidth;
    ctx.stroke(path);
  }
  ctx.restore();

  // 父子连线
  ctx.save();
  ctx.globalAlpha = theme.edgeOpacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const link of links) {
    ctx.strokeStyle =
      theme.branchColors[link.to.branchIndex % theme.branchColors.length] ?? theme.branchColors[0];
    ctx.lineWidth = link.from.level === 0 ? 2.5 : 1.8;
    ctx.stroke(new Path2D(link.path));
  }
  ctx.restore();

  // 外框标题与概要
  drawStructures(ctx, structures, theme, fontFamily, 'middle');

  // 节点卡片
  for (const n of nodes) {
    drawNode(ctx, n, theme, fontFamily, images);
  }

  // 联系线（节点上方）
  drawStructures(ctx, structures, theme, fontFamily, 'above');

  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('图片编码失败'))),
      mime,
      format === 'jpeg' ? 0.92 : undefined,
    );
  });
}
