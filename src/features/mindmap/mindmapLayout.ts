// NoteBoard 思维导图布局引擎
// 自研紧凑无重叠树布局 (Tidy Tree)，支持逻辑图（向右 / 向左 / 双向平衡）、组织图（向下 / 向上）、
// 树状图（右侧 / 左侧）、时间轴与鱼骨图，并为不同布局生成对应的连线路径。
// 节点尺寸按真实文字宽度测量并自动换行，宽度上限取自设置，手动拉伸的节点使用固定宽度。
// 详见 docs/09-开发路线图.md

import type {
  MindNode,
  MindmapLayout,
  MindmapEdgeStyle,
  MindmapImageFit,
  MindmapTextAlign,
} from './mindmapTypes';
import {
  boldWeight,
  markBoundaries,
  toStyleArray,
  type MindTextMark,
} from './mindmapRichText';
import type { ImageSize } from './mindmapImageSize';
import { fileLinkName } from './mindmapAttachments';
import {
  buildFont,
  createRangeMeasure,
  clampNodeMaxWidth,
  ellipsizeLine,
  estimateTextWidth,
  getNodeTextStyle,
  measureNaturalWidth,
  wrapText,
  FILE_FONT_SIZE,
  FILE_LIST_TOP_GAP,
  FILE_MIN_WIDTH,
  FILE_ROW_CHROME,
  FILE_ROW_GAP,
  FILE_ROW_HEIGHT,
  GALLERY_GAP,
  GALLERY_MAX_VISIBLE,
  GALLERY_MIN_WIDTH,
  IMAGE_BLOCK_HEIGHT,
  IMAGE_MIN_WIDTH,
  MAX_MANUAL_NODE_WIDTH,
  MIN_MANUAL_NODE_WIDTH,
  NOTE_FONT_SIZE,
  NOTE_LINE_HEIGHT,
  NOTE_MAX_LINES,
  NOTE_TOP_GAP,
  type RichFontSpec,
  type TextLine,
  type TextMeasure,
} from './mindmapTextMeasure';
import type {
  LayoutNode,
  LayoutLink,
  LayoutPlacement,
  LinkSpec,
  MindmapLayoutResult,
} from './layouts/layoutTypes';
import { INDENT_ANCHOR, layoutIndented } from './layouts/indented';
import { layoutTimeline } from './layouts/timeline';
import { layoutFishbone } from './layouts/fishbone';
import {
  horizontalLinkPath,
  indentLinkPath,
  straightPath,
  verticalLinkPath,
} from './layouts/linkPaths';

export type {
  LayoutNode,
  LayoutLink,
  LayoutDecoration,
  MindmapLayoutResult,
  NodeSide,
  SiblingFlow,
} from './layouts/layoutTypes';

/** 水平布局中父子层级间距 */
export const NODE_H_GAP = 54;
/** 水平布局中同级节点纵向间距 */
export const NODE_V_GAP = 18;
/** 垂直布局中父子层级间距 */
const TREE_LEVEL_GAP = 46;
/** 垂直布局中同级节点横向间距 */
const TREE_SIBLING_GAP = 26;
/** 文字测量的取整余量，避免亚像素误差导致渲染时意外折行 */
const WIDTH_SLACK = 2;

/** 布局计算选项 */
export interface MindmapLayoutOptions {
  /** 未手动拉伸的节点最大宽度（设置项） */
  maxNodeWidth?: number;
  /** 文字宽度测量函数（缺省为估算） */
  measure?: TextMeasure;
  /** 节点字体族 */
  fontFamily?: string;
  /** 临时宽度覆盖（拖拽拉伸预览） */
  widthOverrides?: ReadonlyMap<string, number>;
  /** 临时文本覆盖（编辑中的草稿，含富文本标记） */
  textOverrides?: ReadonlyMap<string, TextDraft>;
  /** 连线样式 */
  edgeStyle?: MindmapEdgeStyle;
  /** 节点未单独设置时的标题对齐（设置项，缺省左对齐） */
  defaultTextAlign?: MindmapTextAlign;
  /** 节点未单独设置时的图片显示方式（设置项，缺省原始比例） */
  defaultImageFit?: MindmapImageFit;
  /** 读取图片固有尺寸（原始比例排版用）；取不到时按宽度填充的固定高度占位 */
  imageSize?: (src: string) => ImageSize | undefined;
}

/** 编辑中的标题草稿 */
export interface TextDraft {
  text: string;
  marks?: MindTextMark[];
}

/** 节点图片显示框（不含边框） */
export interface ImageBox {
  fit: MindmapImageFit;
  width: number;
  height: number;
}

/** 多图网格（两张及以上图片时使用，单元格统一裁切铺满） */
export interface GalleryBox {
  columns: number;
  cellWidth: number;
  cellHeight: number;
  gap: number;
  /** 直接展示的张数；总数超出时末格叠加 +N */
  visibleCount: number;
  /** 网格整体宽高 */
  width: number;
  height: number;
}

/** 节点盒尺寸与换行结果 */
export interface NodeBox {
  width: number;
  height: number;
  titleLines: TextLine[];
  noteLines: string[];
  marks?: MindTextMark[];
  textAlign: MindmapTextAlign;
  imageBox?: ImageBox;
  gallery?: GalleryBox;
}

/** 宽度填充模式下缩略图的固定高度 */
export const FILL_IMAGE_HEIGHT = 54;
/** 图片框上边距 + 上下边框 */
const IMAGE_FRAME_EXTRA = 4 + 2;
/** 多图网格上边距（单元格各自带边框，网格本身无外框） */
export const GALLERY_TOP_GAP = 4;

/** 按格式取某字符的 canvas 字体 */
export function createRichFontSpec(
  text: string,
  marks: readonly MindTextMark[] | undefined,
  fontSize: number,
  fontWeight: number,
  fontFamily: string,
): RichFontSpec | undefined {
  if (!marks || marks.length === 0) return undefined;
  const styles = toStyleArray(text.length, marks);
  return {
    fontAt: (index) => {
      const st = styles[index] ?? {};
      return buildFont(fontSize, st.bold ? boldWeight(fontWeight) : fontWeight, fontFamily, Boolean(st.italic));
    },
    boundaries: markBoundaries(marks),
  };
}

/** 节点因附件所需的最小宽度：多图网格 > 单图 > 文件链接 */
export function attachmentMinWidth(node: Pick<MindNode, 'images' | 'files'>): number {
  const imageCount = node.images?.length ?? 0;
  if (imageCount > 1) return GALLERY_MIN_WIDTH;
  if (imageCount === 1) return IMAGE_MIN_WIDTH;
  return node.files?.length ? FILE_MIN_WIDTH : 0;
}

/** 手动宽度的合法区间（挂图片 / 文件的节点最小宽度更大） */
export function clampManualWidth(width: number, minWidth = 0): number {
  const min = Math.max(MIN_MANUAL_NODE_WIDTH, minWidth);
  return Math.min(MAX_MANUAL_NODE_WIDTH, Math.max(min, Math.round(width)));
}

/** 多图网格排布：2 / 4 张两列，其余三列；三列为方格，两列为 4:3 */
export function computeGalleryBox(imageCount: number, availableWidth: number): GalleryBox {
  const columns = imageCount === 2 || imageCount === 4 ? 2 : 3;
  const visibleCount = Math.min(imageCount, GALLERY_MAX_VISIBLE);
  const rows = Math.ceil(visibleCount / columns);
  const cellWidth = Math.max(1, Math.floor((availableWidth - GALLERY_GAP * (columns - 1)) / columns));
  const cellHeight = columns === 3 ? cellWidth : Math.round(cellWidth * 0.75);
  return {
    columns,
    cellWidth,
    cellHeight,
    gap: GALLERY_GAP,
    visibleCount,
    width: cellWidth * columns + GALLERY_GAP * (columns - 1),
    height: cellHeight * rows + GALLERY_GAP * (rows - 1),
  };
}

/** 文件链接列表占用高度（含上间距） */
export function fileListHeight(count: number): number {
  return count > 0 ? FILE_LIST_TOP_GAP + count * FILE_ROW_HEIGHT + (count - 1) * FILE_ROW_GAP : 0;
}

/** 节点标题区高度（不含内缩），多行时随行数增长 */
export function titleBlockHeight(level: number, lineCount: number): number {
  const style = getNodeTextStyle(level);
  return Math.max(lineCount * style.lineHeight, style.minHeight - style.insetY * 2);
}

/**
 * 计算单个节点的宽高与标题 / 备注换行
 */
export function measureNodeBox(
  node: MindNode,
  level: number,
  options: MindmapLayoutOptions = {},
): NodeBox {
  const style = getNodeTextStyle(level);
  const measure = options.measure ?? estimateTextWidth;
  const family = options.fontFamily ?? '';
  const titleFont = buildFont(style.fontSize, style.fontWeight, family);
  const noteFont = buildFont(NOTE_FONT_SIZE, 400, family);
  const draft = options.textOverrides?.get(node.id);
  const text = draft ? draft.text : node.text ?? '';
  const marks = draft ? draft.marks : node.marks;
  const rich = createRichFontSpec(text, marks, style.fontSize, style.fontWeight, family);
  const textAlign: MindmapTextAlign = node.textAlign ?? options.defaultTextAlign ?? 'left';
  const imageFit: MindmapImageFit = node.imageFit ?? options.defaultImageFit ?? 'original';
  const images = node.images ?? [];
  const files = node.files ?? [];
  const hasIcon = Boolean(node.icon);
  const hasNote = Boolean(node.note);
  const hasImage = images.length > 0;
  // 两张及以上图片改为网格展示，显示方式设置只作用于单图
  const isGallery = images.length > 1;
  const imageSize = images.length === 1 && imageFit === 'original' ? options.imageSize?.(images[0]) : undefined;
  const iconWidth = hasIcon ? style.iconWidth : 0;
  const maxWidth = clampNodeMaxWidth(options.maxNodeWidth);
  const minAttachmentWidth = attachmentMinWidth(node);

  // 宽度：手动宽度优先；否则取「单行自然宽度」并以设置中的最大宽度封顶
  const manual = options.widthOverrides?.get(node.id) ?? node.width;
  let width: number;
  if (typeof manual === 'number' && Number.isFinite(manual) && manual > 0) {
    width = clampManualWidth(manual, minAttachmentWidth);
  } else {
    const minWidth = style.minWidth + (hasIcon ? 24 : 0);
    // 标题含手动换行时，自然宽度取最长一段
    const measureTitle = createRangeMeasure(text, measure, titleFont, rich);
    let titleNatural = 0;
    let segStart = 0;
    for (const seg of text.split('\n')) {
      titleNatural = Math.max(titleNatural, measureTitle(segStart, segStart + seg.length));
      segStart += seg.length + 1;
    }
    let natural = Math.max(
      minWidth,
      Math.ceil(titleNatural) +
        style.insetX * 2 +
        iconWidth +
        WIDTH_SLACK,
    );
    if (hasNote) {
      const noteNatural = Math.ceil(measureNaturalWidth(node.note || '', measure, noteFont));
      natural = Math.max(natural, noteNatural + style.insetX * 2 + WIDTH_SLACK);
    }
    // 原始比例：节点尽量撑到能完整展示图片固有宽度（仍以最大宽度封顶）
    if (imageSize) natural = Math.max(natural, imageSize.width + 2 + style.insetX * 2);
    // 文件链接：尽量完整显示最长的文件名（超出最大宽度时由渲染层省略）
    if (files.length > 0) {
      const fileFont = buildFont(FILE_FONT_SIZE, 400, family);
      const longest = Math.max(...files.map((path) => measure(fileLinkName(path), fileFont)));
      natural = Math.max(natural, Math.ceil(longest) + FILE_ROW_CHROME + style.insetX * 2 + WIDTH_SLACK);
    }
    width = Math.min(Math.max(maxWidth, minWidth), natural);
    width = Math.max(width, minAttachmentWidth);
  }

  // 标题换行（富文本按各字符实际字体测量）
  const titleWidth = width - style.insetX * 2 - iconWidth;
  const titleLines = wrapText(text, titleWidth, measure, titleFont, rich);
  let height = titleBlockHeight(level, titleLines.length) + style.insetY * 2;

  // 备注：逐段换行，超出最大行数时末行补省略号
  let noteLines: string[] = [];
  if (hasNote) {
    const noteWidth = width - style.insetX * 2;
    for (const seg of (node.note || '').split('\n')) {
      noteLines.push(...wrapText(seg, noteWidth, measure, noteFont).map((l) => l.text));
    }
    if (noteLines.length > NOTE_MAX_LINES) {
      const kept = noteLines.slice(0, NOTE_MAX_LINES);
      kept[NOTE_MAX_LINES - 1] = ellipsizeLine(kept[NOTE_MAX_LINES - 1], noteWidth, measure, noteFont);
      noteLines = kept;
    }
    height += noteLines.length * NOTE_LINE_HEIGHT + NOTE_TOP_GAP;
  }

  // 图片区：原始比例按固有宽高等比缩放到内容宽度（小图不放大）；宽度填充固定高度裁切
  let imageBox: ImageBox | undefined;
  let gallery: GalleryBox | undefined;
  if (isGallery) {
    // 多图网格：铺满内容宽度（与单图外框同宽），上边距与单图一致
    gallery = computeGalleryBox(images.length, width - style.insetX * 2);
    height += GALLERY_TOP_GAP + gallery.height;
  } else if (hasImage) {
    const contentWidth = width - style.insetX * 2 - 2;
    if (imageSize) {
      const displayWidth = Math.min(contentWidth, imageSize.width);
      const displayHeight = Math.max(1, Math.round((displayWidth * imageSize.height) / imageSize.width));
      imageBox = { fit: 'original', width: displayWidth, height: displayHeight };
      height += displayHeight + IMAGE_FRAME_EXTRA;
    } else {
      imageBox = { fit: 'fill', width: contentWidth, height: FILL_IMAGE_HEIGHT };
      height += IMAGE_BLOCK_HEIGHT;
    }
  }

  // 文件链接列表：每个文件一行，位于图片之下
  height += fileListHeight(files.length);

  return { width, height, titleLines, noteLines, marks, textAlign, imageBox, gallery };
}

/** 自底向上度量：沿堆叠轴累加子树尺寸 */
function measureSubTree(
  node: MindNode,
  level: number,
  isVertical: boolean,
  options: MindmapLayoutOptions,
): LayoutNode {
  const box = measureNodeBox(node, level, options);
  const isExpanded = node.isExpanded !== false;
  const crossSize = isVertical ? box.width : box.height;

  const layoutNode: LayoutNode = {
    node,
    x: 0,
    y: 0,
    width: box.width,
    height: box.height,
    level,
    branchIndex: 0,
    totalSubHeight: crossSize,
    children: [],
    titleLines: box.titleLines,
    noteLines: box.noteLines,
    marks: box.marks,
    textAlign: box.textAlign,
    imageBox: box.imageBox,
    gallery: box.gallery,
    freeEdge: 'right',
    childSide: 'right',
    siblingFlow: 'down',
  };

  if (!isExpanded || !node.children || node.children.length === 0) {
    return layoutNode;
  }

  const measuredChildren = node.children.map((c) => measureSubTree(c, level + 1, isVertical, options));
  const siblingGap = isVertical ? TREE_SIBLING_GAP : NODE_V_GAP;
  const totalChildrenExtent =
    measuredChildren.reduce((sum, c) => sum + c.totalSubHeight, 0) +
    (measuredChildren.length - 1) * siblingGap;

  layoutNode.children = measuredChildren;
  layoutNode.totalSubHeight = Math.max(crossSize, totalChildrenExtent);
  return layoutNode;
}

/**
 * 水平方向分配坐标（dir = 1 向右展开；dir = -1 向左展开）
 * 同一分支下的所有子孙共用同一配色序号
 */
function assignHorizontal(
  node: LayoutNode,
  startX: number,
  startY: number,
  dir: 1 | -1,
  branchIndex: number,
  out: LayoutPlacement,
) {
  node.branchIndex = branchIndex;
  node.x = dir === 1 ? startX : startX - node.width;
  node.y = startY + (node.totalSubHeight - node.height) / 2;
  node.freeEdge = dir === 1 ? 'right' : 'left';
  node.childSide = dir === 1 ? 'right' : 'left';
  node.siblingFlow = 'down';
  out.nodes.push(node);

  if (node.children.length === 0) return;

  const childStartX = dir === 1 ? startX + node.width + NODE_H_GAP : startX - node.width - NODE_H_GAP;
  let cursor = startY;
  for (const child of node.children) {
    assignHorizontal(child, childStartX, cursor, dir, branchIndex, out);
    out.specs.push({ kind: 'horizontal', from: node, to: child });
    cursor += child.totalSubHeight + NODE_V_GAP;
  }
}

/** 垂直方向分配坐标（自顶向下组织图） */
function assignVertical(
  node: LayoutNode,
  startX: number,
  startY: number,
  branchIndex: number,
  out: LayoutPlacement,
) {
  node.branchIndex = branchIndex;
  node.y = startY;
  node.x = startX + (node.totalSubHeight - node.width) / 2;
  node.freeEdge = 'right';
  node.childSide = 'bottom';
  node.siblingFlow = 'right';
  out.nodes.push(node);

  if (node.children.length === 0) return;

  const childStartY = startY + node.height + TREE_LEVEL_GAP;
  let cursor = startX;
  for (const child of node.children) {
    assignVertical(child, cursor, childStartY, branchIndex, out);
    out.specs.push({ kind: 'vertical', from: node, to: child, dir: 1 });
    cursor += child.totalSubHeight + TREE_SIBLING_GAP;
  }
}

/** 将整体包围盒平移到原点，避免出现负坐标导致初始视口外内容不可见 */
function normalizeToOrigin(nodes: LayoutNode[]) {
  if (nodes.length === 0) return;
  let minX = Infinity;
  let minY = Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
  }
  if (minX === 0 && minY === 0) return;
  for (const n of nodes) {
    n.x -= minX;
    n.y -= minY;
  }
}

/** 向下组织图：根节点居中于子层级上方，一级分支按序循环取色 */
function layoutOrgDown(root: LayoutNode, colorCount: number): LayoutPlacement {
  const out: LayoutPlacement = { nodes: [], specs: [] };
  const childrenExtent =
    root.children.reduce((sum, c) => sum + c.totalSubHeight, 0) +
    Math.max(0, root.children.length - 1) * TREE_SIBLING_GAP;
  root.branchIndex = 0;
  root.y = 0;
  root.x = (childrenExtent - root.width) / 2;
  root.freeEdge = 'right';
  root.childSide = 'bottom';
  out.nodes.push(root);

  const childStartY = root.height + TREE_LEVEL_GAP;
  let cursor = 0;
  root.children.forEach((child, idx) => {
    assignVertical(child, cursor, childStartY, idx % colorCount, out);
    out.specs.push({ kind: 'vertical', from: root, to: child, dir: 1 });
    cursor += child.totalSubHeight + TREE_SIBLING_GAP;
  });
  return out;
}

/** 向上组织图：先按向下组织图排布，再沿 y 轴镜像 */
function layoutOrgUp(root: LayoutNode, colorCount: number): LayoutPlacement {
  const out = layoutOrgDown(root, colorCount);
  for (const n of out.nodes) {
    n.y = -(n.y + n.height);
    n.childSide = 'top';
  }
  for (const spec of out.specs) {
    if (spec.kind === 'vertical') spec.dir = -1;
  }
  return out;
}

/** 双向平衡图：根节点居中，一级分支左右交替分布 */
function layoutBalanced(root: LayoutNode, colorCount: number): LayoutPlacement {
  const out: LayoutPlacement = { nodes: [], specs: [] };
  const children = root.children;
  const rightGroup: LayoutNode[] = [];
  const leftGroup: LayoutNode[] = [];
  children.forEach((child, idx) => {
    (idx % 2 === 0 ? rightGroup : leftGroup).push(child);
  });

  const groupExtent = (group: LayoutNode[]) =>
    group.length === 0
      ? 0
      : group.reduce((sum, c) => sum + c.totalSubHeight, 0) + (group.length - 1) * NODE_V_GAP;

  const rightExtent = groupExtent(rightGroup);
  const leftExtent = groupExtent(leftGroup);
  const totalExtent = Math.max(rightExtent, leftExtent, root.height);

  root.x = -root.width / 2;
  root.y = (totalExtent - root.height) / 2;
  root.branchIndex = 0;
  root.freeEdge = 'right';
  root.childSide = 'right';
  out.nodes.push(root);

  let cursor = (totalExtent - rightExtent) / 2;
  for (const child of rightGroup) {
    const branchIndex = children.indexOf(child) % colorCount;
    assignHorizontal(child, root.width / 2 + NODE_H_GAP, cursor, 1, branchIndex, out);
    out.specs.push({ kind: 'horizontal', from: root, to: child });
    cursor += child.totalSubHeight + NODE_V_GAP;
  }

  cursor = (totalExtent - leftExtent) / 2;
  for (const child of leftGroup) {
    const branchIndex = children.indexOf(child) % colorCount;
    assignHorizontal(child, -root.width / 2 - NODE_H_GAP, cursor, -1, branchIndex, out);
    out.specs.push({ kind: 'horizontal', from: root, to: child });
    cursor += child.totalSubHeight + NODE_V_GAP;
  }
  return out;
}

/** 向右 / 向左逻辑图：根节点单侧展开 */
function layoutLogic(root: LayoutNode, dir: 1 | -1, colorCount: number): LayoutPlacement {
  const out: LayoutPlacement = { nodes: [], specs: [] };
  root.branchIndex = 0;
  root.x = dir === 1 ? 0 : -root.width;
  root.y = (root.totalSubHeight - root.height) / 2;
  root.freeEdge = dir === 1 ? 'right' : 'left';
  root.childSide = dir === 1 ? 'right' : 'left';
  out.nodes.push(root);

  // dir === -1 时 startX 表示节点的右边缘，子节点从根节点左边缘再向左延伸一段间距
  const childStartX = dir === 1 ? root.width + NODE_H_GAP : -root.width - NODE_H_GAP;
  let cursor = 0;
  root.children.forEach((child, idx) => {
    assignHorizontal(child, childStartX, cursor, dir, idx % colorCount, out);
    out.specs.push({ kind: 'horizontal', from: root, to: child });
    cursor += child.totalSubHeight + NODE_V_GAP;
  });
  return out;
}

/** 按连线描述生成最终路径（坐标已归一化） */
function resolveLinkPath(spec: LinkSpec, edgeStyle: MindmapEdgeStyle): string {
  switch (spec.kind) {
    case 'horizontal':
      return horizontalLinkPath(spec.from, spec.to, edgeStyle);
    case 'vertical':
      return verticalLinkPath(spec.from, spec.to, edgeStyle, spec.dir);
    case 'indent': {
      const { from, to, dir } = spec;
      const px = dir === 1 ? from.x + INDENT_ANCHOR : from.x + from.width - INDENT_ANCHOR;
      const py = spec.anchorSide === 'bottom' ? from.y + from.height : from.y;
      const cx = dir === 1 ? to.x : to.x + to.width;
      return indentLinkPath(px, py, cx, to.y + to.height / 2, edgeStyle);
    }
    case 'axis': {
      const axisY = spec.from.y + spec.from.height / 2;
      return straightPath(spec.prev.x + spec.prev.width, axisY, spec.to.x, axisY);
    }
    case 'bone': {
      const { to, from, dx, side } = spec;
      const spineY = from.y + from.height / 2;
      const topX = to.x + to.width / 2;
      const topY = side === 'above' ? to.y + to.height : to.y;
      return straightPath(topX + dx, spineY, topX, topY);
    }
    case 'rib': {
      const { from, to, spine, dx, h } = spec;
      const spineY = spine.y + spine.height / 2;
      const spineX = from.x + from.width / 2 + dx;
      const cy = to.y + to.height / 2;
      const bx = spineX - dx * (Math.abs(cy - spineY) / h);
      return straightPath(bx, cy, to.x, cy);
    }
  }
}

/**
 * 计算整棵思维导图的绝对坐标与连接关系
 * @param colorCount 主题配色数量，用于一级分支循环取色
 */
export function computeMindmapLayout(
  root: MindNode,
  layout: MindmapLayout,
  colorCount: number,
  options: MindmapLayoutOptions = {},
): MindmapLayoutResult {
  const isVertical = layout === 'tree' || layout === 'tree-up';
  const measuredRoot = measureSubTree(root, 0, isVertical, options);
  const safeColorCount = Math.max(1, colorCount);

  let placement: LayoutPlacement;
  switch (layout) {
    case 'tree':
      placement = layoutOrgDown(measuredRoot, safeColorCount);
      break;
    case 'tree-up':
      placement = layoutOrgUp(measuredRoot, safeColorCount);
      break;
    case 'balanced':
      placement = layoutBalanced(measuredRoot, safeColorCount);
      break;
    case 'indent-right':
      placement = layoutIndented(measuredRoot, 1, safeColorCount);
      break;
    case 'indent-left':
      placement = layoutIndented(measuredRoot, -1, safeColorCount);
      break;
    case 'timeline':
      placement = layoutTimeline(measuredRoot, safeColorCount);
      break;
    case 'fishbone':
      placement = layoutFishbone(measuredRoot, safeColorCount);
      break;
    case 'left':
      placement = layoutLogic(measuredRoot, -1, safeColorCount);
      break;
    default:
      placement = layoutLogic(measuredRoot, 1, safeColorCount);
      break;
  }

  normalizeToOrigin(placement.nodes);
  const edgeStyle = options.edgeStyle ?? 'curve';
  const links: LayoutLink[] = placement.specs.map((spec) => ({
    from: spec.from,
    to: spec.to,
    path: resolveLinkPath(spec, edgeStyle),
  }));
  const decorations = placement.decorate ? placement.decorate() : [];
  return { nodes: placement.nodes, links, decorations };
}

/**
 * 生成单条父子连线的 SVG path（逻辑图 / 组织图）
 * 其余布局的连线由 computeMindmapLayout 直接给出
 */
export function buildLinkPath(
  from: LayoutNode,
  to: LayoutNode,
  layout: MindmapLayout,
  edgeStyle: MindmapEdgeStyle = 'curve',
): string {
  if (layout === 'tree') return verticalLinkPath(from, to, edgeStyle, 1);
  if (layout === 'tree-up') return verticalLinkPath(from, to, edgeStyle, -1);
  return horizontalLinkPath(from, to, edgeStyle);
}

/** 计算布局结果的整体包围盒（含装饰线的大致范围由调用方额外留白） */
export function getLayoutBounds(nodes: LayoutNode[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
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
  return { minX, minY, maxX, maxY };
}
