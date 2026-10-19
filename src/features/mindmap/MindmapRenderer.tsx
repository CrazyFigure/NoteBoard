// NoteBoard 思维导图可视化渲染器 (Mindmap Visual Mode)
// 轻量自研 SVG 矢量渲染 + 紧凑树自适应无重叠布局 (Tidy Right-Tree) + 贝塞尔平滑连接 + 节点就地编辑
// 详见 docs/09-开发路线图.md

import React, { useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect } from 'react';
import {
  Smile,
  FileText,
  Image as ImageIcon,
  MoveHorizontal,
  Plus,
  Settings2,
  Trash2,
  X,
  GripVertical,
} from 'lucide-react';
import type {
  MindNode,
  MindmapLayout,
  MindmapEdgeStyle,
  MindmapImageFit,
  MindmapTextAlign,
} from './mindmapTypes';
import { generateNodeId, moveMindNode } from './mindmapConverter';
import { cloneMindmapTree, findMindNode, findMindNodeParent, walkMindNodes } from './mindmapTree';
import { getMindmapViewport, isMindmapNodeVisible, isMindmapLinkVisible } from './mindmapViewport';
import {
  computeMindmapLayout,
  clampManualWidth,
  titleBlockHeight,
  type LayoutNode,
  type NodeSide,
  type TextDraft,
} from './mindmapLayout';
import type { MindmapTheme } from './mindmapTheme';
import { MindmapIconPicker } from './MindmapIconPicker';
import { MindmapImagePreview } from './MindmapImagePreview';
import { MindmapTitleEditor, type MindmapTitleEditorHandle, type TitleSelectionInfo } from './MindmapTitleEditor';
import { MindmapTextFormatMenu, type FormatState } from './MindmapTextFormatMenu';
import { MindmapNodeStylePopover } from './MindmapNodeStylePopover';
import { MindmapConfirmDialog } from './MindmapConfirmDialog';
import {
  adjustMarksForTextChange,
  commonColor,
  isStyleActive,
  splitStyledRuns,
  styleToCss,
  type MindTextMark,
  type StylePatch,
} from './mindmapRichText';
import { getImageSize, subscribeImageSizes } from './mindmapImageSize';
import {
  FALLBACK_FONT_FAMILY,
  NOTE_LINE_HEIGHT,
  getNodeTextStyle,
  getSharedTextMeasurer,
} from './mindmapTextMeasure';
import { Tooltip } from '../../components/Tooltip';
import { CanvasMinimap, type CanvasMinimapHandle, type MinimapScene } from '../../components/minimap/CanvasMinimap';
import { useSettingsStore } from '../../stores/settingsStore';
import { IS_MOBILE_UI } from '../../core/platform';
import type { MindmapSearchHighlight } from './mindmapSearch';

interface MindmapRendererProps {
  root: MindNode;
  onChange: (newRoot: MindNode) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** 排布布局 */
  layout: MindmapLayout;
  /** 配色主题 */
  theme: MindmapTheme;
  /** 连线样式（已合并文档设置与主题默认值） */
  edgeStyle: MindmapEdgeStyle;
  /** 未手动拉伸的节点最大宽度（设置项） */
  maxNodeWidth: number;
  /** 节点未单独设置时的标题对齐（设置项） */
  defaultTextAlign: MindmapTextAlign;
  /** 节点未单独设置时的图片显示方式（设置项） */
  defaultImageFit: MindmapImageFit;
  /** 搜索匹配高亮与当前项定位 */
  searchHighlight?: MindmapSearchHighlight;
}

type DropPosition = 'before' | 'inside' | 'after';

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  sourceNode: MindNode;
  isDragging: boolean;
  /** 一次拖拽共用后代集合，避免首次移动仍重复遍历或误选自己的子树。 */
  descendantIds?: Set<string>;
}

interface DropTargetState {
  targetId: string;
  pos: DropPosition;
  targetLayout: LayoutNode;
}

/** 节点宽度拉伸会话 */
interface ResizeSession {
  nodeId: string;
  pointerId: number;
  startX: number;
  startWidth: number;
  /** 拖动的是哪条边：右边向右拉变宽，左边向左拉变宽 */
  edge: 'left' | 'right';
  hasImage: boolean;
  moved: boolean;
}

// 统计全部子孙，不依赖展开状态，也不消耗递归调用栈。
function countSubtreeDescendants(node: MindNode): number {
  let count = -1;
  for (const _current of walkMindNodes(node)) count += 1;
  return count;
}

/** 搜索命中片段的高亮底色（与代码编辑器搜索高亮同一 Token） */
const SEARCH_MARK_STYLE: React.CSSProperties = {
  background: 'var(--cm-search-match-bg)',
  color: 'inherit',
  borderRadius: 2,
  padding: 0,
};

/** 把标题文本按匹配区间切分渲染，命中片段包 <mark> */
function renderHighlightedText(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]> | undefined,
): React.ReactNode {
  if (!ranges || ranges.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([from, to], i) => {
    if (from > cursor) parts.push(text.slice(cursor, from));
    parts.push(
      <mark key={i} style={SEARCH_MARK_STYLE}>
        {text.slice(from, to)}
      </mark>,
    );
    cursor = to;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** 把全文匹配区间裁剪并平移到某一行内 */
function sliceRangesForLine(
  ranges: ReadonlyArray<readonly [number, number]> | undefined,
  start: number,
  length: number,
): Array<[number, number]> | undefined {
  if (!ranges || ranges.length === 0) return undefined;
  const end = start + length;
  const result: Array<[number, number]> = [];
  for (const [from, to] of ranges) {
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (b > a) result.push([a - start, b - start]);
  }
  return result.length > 0 ? result : undefined;
}

/** 折叠 / 添加按钮在节点某一侧的定位样式 */
function sideButtonStyle(side: NodeSide, offset: number): React.CSSProperties {
  switch (side) {
    case 'left':
      return { left: offset, top: '50%', transform: 'translateY(-50%)' };
    case 'top':
      return { top: offset, left: '50%', transform: 'translateX(-50%)' };
    case 'bottom':
      return { bottom: offset, left: '50%', transform: 'translateX(-50%)' };
    default:
      return { right: offset, top: '50%', transform: 'translateY(-50%)' };
  }
}

/** 计算拖放前后插入指示线的位置（随同级排列走向切换横线 / 竖线） */
function getDropIndicatorRect(
  target: LayoutNode,
  pos: 'before' | 'after',
): { left: number; top: number; width: number; height: number; vertical: boolean } {
  if (target.siblingFlow === 'down') {
    return {
      left: target.x - 4,
      top: pos === 'before' ? target.y - 6 : target.y + target.height + 3,
      width: target.width + 8,
      height: 3,
      vertical: false,
    };
  }
  // 横向排列：向右流动时 before 在左侧，向左流动时 before 在右侧
  const onLeft = (target.siblingFlow === 'right') === (pos === 'before');
  return {
    left: onLeft ? target.x - 6 : target.x + target.width + 3,
    top: target.y - 4,
    width: 3,
    height: target.height + 8,
    vertical: true,
  };
}

/** 在树中定位节点并按回调改写 */
function updateNodeById(n: MindNode, id: string, mutate: (node: MindNode) => void): boolean {
  const target = findMindNode(n, id);
  if (!target) return false;
  mutate(target);
  return true;
}

/** 在树中定位节点并改写其标题文本与格式 */
function setNodeTextById(n: MindNode, id: string, text: string, marks?: MindTextMark[]): boolean {
  return updateNodeById(n, id, (target) => {
    target.text = text;
    if (marks && marks.length > 0) target.marks = marks;
    else delete target.marks;
  });
}

/** 在树中查找父节点 */
function findParentNode(n: MindNode, id: string): MindNode | null {
  return findMindNodeParent(n, id)?.parent ?? null;
}

/** 在树中查找节点 */
function findNodeById(n: MindNode, id: string): MindNode | null {
  return findMindNode(n, id);
}

/** 草稿去除首尾空白，并同步平移格式区间 */
function trimDraft(draft: TextDraft): TextDraft {
  const text = draft.text.trim();
  return { text, marks: adjustMarksForTextChange(draft.text, text, draft.marks) };
}

/**
 * 渲染一行标题：按富文本格式切分片段，片段内再叠加搜索命中高亮
 */
function renderStyledLine(
  lineText: string,
  lineStart: number,
  marks: readonly MindTextMark[] | undefined,
  searchRanges: ReadonlyArray<readonly [number, number]> | undefined,
  baseWeight: number,
): React.ReactNode {
  if (!marks || marks.length === 0) {
    return renderHighlightedText(lineText, sliceRangesForLine(searchRanges, lineStart, lineText.length));
  }
  return splitStyledRuns(marks, lineStart, lineStart + lineText.length).map((run) => {
    const text = lineText.slice(run.start - lineStart, run.end - lineStart);
    return (
      <span key={run.start} style={styleToCss(run.style, baseWeight)}>
        {renderHighlightedText(text, sliceRangesForLine(searchRanges, run.start, text.length))}
      </span>
    );
  });
}

/** 在树中定位父节点并追加一个子节点 */
function insertChildNode(n: MindNode, parentId: string, child: MindNode): boolean {
  if (n.id === parentId) {
    if (!n.children) n.children = [];
    n.children.push(child);
    n.isExpanded = true;
    return true;
  }
  for (const c of n.children || []) {
    if (insertChildNode(c, parentId, child)) return true;
  }
  return false;
}

/** 在树中定位锚点节点并在其后方插入同级节点 */
function insertSiblingNode(n: MindNode, anchorId: string, sibling: MindNode): boolean {
  const walk = (node: MindNode): boolean => {
    if (node.children && node.children.length > 0) {
      const idx = node.children.findIndex((c) => c.id === anchorId);
      if (idx !== -1) {
        node.children.splice(idx + 1, 0, sibling);
        return true;
      }
      for (const c of node.children) {
        if (walk(c)) return true;
      }
    }
    return false;
  };
  return walk(n);
}

/** 缩略图节点的最小像素尺寸，缩得很小时仍能看出分支走向 */
const MINIMAP_MIN_NODE_PX = 1.5;

/** 底部快捷键提示中的按键样式 */
const HINT_KBD_STYLE: React.CSSProperties = {
  display: 'inline-block',
  padding: '0 5px',
  borderRadius: 4,
  border: '1px solid var(--editor-border, #cbd5e1)',
  background: 'var(--editor-bg, #ffffff)',
  color: 'var(--editor-text-secondary, #64748b)',
  fontFamily: 'inherit',
  fontSize: 10,
  fontWeight: 600,
  lineHeight: '16px',
};

export function MindmapRenderer({
  root,
  onChange,
  zoom,
  onZoomChange,
  layout,
  theme,
  edgeStyle,
  maxNodeWidth,
  defaultTextAlign,
  defaultImageFit,
  searchHighlight,
}: MindmapRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetNodeIdRef = useRef<string | null>(null);

  // 画布平移状态
  const [pan, commitPan] = useState<{ x: number; y: number }>({ x: 80, y: 160 });
  const panRef = useRef(pan);
  const committedPanRef = useRef(pan);
  committedPanRef.current = pan;
  const transformLayerRef = useRef<HTMLDivElement>(null);
  const panFrameRef = useRef<number | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const minimapRef = useRef<CanvasMinimapHandle>(null);
  // 判断内容是否已全部移出视野（每次渲染指向最新闭包，供命令式平移逐帧调用）
  const checkOffscreenRef = useRef<() => void>(() => undefined);
  // 平移先更新图层变换；移动接近缓冲区边缘时才触发 React 补绘，不改原有灵敏度与坐标规则。
  const setPan = useCallback((next: React.SetStateAction<{ x: number; y: number }>) => {
    const value = typeof next === 'function' ? next(panRef.current) : next;
    panRef.current = value;
    if (transformLayerRef.current) transformLayerRef.current.style.transform = `translate(${value.x}px, ${value.y}px) scale(${zoomRef.current})`;
    // 缩略图视口框跟随每帧平移，只写 DOM 不触发渲染
    minimapRef.current?.syncViewport();
    checkOffscreenRef.current();
    const committed = committedPanRef.current;
    if (Math.max(Math.abs(value.x - committed.x), Math.abs(value.y - committed.y)) < 128) return;
    if (panFrameRef.current === null) panFrameRef.current = requestAnimationFrame(() => {
      panFrameRef.current = null;
      commitPan(panRef.current);
    });
  }, []);
  const [viewportSize, setViewportSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => setViewportSize({ width: container.clientWidth, height: container.clientHeight });
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(container);
    return () => {
      observer?.disconnect();
      if (panFrameRef.current !== null) cancelAnimationFrame(panFrameRef.current);
    };
  }, []);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // 触屏手势状态：当前按下的触点（pointerId → 屏幕坐标）与双指捏合会话
  const touchPointsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{
    startDist: number;
    startZoom: number;
    // 捏合起点中心对应的导图世界坐标（缩放时保持该点在两指中心下方）
    worldX: number;
    worldY: number;
  } | null>(null);
  const [isPinching, setIsPinching] = useState(false);
  // 最近一次触摸时间：用于忽略触屏点按后浏览器补发的兼容 mousedown，避免误入鼠标平移态
  const lastTouchAtRef = useRef(0);

  // 节点拖拽状态 (Pointer Events 丝滑整树拖拽)
  const dragSessionRef = useRef<DragSession | null>(null);
  const [isDraggingNode, setIsDraggingNode] = useState(false);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    x: number;
    y: number;
    node: MindNode;
    descendantCount: number;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);

  // 正在就地编辑标题的节点与草稿（文本 + 富文本格式）
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<TextDraft>({ text: '' });
  // 标题编辑框句柄（格式菜单通过它对选区应用格式）与当前选区
  const titleEditorRef = useRef<MindmapTitleEditorHandle>(null);
  const [formatSelection, setFormatSelection] = useState<TitleSelectionInfo | null>(null);

  // 单个节点样式浮层（对齐 / 图片显示方式）
  const [nodeStylePopover, setNodeStylePopover] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  // 删除含子节点的节点前的二次确认
  const [deleteConfirm, setDeleteConfirm] = useState<{ nodeId: string; descendantCount: number } | null>(null);
  const deleteConfirmRef = useRef(deleteConfirm);
  deleteConfirmRef.current = deleteConfirm;

  // 正在编辑备注的节点
  const [editingNoteNodeId, setEditingNoteNodeId] = useState<string | null>(null);
  const [editNoteText, setEditNoteText] = useState('');

  // 选中的节点与悬浮工具栏状态
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // 图标选择器弹窗状态
  const [iconPickerState, setIconPickerState] = useState<{
    nodeId: string;
    currentIcon?: string;
    x: number;
    y: number;
  } | null>(null);

  // 图片大图预览
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // 节点宽度拉伸：会话记录在 ref，实时预览宽度放在 state 参与排版
  const resizeSessionRef = useRef<ResizeSession | null>(null);
  const [resizePreview, setResizePreview] = useState<{ id: string; width: number } | null>(null);

  // 图片固有尺寸测得后重新排版（原始比例显示依赖图片宽高）
  const [imageSizeVersion, setImageSizeVersion] = useState(0);
  useEffect(() => subscribeImageSizes(() => setImageSizeVersion((v) => v + 1)), []);

  // 节点字体族：取画布实际继承的字体，保证测量与渲染一致；字体加载完成后重新排版
  const typography = useSettingsStore((s) => s.settings.typography);
  const [fontFamily, setFontFamily] = useState(FALLBACK_FONT_FAMILY);
  const [fontVersion, setFontVersion] = useState(0);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const family = window.getComputedStyle(el).fontFamily;
    if (family) setFontFamily(family);
  }, [typography]);
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts) return;
    let disposed = false;
    const bump = () => {
      if (!disposed) setFontVersion((v) => v + 1);
    };
    fonts.ready.then(bump).catch(() => {});
    fonts.addEventListener?.('loadingdone', bump);
    return () => {
      disposed = true;
      fonts.removeEventListener?.('loadingdone', bump);
    };
  }, []);

  // 最新状态引用：供全局快捷键监听在稳定闭包中读取，避免反复重绑事件
  const selectedNodeIdRef = useRef<string | null>(null);
  selectedNodeIdRef.current = selectedNodeId;
  const editingNodeIdRef = useRef<string | null>(null);
  editingNodeIdRef.current = editingNodeId;
  const editDraftRef = useRef<TextDraft>({ text: '' });
  editDraftRef.current = editDraft;
  // 新建节点后聚焦时需要全选占位文本（便于直接输入覆盖）；编辑框挂载时读取后清空
  const pendingSelectAllRef = useRef<string | null>(null);
  useEffect(() => {
    pendingSelectAllRef.current = null;
    setFormatSelection(null);
  }, [editingNodeId]);

  // 编辑中的草稿与拉伸中的宽度实时参与排版
  const textOverrides = useMemo(
    () => (editingNodeId ? new Map([[editingNodeId, editDraft]]) : undefined),
    [editingNodeId, editDraft],
  );
  const widthOverrides = useMemo(
    () => (resizePreview ? new Map([[resizePreview.id, resizePreview.width]]) : undefined),
    [resizePreview],
  );

  // 计算无重叠思维导图绝对坐标（布局 + 主题 + 宽度设置共同决定节点位置、尺寸与配色）
  const { nodes, links, decorations } = useMemo(
    () =>
      computeMindmapLayout(root, layout, theme.branchColors.length, {
        maxNodeWidth,
        measure: getSharedTextMeasurer(),
        fontFamily,
        textOverrides,
        widthOverrides,
        edgeStyle,
        defaultTextAlign,
        defaultImageFit,
        imageSize: getImageSize,
      }),
    // fontVersion / imageSizeVersion 不参与计算：字体加载完成、图片尺寸测得后仅用于强制重新排版
    [
      root,
      layout,
      theme.branchColors.length,
      maxNodeWidth,
      fontFamily,
      fontVersion,
      imageSizeVersion,
      textOverrides,
      widthOverrides,
      edgeStyle,
      defaultTextAlign,
      defaultImageFit,
    ],
  );

  // 布局仍覆盖全部已展开节点，只有真正的节点和连线 DOM 按视口裁剪。
  const viewport = useMemo(() => getMindmapViewport(panRef.current, zoom, viewportSize.width, viewportSize.height), [pan, zoom, viewportSize]);
  const visibleNodes = useMemo(() => nodes.filter((node) =>
    isMindmapNodeVisible(node, viewport) || [selectedNodeId, editingNodeId, editingNoteNodeId, draggedNodeId, resizePreview?.id].includes(node.node.id)),
  [nodes, viewport, selectedNodeId, editingNodeId, editingNoteNodeId, draggedNodeId, resizePreview?.id]);
  const visibleLinks = useMemo(() => links.filter((link) => isMindmapLinkVisible(link, viewport)), [links, viewport]);
  // 拖动一次只生成一次后代集合，落点扫描和节点样式不再对每个节点重复遍历整树。
  const draggedDescendantIds = useMemo(() => {
    const source = draggedNodeId ? findMindNode(root, draggedNodeId) : null;
    return new Set(source ? Array.from(walkMindNodes(source), (node) => node.id) : []);
  }, [root, draggedNodeId]);

  // 全部已展开节点的外接矩形（世界坐标），缩略图与“回到内容”共用
  const contentBounds = useMemo(() => {
    if (nodes.length === 0) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const n of nodes) {
      if (n.x < left) left = n.x;
      if (n.y < top) top = n.y;
      if (n.x + n.width > right) right = n.x + n.width;
      if (n.y + n.height > bottom) bottom = n.y + n.height;
    }
    return { left, top, width: right - left, height: bottom - top };
  }, [nodes]);

  // 缩略图场景：内容只随布局 / 配色变化重绘，平移和缩放只移动视口框
  const getMinimapScene = useCallback((): MinimapScene => {
    const colors = theme.branchColors;
    return {
      bounds: contentBounds,
      paint: (ctx, scale, style) => {
        const px = 1 / scale;
        // 连线按分支色合并为少量路径，万级节点也只需几次 stroke
        ctx.lineWidth = px;
        ctx.globalAlpha = 0.5;
        for (let ci = 0; ci < colors.length; ci += 1) {
          ctx.beginPath();
          for (const link of links) {
            if (link.to.branchIndex % colors.length !== ci) continue;
            ctx.moveTo(link.from.x + link.from.width / 2, link.from.y + link.from.height / 2);
            ctx.lineTo(link.to.x + link.to.width / 2, link.to.y + link.to.height / 2);
          }
          ctx.strokeStyle = colors[ci];
          ctx.stroke();
        }
        // 节点同样按分支色批量填充；过小的节点抬到最小像素，避免整片消失
        const minSize = MINIMAP_MIN_NODE_PX * px;
        ctx.globalAlpha = 0.85;
        for (let ci = 0; ci < colors.length; ci += 1) {
          ctx.beginPath();
          for (const n of nodes) {
            if (n.level === 0 || n.branchIndex % colors.length !== ci) continue;
            ctx.rect(n.x, n.y, Math.max(minSize, n.width), Math.max(minSize, n.height));
          }
          ctx.fillStyle = colors[ci];
          ctx.fill();
        }
        // 根节点用强调色单独绘制，便于快速定位中心
        ctx.globalAlpha = 1;
        ctx.fillStyle = style.getPropertyValue('--editor-accent').trim() || '#3b82f6';
        for (const n of nodes) {
          if (n.level === 0) ctx.fillRect(n.x, n.y, Math.max(minSize, n.width), Math.max(minSize, n.height));
        }
      },
    };
  }, [contentBounds, nodes, links, theme.branchColors]);

  // 缩略图视口：缩放或画布尺寸变化时换新引用，促使视口框同步
  const getMinimapViewport = useCallback(() => ({
    left: -panRef.current.x / zoom,
    top: -panRef.current.y / zoom,
    width: viewportSize.width / zoom,
    height: viewportSize.height / zoom,
  }), [zoom, viewportSize]);

  // 在缩略图上点选 / 拖动：把可视区域中心移到对应位置
  const handleMinimapNavigate = useCallback((centerX: number, centerY: number) => {
    setPan({
      x: viewportSize.width / 2 - centerX * zoomRef.current,
      y: viewportSize.height / 2 - centerY * zoomRef.current,
    });
  }, [setPan, viewportSize]);

  // 内容全部移出视野时显示“滚动回到内容”（同画板）；只在状态翻转时触发渲染
  const [contentOffscreen, setContentOffscreen] = useState(false);
  const contentOffscreenRef = useRef(false);
  checkOffscreenRef.current = () => {
    const z = zoomRef.current;
    const vLeft = -panRef.current.x / z;
    const vTop = -panRef.current.y / z;
    const vRight = vLeft + viewportSize.width / z;
    const vBottom = vTop + viewportSize.height / z;
    const intersects = (l: number, t: number, w: number, h: number) => l < vRight && l + w > vLeft && t < vBottom && t + h > vTop;
    // 先比外接矩形，相交时再逐个节点确认（视野可能落在分支之间的空白里），找到一个可见节点即停
    const offscreen = !contentBounds
      || !intersects(contentBounds.left, contentBounds.top, contentBounds.width, contentBounds.height)
      || !nodes.some((n) => intersects(n.x, n.y, n.width, n.height));
    if (offscreen === contentOffscreenRef.current) return;
    contentOffscreenRef.current = offscreen;
    setContentOffscreen(offscreen);
  };
  // 布局、缩放、画布尺寸变化后重新判断
  useEffect(() => {
    checkOffscreenRef.current();
  }, [nodes, zoom, viewportSize]);

  // 回到内容：整图放得下就居中整图，否则把中心主题移到画面中央，缩放不变
  const handleScrollBackToContent = () => {
    if (!contentBounds) return;
    const z = zoomRef.current;
    const fits = contentBounds.width * z <= viewportSize.width && contentBounds.height * z <= viewportSize.height;
    const rootNode = nodes.find((n) => n.level === 0);
    const target = fits || !rootNode
      ? { x: contentBounds.left + contentBounds.width / 2, y: contentBounds.top + contentBounds.height / 2 }
      : { x: rootNode.x + rootNode.width / 2, y: rootNode.y + rootNode.height / 2 };
    setPan({ x: viewportSize.width / 2 - target.x * z, y: viewportSize.height / 2 - target.y * z });
  };

  // 画布容器虽是 overflow:hidden，编辑节点时浏览器仍会滚动它把光标露出来，
  // 导致缩略图、快捷键提示等绝对定位控件整体上移；视图位置只由 pan 决定，滚动一律复位
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const resetScroll = () => {
      if (el.scrollTop !== 0) el.scrollTop = 0;
      if (el.scrollLeft !== 0) el.scrollLeft = 0;
    };
    el.addEventListener('scroll', resetScroll);
    return () => el.removeEventListener('scroll', resetScroll);
  }, []);

  // 搜索跳转：把当前匹配节点平移到画布中央（focusSeq 每次显式跳转递增；
  // 跳转可能刚展开折叠分支，effect 在新布局渲染后执行，nodes 已含目标节点）
  const searchFocusSeq = searchHighlight?.focusSeq ?? 0;
  useEffect(() => {
    if (!searchFocusSeq) return;
    const targetId = searchHighlight?.currentId;
    const container = containerRef.current;
    const target = targetId ? nodes.find((n) => n.node.id === targetId) : undefined;
    if (!container || !target) return;
    setPan({
      x: container.clientWidth / 2 - (target.x + target.width / 2) * zoom,
      y: container.clientHeight / 2 - (target.y + target.height / 2) * zoom,
    });
    // 仅响应跳转序号变化，不随缩放/布局变化反复居中
  }, [searchFocusSeq]);

  // 深度克隆并更新树
  const updateTree = useCallback(
    (mutator: (clonedRoot: MindNode) => void) => {
      const cloned = cloneMindmapTree(root);
      mutator(cloned);
      onChange(cloned);
    },
    [root, onChange],
  );

  // 切换节点折叠
  const handleToggleExpand = (id: string) => {
    updateTree((cloned) => {
      updateNodeById(cloned, id, (target) => { target.isExpanded = !target.isExpanded; });
    });
  };

  /**
   * 新增节点并在一次树更新中提交当前编辑内容，随后把光标移动到新节点
   * @param mode 'child' 新增子节点（Tab）；'sibling' 新增同级节点（Enter）
   * @param anchorId 基准节点 id
   * @param commitCurrent 是否顺带提交当前正在编辑的标题（从输入框内继续新增时为 true）
   */
  const createLinkedNode = (
    mode: 'child' | 'sibling',
    anchorId: string,
    commitCurrent = false,
  ) => {
    // 根节点没有同级，Enter 时退化为新增子节点
    const effectiveMode = mode === 'sibling' && anchorId === root.id ? 'child' : mode;
    const newNode: MindNode = {
      id: generateNodeId(),
      text: '',
      isExpanded: true,
      children: [],
    };
    const editingTarget = editingNodeIdRef.current;
    // 空标题直接保存为空字符串，不写入占位文字
    const committed = trimDraft(editDraftRef.current);

    let inserted = false;
    updateTree((cloned) => {
      // 先提交正在编辑的标题，保证文本不丢失（单次更新，避免历史被拆成两条）
      if (commitCurrent && editingTarget) {
        setNodeTextById(cloned, editingTarget, committed.text, committed.marks);
      }
      inserted =
        effectiveMode === 'child'
          ? insertChildNode(cloned, anchorId, newNode)
          : insertSiblingNode(cloned, anchorId, newNode);
    });

    if (!inserted) return;

    pendingSelectAllRef.current = newNode.id;
    setSelectedNodeId(newNode.id);
    setEditDraft({ text: '' });
    setEditingNodeId(newNode.id);
  };

  // 保存最新 createLinkedNode 引用，供全局快捷键在稳定闭包中调用
  const createLinkedNodeRef = useRef(createLinkedNode);
  createLinkedNodeRef.current = createLinkedNode;

  // 添加子节点
  const handleAddChild = (parentId: string) => {
    createLinkedNode('child', parentId, false);
  };

  // 删除节点
  const handleDeleteNode = (id: string) => {
    if (id === root.id) return;
    updateTree((cloned) => {
      function removeChild(n: MindNode): boolean {
        if (n.children && n.children.length > 0) {
          const idx = n.children.findIndex((c) => c.id === id);
          if (idx !== -1) {
            n.children.splice(idx, 1);
            return true;
          }
          for (const c of n.children) {
            if (removeChild(c)) return true;
          }
        }
        return false;
      }
      removeChild(cloned);
    });
    if (selectedNodeId === id) setSelectedNodeId(null);
  };

  /**
   * 请求删除节点：含子节点时先弹二次确认；删除后选中其父节点，便于连续操作
   */
  const requestDeleteNode = (id: string) => {
    if (id === root.id) return;
    const target = findNodeById(root, id);
    if (!target) return;
    const descendantCount = countSubtreeDescendants(target);
    if (descendantCount > 0) {
      setDeleteConfirm({ nodeId: id, descendantCount });
      return;
    }
    const parent = findParentNode(root, id);
    handleDeleteNode(id);
    if (parent) setSelectedNodeId(parent.id);
  };
  const requestDeleteNodeRef = useRef(requestDeleteNode);
  requestDeleteNodeRef.current = requestDeleteNode;

  /** 设置单个节点的对齐 / 图片显示方式；传 undefined 表示恢复跟随设置 */
  const setNodeStyleField = (id: string, field: 'textAlign' | 'imageFit', value: string | undefined) => {
    updateTree((cloned) => {
      updateNodeById(cloned, id, (node) => {
        if (value === undefined) delete node[field];
        else (node as unknown as Record<string, unknown>)[field] = value;
      });
    });
  };

  /** 格式菜单：对编辑框当前选区应用格式 */
  const handleFormatPatch = (patch: StylePatch) => {
    titleEditorRef.current?.applyPatch(patch);
  };

  /**
   * 完成就地标题编辑
   * @param targetId 触发提交的输入框所属节点；当编辑目标已切换到新节点时自动忽略
   *   （避免「新增节点导致旧输入框失焦」把新节点的编辑态误关闭）
   */
  const handleFinishEdit = (targetId?: string) => {
    const id = targetId ?? editingNodeIdRef.current;
    if (!id || id !== editingNodeIdRef.current) return;
    // 空标题直接保存为空字符串，不写入占位文字
    const committed = trimDraft(editDraftRef.current);

    updateTree((cloned) => {
      setNodeTextById(cloned, id, committed.text, committed.marks);
    });

    setEditingNodeId(null);
    setEditDraft({ text: '' });
  };

  // 更新节点图标
  const handleIconChange = (id: string, icon?: string) => {
    updateTree((cloned) => {
      function findAndSet(n: MindNode) {
        if (n.id === id) {
          n.icon = icon;
          return true;
        }
        for (const c of n.children || []) {
          if (findAndSet(c)) return true;
        }
        return false;
      }
      findAndSet(cloned);
    });
  };

  // 完成就地备注编辑
  const handleFinishNoteEdit = () => {
    if (!editingNoteNodeId) return;
    const targetId = editingNoteNodeId;
    const noteText = editNoteText.trim() ? editNoteText : undefined;

    updateTree((cloned) => {
      function findAndSet(n: MindNode) {
        if (n.id === targetId) {
          n.note = noteText;
          return true;
        }
        for (const c of n.children || []) {
          if (findAndSet(c)) return true;
        }
        return false;
      }
      findAndSet(cloned);
    });

    setEditingNoteNodeId(null);
    setEditNoteText('');
  };

  // 上传/替换图片
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetNodeId = uploadTargetNodeIdRef.current;
    if (!file || !targetNodeId) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        const imgData = reader.result;
        updateTree((cloned) => {
          function findAndSet(n: MindNode) {
            if (n.id === targetNodeId) {
              n.image = imgData;
              return true;
            }
            for (const c of n.children || []) {
              if (findAndSet(c)) return true;
            }
            return false;
          }
          findAndSet(cloned);
        });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // 删除图片
  const handleDeleteImage = (id: string) => {
    updateTree((cloned) => {
      function findAndSet(n: MindNode) {
        if (n.id === id) {
          n.image = undefined;
          return true;
        }
        for (const c of n.children || []) {
          if (findAndSet(c)) return true;
        }
        return false;
      }
      findAndSet(cloned);
    });
  };

  /** 写入节点手动宽度；传 undefined 表示重置为跟随设置 */
  const setNodeWidth = (id: string, width: number | undefined) => {
    updateTree((cloned) => {
      updateNodeById(cloned, id, (node) => {
        if (width === undefined) delete node.width;
        else node.width = width;
      });
    });
  };

  // ── 节点宽度拉伸 ──

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>, layoutNode: LayoutNode) => {
    if (e.button !== 0) return;
    // 阻止冒泡到节点拖拽与画布平移
    e.stopPropagation();
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    resizeSessionRef.current = {
      nodeId: layoutNode.node.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: layoutNode.width,
      edge: layoutNode.freeEdge,
      hasImage: Boolean(layoutNode.node.image),
      moved: false,
    };
    document.body.style.cursor = 'ew-resize';
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const session = resizeSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    e.stopPropagation();
    // 屏幕位移换算到导图坐标，左侧手柄向左拉为变宽
    const delta = ((e.clientX - session.startX) / zoom) * (session.edge === 'right' ? 1 : -1);
    if (!session.moved && Math.abs(delta) < 1) return;
    session.moved = true;
    setResizePreview({
      id: session.nodeId,
      width: clampManualWidth(session.startWidth + delta, session.hasImage),
    });
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const session = resizeSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    e.stopPropagation();
    resizeSessionRef.current = null;
    document.body.style.cursor = 'default';
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    const preview = resizePreview;
    setResizePreview(null);
    // 松手时一次性写入，作为一个撤销步
    if (session.moved && preview && preview.id === session.nodeId) {
      setNodeWidth(session.nodeId, preview.width);
    }
  };

  // ── 节点拖拽核心逻辑 (Pointer Events 丝滑整树拖拽) ──

  // 节点按下准备拖拽
  const handleNodePointerDown = (e: React.PointerEvent, layoutNode: LayoutNode) => {
    // 仅允许左键且非根节点参与拖拽
    if (e.button !== 0 || layoutNode.level === 0) return;

    // 排除点击输入框、按钮、图片缩略图与拉伸手柄等交互子元素
    // （图片若被节点捕获指针，click 会派发给节点而不是图片，导致需要连点多次才能打开预览）
    const target = e.target as HTMLElement;
    if (
      target.closest('button') ||
      target.closest('input') ||
      target.closest('textarea') ||
      target.closest('[data-mindmap-image]') ||
      target.closest('[data-resize-handle]')
    ) {
      return;
    }
    if (editingNodeId === layoutNode.node.id || editingNoteNodeId === layoutNode.node.id) {
      return;
    }

    e.stopPropagation();

    // 记录拖拽会话并捕获指针
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    dragSessionRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      sourceNode: layoutNode.node,
      isDragging: false,
    };
  };

  // 全局指针移动：处理拖拽中位移计算与最近有效落点判定，或画布平移
  const handlePointerMove = (e: React.PointerEvent) => {
    // 0. 触屏双指捏合：按两指距离比例缩放，并让捏合中心跟随手指移动
    if (e.pointerType === 'touch' && touchPointsRef.current.has(e.pointerId)) {
      touchPointsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pinch = pinchRef.current;
      const containerEl = containerRef.current;
      if (pinch && containerEl && touchPointsRef.current.size >= 2) {
        const [p1, p2] = Array.from(touchPointsRef.current.values());
        const rect = containerEl.getBoundingClientRect();
        const dist = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
        const midX = (p1.x + p2.x) / 2 - rect.left;
        const midY = (p1.y + p2.y) / 2 - rect.top;
        const nextZoom = Math.min(3, Math.max(0.2, pinch.startZoom * (dist / pinch.startDist)));
        setPan({ x: midX - pinch.worldX * nextZoom, y: midY - pinch.worldY * nextZoom });
        onZoomChange(nextZoom);
        return;
      }
    }

    const session = dragSessionRef.current;

    // 1. 若当前非节点拖拽会话，走普通画布鼠标平移
    if (!session) {
      if (isPanning) {
        setPan({
          x: e.clientX - panStartRef.current.x,
          y: e.clientY - panStartRef.current.y,
        });
      }
      return;
    }

    const deltaX = Math.abs(e.clientX - session.startX);
    const deltaY = Math.abs(e.clientY - session.startY);

    // 位移超过 4px 正式激活拖拽状态
    if (!session.isDragging) {
      if (deltaX > 4 || deltaY > 4) {
        session.isDragging = true;
        setIsDraggingNode(true);
        setDraggedNodeId(session.sourceNode.id);
        document.body.style.cursor = 'grabbing';
      } else {
        return;
      }
    }

    // 更新跟随光标的半透明悬浮卡片
    session.descendantIds ??= new Set(Array.from(walkMindNodes(session.sourceNode), (node) => node.id));
    const descendantCount = session.descendantIds.size - 1;
    setDragPreview({
      x: e.clientX,
      y: e.clientY,
      node: session.sourceNode,
      descendantCount,
    });

    // 屏幕视口坐标转导图世界坐标系
    const containerEl = containerRef.current;
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const worldX = (e.clientX - rect.left - panRef.current.x) / zoom;
    const worldY = (e.clientY - rect.top - panRef.current.y) / zoom;

    // 寻找最近有效落点目标 (严格过滤自身及所有子孙节点，防止成环)
    let closest: DropTargetState | null = null;
    let minDistance = Infinity;

    for (const lNode of nodes) {
      const tId = lNode.node.id;
      if (
        tId === session.sourceNode.id ||
        session.descendantIds.has(tId)
      ) {
        continue;
      }

      const nx = lNode.x;
      const ny = lNode.y;
      const nw = lNode.width;
      const nh = lNode.height;
      const nLevel = lNode.level;

      // 判定区域范围扩展容差
      const paddingH = 64;
      const paddingV = 26;

      if (
        worldX >= nx - 24 &&
        worldX <= nx + nw + paddingH &&
        worldY >= ny - paddingV &&
        worldY <= ny + nh + paddingV
      ) {
        const centerX = nx + nw / 2;
        const centerY = ny + nh / 2;
        const dist = Math.hypot(worldX - centerX, worldY - centerY);

        if (dist < minDistance) {
          minDistance = dist;
          let pos: DropPosition = 'inside';

          if (nLevel === 0) {
            // 根节点仅允许作为子分支挂载
            pos = 'inside';
          } else if (lNode.siblingFlow !== 'down') {
            // 同级横向排列（组织图 / 时间轴 / 鱼骨图）：按水平位置判定前后
            const ratio = (worldX - nx) / Math.max(1, nw);
            const nearStart = ratio < 0.25;
            const nearEnd = ratio > 0.75;
            if (lNode.siblingFlow === 'right') {
              pos = nearStart ? 'before' : nearEnd ? 'after' : 'inside';
            } else {
              pos = nearEnd ? 'before' : nearStart ? 'after' : 'inside';
            }
          } else {
            // 顶部 32% 范围或上方边界 -> 作为前置同级兄弟节点
            if (worldY < ny + nh * 0.32) {
              pos = 'before';
            }
            // 底部 32% 范围或下方边界 -> 作为后置同级兄弟节点
            else if (worldY > ny + nh * 0.68) {
              pos = 'after';
            }
            // 中部区域或向右延展 -> 作为子节点挂载
            else {
              pos = 'inside';
            }
          }

          closest = {
            targetId: tId,
            pos,
            targetLayout: lNode,
          };
        }
      }
    }

    setDropTarget(closest);
  };

  // 全局指针释放：提交树结构变更或重置状态
  const handlePointerUp = (e: React.PointerEvent) => {
    if (isPanning) {
      setIsPanning(false);
    }

    const session = dragSessionRef.current;
    if (!session) return;

    try {
      const el = e.currentTarget as HTMLElement;
      if (el && el.hasPointerCapture && el.hasPointerCapture(session.pointerId)) {
        el.releasePointerCapture(session.pointerId);
      }
    } catch {
      // ignore
    }

    const currentDropTarget = dropTarget;
    const sourceId = session.sourceNode.id;
    const wasDragging = session.isDragging;

    dragSessionRef.current = null;
    setIsDraggingNode(false);
    setDraggedNodeId(null);
    setDragPreview(null);
    setDropTarget(null);
    document.body.style.cursor = 'default';

    // 若处于真实拖拽态且存在有效落点，执行整树转移
    if (wasDragging && currentDropTarget) {
      updateTree((cloned) => {
        const nextRoot = moveMindNode(
          cloned,
          sourceId,
          currentDropTarget.targetId,
          currentDropTarget.pos,
        );
        // 整体替换根节点字段，避免新增字段（格式、宽度等）在搬移后丢失
        for (const key of Object.keys(cloned)) delete (cloned as unknown as Record<string, unknown>)[key];
        Object.assign(cloned, nextRoot);
      });
      setSelectedNodeId(sourceId);
    }
  };

  // 触屏按下（捕获阶段，节点自身的 pointerdown 会阻止冒泡）：单指空白处平移，第二指落下进入捏合
  const handleTouchPointerDownCapture = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    lastTouchAtRef.current = Date.now();
    touchPointsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const points = Array.from(touchPointsRef.current.values());

    if (points.length === 1) {
      // 单指：仅在空白画布处开始平移，节点上的按下交给节点拖拽逻辑
      const target = e.target as HTMLElement;
      // 缩略图自行处理拖动，不能同时触发画布平移
      if (target.closest('[data-minimap]')) {
        touchPointsRef.current.delete(e.pointerId);
        return;
      }
      if (!target.closest('.nb-mindmap-node') && !target.closest('button, input, textarea')) {
        setIsPanning(true);
        panStartRef.current = { x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y };
      }
      return;
    }

    // 第二指落下：中止单指平移与节点拖拽，记录捏合起点
    const containerEl = containerRef.current;
    if (!containerEl) return;
    const [p1, p2] = points;
    const rect = containerEl.getBoundingClientRect();
    const midX = (p1.x + p2.x) / 2 - rect.left;
    const midY = (p1.y + p2.y) / 2 - rect.top;
    pinchRef.current = {
      startDist: Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
      startZoom: zoom,
      worldX: (midX - panRef.current.x) / zoom,
      worldY: (midY - panRef.current.y) / zoom,
    };
    setIsPinching(true);
    setIsPanning(false);
    if (dragSessionRef.current) {
      dragSessionRef.current = null;
      setIsDraggingNode(false);
      setDraggedNodeId(null);
      setDragPreview(null);
      setDropTarget(null);
      document.body.style.cursor = 'default';
    }
  };

  // 触点抬起 / 被系统取消：移出触点表；捏合结束后若仍剩一指，则从该指位置无缝续接平移
  const handleTouchPointerEnd = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch' || !touchPointsRef.current.has(e.pointerId)) return;
    lastTouchAtRef.current = Date.now();
    touchPointsRef.current.delete(e.pointerId);
    if (pinchRef.current && touchPointsRef.current.size < 2) {
      pinchRef.current = null;
      setIsPinching(false);
      const rest = Array.from(touchPointsRef.current.values())[0];
      if (rest) {
        setIsPanning(true);
        panStartRef.current = { x: rest.x - panRef.current.x, y: rest.y - panRef.current.y };
      }
    }
  };

  // 画布鼠标按下平移
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.nb-mindmap-node')) return;
    // 触屏点按后补发的兼容鼠标事件：只保留取消选中，不进入平移态（否则后续无 pointerup 复位）
    if (Date.now() - lastTouchAtRef.current < 800) {
      setSelectedNodeId(null);
      return;
    }
    setIsPanning(true);
    setSelectedNodeId(null);
    panStartRef.current = { x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y };
  };

  // 按 Esc 随时平滑取消当前拖拽
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragSessionRef.current) {
        dragSessionRef.current = null;
        setIsDraggingNode(false);
        setDraggedNodeId(null);
        setDragPreview(null);
        setDropTarget(null);
        document.body.style.cursor = 'default';
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 选中节点后：Tab 新增子节点，Enter 新增同级节点（两者均把光标移到新节点）
  useEffect(() => {
    const handleShortcut = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // 输入类元素、按钮或弹层内的按键交还原生行为（大纲/备注/工具条/下拉框）
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.tagName === 'BUTTON' ||
          el.isContentEditable)
      ) {
        return;
      }
      // 正在就地编辑标题或确认删除时，快捷键由输入框 / 对话框自身接管
      if (editingNodeIdRef.current || deleteConfirmRef.current) return;

      const selected = selectedNodeIdRef.current;
      if (!selected) return;

      if (e.key === 'Delete') {
        // 焦点在画布之外（如文件树、其他面板）时不响应，避免误删节点
        const container = containerRef.current;
        if (el && el !== document.body && container && !container.contains(el) && !el.contains(container)) return;
        e.preventDefault();
        requestDeleteNodeRef.current(selected);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        createLinkedNodeRef.current('child', selected, false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        createLinkedNodeRef.current('sibling', selected, false);
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  // 滚轮缩放与平移：React 的 onWheel 是 passive 监听，preventDefault 无效，
  // Ctrl+滚轮会同时触发 WebView 页面缩放，因此改为原生非 passive 绑定
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      // 画布内的浮层（备注对话框、图标选择器）保留原生滚动
      if ((e.target as HTMLElement | null)?.closest?.('[data-mindmap-overlay]')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const nextZoom = Math.min(3, Math.max(0.2, zoomRef.current + delta));
        onZoomChangeRef.current(nextZoom);
      } else {
        setPan((p) => ({
          x: p.x - e.deltaX * 0.8,
          y: p.y - e.deltaY * 0.8,
        }));
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onPointerDownCapture={handleTouchPointerDownCapture}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => {
        handleTouchPointerEnd(e);
        handlePointerUp(e);
      }}
      onPointerCancel={(e) => {
        // 系统取消触点（如来电、手势被接管）：只复位状态，不提交拖拽落点
        handleTouchPointerEnd(e);
        setIsPanning(false);
        if (dragSessionRef.current) {
          dragSessionRef.current = null;
          setIsDraggingNode(false);
          setDraggedNodeId(null);
          setDragPreview(null);
          setDropTarget(null);
          document.body.style.cursor = 'default';
        }
      }}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
        cursor: isDraggingNode ? 'grabbing' : isPanning ? 'grabbing' : 'default',
        background: 'var(--editor-bg, #ffffff)',
        userSelect: 'none',
        // 触屏手势（平移 / 双指缩放）全部由画布自行处理，禁止浏览器默认滚动与页面缩放
        touchAction: 'none',
      }}
    >
      {/* 隐藏的图片文件选择 input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />

      {/* 缩放与平移图层 */}
      <div
        ref={transformLayerRef}
        style={{
          position: 'absolute',
          transform: `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
          transition: isPanning || isDraggingNode || isPinching ? 'none' : 'transform 0.05s ease-out',
        }}
      >
        {/* SVG 贝塞尔曲线连接线图层 */}
        <svg
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 8000,
            height: 8000,
            pointerEvents: 'none',
            overflow: 'visible',
          }}
        >
          {/* 装饰线：时间轴主轴、鱼骨脊柱 */}
          {decorations.map((deco, idx) => (
            <path
              key={`deco-${idx}`}
              d={deco.path}
              fill={deco.filled ? 'var(--editor-text-secondary, #64748b)' : 'none'}
              stroke="var(--editor-text-secondary, #64748b)"
              strokeWidth={deco.strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.55}
            />
          ))}
          {visibleLinks.map((link, idx) => {
            const color =
              theme.branchColors[link.to.branchIndex % theme.branchColors.length] ??
              theme.branchColors[0];

            return (
              <path
                key={idx}
                d={link.path}
                fill="none"
                stroke={color}
                strokeWidth={link.from.level === 0 ? 2.5 : 1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={theme.edgeOpacity}
              />
            );
          })}
        </svg>

        {/* 拖拽重排序落位高亮指示线 (Drop Indicator Line - 前置 before / 后置 after)：
            同级纵向排列时为横线，横向排列（组织图 / 时间轴 / 鱼骨图）时为竖线 */}
        {isDraggingNode && dropTarget && dropTarget.pos !== 'inside' && (() => {
          const rect = getDropIndicatorRect(dropTarget.targetLayout, dropTarget.pos);
          return (
            <div
              style={{
                position: 'absolute',
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                background: 'var(--editor-accent, #3b82f6)',
                borderRadius: 2,
                boxShadow: '0 0 8px rgba(59, 130, 246, 0.85), 0 0 2px #3b82f6',
                zIndex: 60,
                pointerEvents: 'none',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: rect.vertical ? -3.5 : -4,
                  top: rect.vertical ? -4 : -3.5,
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: 'var(--editor-accent, #3b82f6)',
                  boxShadow: '0 0 6px rgba(59, 130, 246, 0.9)',
                }}
              />
            </div>
          );
        })()}

        {/* 节点卡片 DOM 图层 */}
        {visibleNodes.map((n) => {
          const isRoot = n.level === 0;
          const isLevel1 = n.level === 1;
          const isEditing = editingNodeId === n.node.id;
          const isSelected = selectedNodeId === n.node.id;
          const searchRanges = searchHighlight?.ranges.get(n.node.id);
          const isSearchCurrent = searchHighlight?.currentId === n.node.id;
          const hasChildren = Boolean(n.node.children && n.node.children.length > 0);
          const isExpanded = n.node.isExpanded !== false;
          const nodeColor =
            theme.branchColors[n.branchIndex % theme.branchColors.length] ?? theme.branchColors[0];
          // 非根节点卡片背景：按主题比例混入所属分支色，自动适配浅色/深色全局主题
          const nodeSurface = theme.nodeTint
            ? `color-mix(in srgb, ${nodeColor} ${theme.nodeTint}%, var(--editor-surface, #ffffff))`
            : 'var(--editor-surface, #ffffff)';
          const hasIcon = Boolean(n.node.icon);
          const hasNote = Boolean(n.node.note);
          const hasImage = Boolean(n.node.image);
          // 标题排版参数与布局引擎共用，保证换行位置一致
          const textStyle = getNodeTextStyle(n.level);
          const titleHeight = titleBlockHeight(n.level, n.titleLines.length);
          // 对齐方式由布局引擎合并节点设置与全局设置
          const textAlign = n.textAlign;
          const hasCustomWidth = typeof n.node.width === 'number';
          const isResizing = resizePreview?.id === n.node.id;

          // 拖拽相关状态计算
          const isBeingDragged = isDraggingNode && draggedNodeId === n.node.id;
          const isDescendantOfDragged =
            isDraggingNode &&
            draggedNodeId !== null &&
            draggedDescendantIds.has(n.node.id);
          const isSourceOrDescendant = isBeingDragged || isDescendantOfDragged;
          const isDropTargetInside =
            isDraggingNode && dropTarget?.targetId === n.node.id && dropTarget.pos === 'inside';

          return (
            <div
              key={n.node.id}
              className="nb-mindmap-node"
              onPointerDown={(e) => handleNodePointerDown(e, n)}
              onClick={(e) => {
                e.stopPropagation();
                if (!isDraggingNode) {
                  setSelectedNodeId(n.node.id);
                }
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                // 双击图片或拉伸手柄不进入标题编辑
                const target = e.target as HTMLElement;
                if (target.closest('[data-mindmap-image]') || target.closest('[data-resize-handle]')) return;
                if (!isDraggingNode) {
                  setEditingNodeId(n.node.id);
                  setEditDraft({ text: n.node.text, marks: n.node.marks });
                }
              }}
              style={{
                position: 'absolute',
                left: n.x,
                top: n.y,
                width: n.width,
                height: n.height,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: hasNote || hasImage ? 'flex-start' : 'center',
                background: isDropTargetInside
                  ? isRoot
                    ? theme.rootBackground
                    : 'rgba(59, 130, 246, 0.12)'
                  : isRoot
                    ? theme.rootBackground
                    : nodeSurface,
                color: isRoot
                  ? theme.rootText
                  : 'var(--editor-text, #1e293b)',
                border: isRoot
                  ? isSelected || isDropTargetInside
                    ? `2px solid ${theme.rootText}`
                    : 'none'
                  : isDropTargetInside
                    ? '2px solid var(--editor-accent, #3b82f6)'
                    : isSourceOrDescendant
                      ? '1.5px dashed var(--editor-border, #94a3b8)'
                      : `1.5px solid ${isSelected ? 'var(--editor-accent, #3b82f6)' : isLevel1 ? nodeColor : 'var(--editor-border, #cbd5e1)'}`,
                borderRadius: isRoot ? 10 : 8,
                boxShadow: isDropTargetInside
                  ? '0 0 0 2.5px var(--editor-accent, #3b82f6), 0 0 20px rgba(59, 130, 246, 0.45)'
                  : isSelected
                    ? '0 0 0 2px var(--editor-accent, #3b82f6), 0 8px 20px rgba(0, 0, 0, 0.12)'
                    : isRoot
                      ? theme.rootShadow
                      : '0 2px 6px rgba(0, 0, 0, 0.05)',
                padding: `${textStyle.paddingY}px ${textStyle.paddingX}px`,
                cursor: isEditing ? 'text' : isDraggingNode ? 'grabbing' : isRoot ? 'default' : 'grab',
                opacity: isSourceOrDescendant ? 0.35 : 1,
                transform: isSourceOrDescendant ? 'scale(0.97)' : isDropTargetInside ? 'scale(1.02)' : 'none',
                boxSizing: 'border-box',
                // 搜索命中：外描边标出命中节点，当前项用强调色加粗
                outline: isSearchCurrent
                  ? '2.5px solid var(--cm-search-active-bg)'
                  : searchRanges
                    ? '2px solid var(--cm-search-match-bg)'
                    : undefined,
                outlineOffset: 2,
                transition: 'border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease, opacity 0.2s ease, transform 0.15s ease',
              }}
            >
              {/* 作为子分支接入的高亮指示圆点 */}
              {isDropTargetInside && (
                <div
                  style={{
                    position: 'absolute',
                    ...sideButtonStyle(n.childSide, -8),
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: 'var(--editor-accent, #3b82f6)',
                    color: '#ffffff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 700,
                    boxShadow: '0 0 8px rgba(59, 130, 246, 0.9)',
                    zIndex: 65,
                    pointerEvents: 'none',
                  }}
                >
                  +
                </div>
              )}
              {/* 标题行（含前置图标） */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  height: titleHeight,
                  flexShrink: 0,
                }}
              >
                {/* 节点前置图标 */}
                {hasIcon && (
                  <Tooltip content="点击修改或移除图标" side="top" sideOffset={4}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        setIconPickerState({
                          nodeId: n.node.id,
                          currentIcon: n.node.icon,
                          x: rect.left,
                          y: rect.bottom + 4,
                        });
                      }}
                      aria-label="点击修改或移除图标"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: textStyle.iconSize,
                        lineHeight: 1,
                        width: textStyle.iconWidth - 4,
                        boxSizing: 'border-box',
                        display: 'flex',
                        justifyContent: 'center',
                        padding: '0 2px',
                        marginRight: 4,
                        flexShrink: 0,
                        transition: 'transform 0.12s ease',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.2)')}
                      onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                    >
                      {n.node.icon}
                    </button>
                  </Tooltip>
                )}

                {/* 标题文本 / 输入框 */}
                {isEditing ? (
                  // 所见即所得富文本编辑：选中文字后弹出格式菜单
                  <MindmapTitleEditor
                    key={n.node.id}
                    ref={titleEditorRef}
                    initialText={editDraft.text}
                    initialMarks={editDraft.marks}
                    selectAll={pendingSelectAllRef.current === n.node.id}
                    fontSize={textStyle.fontSize}
                    fontWeight={textStyle.fontWeight}
                    lineHeight={textStyle.lineHeight}
                    color={isRoot ? theme.rootText : 'inherit'}
                    textAlign={textAlign}
                    minHeight={n.titleLines.length * textStyle.lineHeight}
                    onDraftChange={setEditDraft}
                    // 编辑状态下继续用 Tab / Enter 连续新增，光标自动转移到新节点
                    onTab={() => createLinkedNode('child', n.node.id, true)}
                    onEnter={() => createLinkedNode('sibling', n.node.id, true)}
                    onEscape={() => handleFinishEdit(n.node.id)}
                    onBlur={() => handleFinishEdit(n.node.id)}
                    onSelectionChange={setFormatSelection}
                  />
                ) : (
                  // 标题按布局引擎断好的行逐行渲染（超出宽度自动换行，不再省略截断），并套用富文本格式
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: textStyle.fontSize,
                      fontWeight: textStyle.fontWeight,
                      lineHeight: `${textStyle.lineHeight}px`,
                      textAlign,
                    }}
                  >
                    {n.titleLines.map((line, idx) => (
                      <div key={idx} className="nb-mindmap-title-line" style={{ height: textStyle.lineHeight }}>
                        {renderStyledLine(line.text, line.start, n.marks, searchRanges, textStyle.fontWeight)}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 浅色小字备注 (支持多行文本与换行) */}
              {hasNote && (
                <Tooltip content={n.node.note} side="bottom" sideOffset={4}>
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingNoteNodeId(n.node.id);
                      setEditNoteText(n.node.note || '');
                    }}
                    style={{
                      fontSize: 11,
                      lineHeight: `${NOTE_LINE_HEIGHT}px`,
                      color: isRoot ? 'rgba(255, 255, 255, 0.85)' : 'var(--editor-text-secondary, #64748b)',
                      textAlign: 'left',
                      width: '100%',
                      marginTop: 3,
                      paddingTop: 3,
                      borderTop: isRoot ? '1px solid rgba(255, 255, 255, 0.2)' : '1px solid var(--editor-border, #f1f5f9)',
                      opacity: 0.9,
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    {/* 备注同样按布局引擎的断行逐行渲染，超出最大行数已在末行补省略号 */}
                    {n.noteLines.map((line, idx) => (
                      <div key={idx} className="nb-mindmap-title-line" style={{ height: NOTE_LINE_HEIGHT }}>
                        {line}
                      </div>
                    ))}
                  </div>
                </Tooltip>
              )}

              {/* 挂载图片：原始比例按固有宽高等比显示；宽度填充为固定高度裁切 */}
              {hasImage && n.node.image && n.imageBox && (
                <div
                  style={{
                    marginTop: 4,
                    borderRadius: 4,
                    overflow: 'hidden',
                    width: n.imageBox.width + 2,
                    height: n.imageBox.height + 2,
                    flexShrink: 0,
                    boxSizing: 'border-box',
                    alignSelf: textAlign === 'center' ? 'center' : 'flex-start',
                    position: 'relative',
                    border: '1px solid var(--editor-border, rgba(0,0,0,0.08))',
                  }}
                >
                  <Tooltip content="点击放大查看大图" side="top" sideOffset={4}>
                    <img
                      data-mindmap-image
                      draggable={false}
                      src={n.node.image}
                      alt="节点缩略图"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreviewImage(n.node.image!);
                      }}
                      style={{
                        width: n.imageBox.width,
                        height: n.imageBox.height,
                        objectFit: n.imageBox.fit === 'fill' ? 'cover' : 'contain',
                        display: 'block',
                        cursor: 'zoom-in',
                      }}
                    />
                  </Tooltip>
                  <Tooltip content="删除图片" side="top" sideOffset={4}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteImage(n.node.id);
                      }}
                      aria-label="删除图片"
                      style={{
                        position: 'absolute',
                        top: 3,
                        right: 3,
                        background: 'rgba(0, 0, 0, 0.65)',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: '50%',
                        width: 16,
                        height: 16,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(239, 68, 68, 0.9)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(0, 0, 0, 0.65)')}
                    >
                      <X size={10} />
                    </button>
                  </Tooltip>
                </div>
              )}

              {/* 悬停/选中节点浮动快捷工具栏 */}
              <div
                className="nb-mindmap-node-toolbar"
                style={{
                  position: 'absolute',
                  // 子节点向上展开时工具栏移到下方，避免与折叠按钮重叠
                  ...(n.childSide === 'top' ? { bottom: -28 } : { top: -28 }),
                  left: '50%',
                  transform: 'translateX(-50%)',
                  display: isSelected ? 'flex' : 'none',
                  alignItems: 'center',
                  gap: 3,
                  padding: '2px 5px',
                  background: 'var(--editor-surface, #ffffff)',
                  border: '1px solid var(--editor-border, #cbd5e1)',
                  borderRadius: 6,
                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
                  zIndex: 20,
                }}
              >
                {/* 设置图标 */}
                <Tooltip content="设置图标" side="top" sideOffset={4}>
                  <button
                    type="button"
                    className="nb-mindmap-toolbar-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setIconPickerState({
                        nodeId: n.node.id,
                        currentIcon: n.node.icon,
                        x: rect.left,
                        y: rect.bottom + 4,
                      });
                    }}
                    aria-label="设置图标"
                  >
                    <Smile size={12} />
                  </button>
                </Tooltip>

                {/* 添加/编辑备注 */}
                <Tooltip content="添加/编辑备注" side="top" sideOffset={4}>
                  <button
                    type="button"
                    className={`nb-mindmap-toolbar-btn${hasNote ? ' is-active-accent' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingNoteNodeId(n.node.id);
                      setEditNoteText(n.node.note || '');
                    }}
                    aria-label="添加/编辑备注"
                  >
                    <FileText size={12} />
                  </button>
                </Tooltip>

                {/* 上传/替换图片 */}
                <Tooltip content="上传/替换图片" side="top" sideOffset={4}>
                  <button
                    type="button"
                    className={`nb-mindmap-toolbar-btn${hasImage ? ' is-active-accent' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      uploadTargetNodeIdRef.current = n.node.id;
                      fileInputRef.current?.click();
                    }}
                    aria-label="上传/替换图片"
                  >
                    <ImageIcon size={12} />
                  </button>
                </Tooltip>

                {/* 重置手动拉伸的宽度（仅自定义过宽度时显示） */}
                {hasCustomWidth && (
                  <Tooltip content="重置宽度" side="top" sideOffset={4}>
                    <button
                      type="button"
                      className="nb-mindmap-toolbar-btn is-active-accent"
                      onClick={(e) => {
                        e.stopPropagation();
                        setNodeWidth(n.node.id, undefined);
                      }}
                      aria-label="重置宽度"
                    >
                      <MoveHorizontal size={12} />
                    </button>
                  </Tooltip>
                )}

                {/* 节点样式：单独设置标题对齐与图片显示方式 */}
                <Tooltip content="节点样式" side="top" sideOffset={4}>
                  <button
                    type="button"
                    className={`nb-mindmap-toolbar-btn${n.node.textAlign || n.node.imageFit ? ' is-active-accent' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setNodeStylePopover((cur) =>
                        cur?.nodeId === n.node.id ? null : { nodeId: n.node.id, x: rect.left - 120, y: rect.bottom + 6 },
                      );
                    }}
                    aria-label="节点样式"
                  >
                    <Settings2 size={12} />
                  </button>
                </Tooltip>

                {/* 添加子分支 */}
                <Tooltip content="添加子分支" side="top" sideOffset={4}>
                  <button
                    type="button"
                    className="nb-mindmap-toolbar-btn is-active-accent"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddChild(n.node.id);
                    }}
                    aria-label="添加子分支"
                  >
                    <Plus size={12} />
                  </button>
                </Tooltip>

                {/* 删除节点（根节点不可删除） */}
                {!isRoot && (
                  <Tooltip content="删除节点" side="top" sideOffset={4}>
                    <button
                      type="button"
                      className="nb-mindmap-toolbar-btn is-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDeleteNode(n.node.id);
                      }}
                      aria-label="删除节点"
                    >
                      <Trash2 size={12} />
                    </button>
                  </Tooltip>
                )}
              </div>

              {/* 折叠/展开徽标 */}
              {hasChildren && (
                <Tooltip content={isExpanded ? '收起子分支' : '展开子分支'} side="right" sideOffset={4}>
                  <button
                    type="button"
                    className="nb-mindmap-fold-btn"
                    data-side={n.childSide}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleExpand(n.node.id);
                    }}
                    aria-label={isExpanded ? '收起子分支' : '展开子分支'}
                    style={{
                      position: 'absolute',
                      // 折叠按钮位于子节点展开的一侧
                      ...sideButtonStyle(n.childSide, -9),
                      width: 16,
                      height: 16,
                      borderRadius: '50%',
                      background: isRoot ? '#ffffff' : nodeColor,
                      color: isRoot ? 'var(--editor-accent, #3b82f6)' : '#ffffff',
                      border: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 10,
                      fontWeight: 700,
                      cursor: 'pointer',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
                      padding: 0,
                      zIndex: 5,
                    }}
                  >
                    {isExpanded ? '-' : n.node.children.length}
                  </button>
                </Tooltip>
              )}

              {/* 悬停添加子节点按钮 */}
              <Tooltip content="添加子分支" side="right" sideOffset={4}>
                <button
                  type="button"
                  className="nb-node-add-btn"
                  data-side={n.childSide}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAddChild(n.node.id);
                  }}
                  aria-label="添加子分支"
                  style={{
                    position: 'absolute',
                    ...sideButtonStyle(n.childSide, hasChildren ? -28 : -14),
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: 'var(--editor-accent, #3b82f6)',
                    color: '#ffffff',
                    border: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    cursor: 'pointer',
                    opacity: 0,
                    transition: 'opacity 0.15s ease',
                    zIndex: 5,
                  }}
                >
                  +
                </button>
              </Tooltip>

              {/* 宽度拉伸手柄：位于远离父节点的一侧，双击恢复默认宽度 */}
              {!isEditing && (
                <Tooltip content={hasCustomWidth ? '拖动调整宽度，双击重置' : '拖动调整宽度'} side="top" sideOffset={4} followCursor disabled={isResizing}>
                  <div
                    data-resize-handle
                    className="nb-mindmap-resize-handle"
                    data-visible={isSelected || isResizing}
                    data-dragging={isResizing}
                    onPointerDown={(e) => handleResizePointerDown(e, n)}
                    onPointerMove={handleResizePointerMove}
                    onPointerUp={handleResizePointerUp}
                    onPointerCancel={handleResizePointerUp}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      if (hasCustomWidth) setNodeWidth(n.node.id, undefined);
                    }}
                    style={n.freeEdge === 'right' ? { right: -5 } : { left: -5 }}
                  />
                </Tooltip>
              )}
            </div>
          );
        })}
      </div>

      {/* 左下角快捷键提示（紧挨撤销 / 重做，仅展示不拦截画布交互；右下角留给缩略图） */}
      <div
        style={{
          position: 'absolute',
          left: 86,
          bottom: 13,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: 6,
          background: 'color-mix(in srgb, var(--editor-surface, #ffffff) 82%, transparent)',
          border: '1px solid var(--editor-border, #e2e8f0)',
          color: 'var(--editor-text-muted, #94a3b8)',
          fontSize: 11,
          lineHeight: 1.4,
          pointerEvents: 'none',
          userSelect: 'none',
          backdropFilter: 'blur(6px)',
          maxWidth: 'calc(100% - 330px)',
          flexWrap: 'wrap',
        }}
      >
        <kbd style={HINT_KBD_STYLE}>Tab</kbd>
        <span>添加子节点</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <kbd style={HINT_KBD_STYLE}>Enter</kbd>
        <span>添加同级节点</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <kbd style={HINT_KBD_STYLE}>Delete</kbd>
        <span>删除</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>双击编辑</span>
      </div>

      {/* 内容全部移出视野时的回位按钮（底部居中，位于快捷键提示上方） */}
      {contentOffscreen && (
        <button
          type="button"
          className="nb-mindmap-scroll-back"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleScrollBackToContent}
        >
          滚动回到内容
        </button>
      )}

      {/* 右下角缩略图：大导图快速定位，可收起 */}
      <CanvasMinimap
        ref={minimapRef}
        storageKey="nb-minimap-visible:mindmap"
        getScene={getMinimapScene}
        getViewport={getMinimapViewport}
        onNavigate={handleMinimapNavigate}
        defaultVisible={!IS_MOBILE_UI}
      />

      {/* 节点图标选择器浮层 */}
      {iconPickerState && (
        <div data-mindmap-overlay>
          <MindmapIconPicker
            currentIcon={iconPickerState.currentIcon}
            position={{ x: iconPickerState.x, y: iconPickerState.y }}
            onSelect={(icon) => {
              handleIconChange(iconPickerState.nodeId, icon);
              setIconPickerState(null);
            }}
            onClose={() => setIconPickerState(null)}
          />
        </div>
      )}

      {/* 备注编辑对话框 (在导图模式下快速编辑多行备注) */}
      {editingNoteNodeId && (
        <div
          data-mindmap-overlay
          onClick={() => handleFinishNoteEdit()}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.4)',
            zIndex: 100000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 440,
              background: 'var(--editor-surface, #ffffff)',
              border: '1px solid var(--editor-border, #cbd5e1)',
              borderRadius: 8,
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.2)',
              padding: '16px 18px',
              color: 'var(--editor-text, #1e293b)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 10,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600 }}>编辑节点备注</span>
              <button
                type="button"
                className="nb-diagram-action-btn"
                onClick={() => handleFinishNoteEdit()}
                aria-label="关闭对话框"
                style={{ padding: 4 }}
              >
                <X size={14} />
              </button>
            </div>
            <textarea
              autoFocus
              rows={5}
              value={editNoteText}
              placeholder="输入备注内容 (浅色次级文字展示)..."
              onChange={(e) => setEditNoteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  handleFinishNoteEdit();
                }
              }}
              style={{
                width: '100%',
                fontSize: 12,
                lineHeight: 1.6,
                color: 'var(--editor-text-secondary, #64748b)',
                background: 'var(--editor-bg, #ffffff)',
                border: '1px solid var(--editor-border, #cbd5e1)',
                borderRadius: 6,
                padding: '8px 10px',
                outline: 'none',
                resize: 'vertical',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                marginTop: 12,
              }}
            >
              <button
                type="button"
                className="nb-editor-toolbar-btn"
                onClick={() => {
                  setEditingNoteNodeId(null);
                  setEditNoteText('');
                }}
                style={{ padding: '4px 12px' }}
              >
                取消
              </button>
              <button
                type="button"
                className="nb-editor-primary-btn"
                onClick={() => handleFinishNoteEdit()}
                style={{ padding: '4px 14px' }}
              >
                保存备注
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 图片放大预览：Portal 到 body，滚轮缩放图片而不是导图 */}
      {previewImage && (
        <MindmapImagePreview src={previewImage} onClose={() => setPreviewImage(null)} />
      )}

      {/* 选中标题文字后的格式悬浮菜单 */}
      {editingNodeId && formatSelection && (() => {
        const { draft, from, to } = formatSelection;
        const length = draft.text.length;
        const state: FormatState = {
          bold: isStyleActive(length, draft.marks, from, to, 'bold'),
          italic: isStyleActive(length, draft.marks, from, to, 'italic'),
          underline: isStyleActive(length, draft.marks, from, to, 'underline'),
          strike: isStyleActive(length, draft.marks, from, to, 'strike'),
          color: commonColor(length, draft.marks, from, to, 'color'),
          highlight: commonColor(length, draft.marks, from, to, 'highlight'),
        };
        return <MindmapTextFormatMenu rect={formatSelection.rect} state={state} onPatch={handleFormatPatch} />;
      })()}

      {/* 单个节点样式浮层 */}
      {nodeStylePopover && (() => {
        const target = findNodeById(root, nodeStylePopover.nodeId);
        if (!target) return null;
        return (
          <MindmapNodeStylePopover
            position={{ x: nodeStylePopover.x, y: nodeStylePopover.y }}
            textAlign={target.textAlign}
            imageFit={target.imageFit}
            hasImage={Boolean(target.image)}
            defaultTextAlign={defaultTextAlign}
            defaultImageFit={defaultImageFit}
            onTextAlignChange={(value) => setNodeStyleField(target.id, 'textAlign', value)}
            onImageFitChange={(value) => setNodeStyleField(target.id, 'imageFit', value)}
            onClose={() => setNodeStylePopover(null)}
          />
        );
      })()}

      {/* 删除含子节点的节点前二次确认 */}
      {deleteConfirm && (
        <MindmapConfirmDialog
          title="删除节点"
          message={`该节点下还有 ${deleteConfirm.descendantCount} 个子节点，将一并删除。删除后可用 Ctrl+Z 撤销。`}
          confirmLabel="删除"
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={() => {
            const parent = findParentNode(root, deleteConfirm.nodeId);
            handleDeleteNode(deleteConfirm.nodeId);
            if (parent) setSelectedNodeId(parent.id);
            setDeleteConfirm(null);
          }}
        />
      )}

      {/* 跟随光标的半透明悬浮拖拽预览卡片 (Drag Ghost Preview) */}
      {dragPreview && (
        <div
          style={{
            position: 'fixed',
            left: dragPreview.x + 14,
            top: dragPreview.y + 14,
            minWidth: 100,
            maxWidth: 280,
            padding: '7px 12px',
            background: 'var(--editor-surface, #ffffff)',
            color: 'var(--editor-text, #1e293b)',
            border: '1.5px solid var(--editor-accent, #3b82f6)',
            borderRadius: 8,
            boxShadow: '0 14px 30px rgba(0, 0, 0, 0.18), 0 4px 12px rgba(59, 130, 246, 0.25)',
            backdropFilter: 'blur(8px)',
            pointerEvents: 'none',
            zIndex: 100001,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            transform: 'scale(1.04)',
            transition: 'transform 0.08s ease-out',
          }}
        >
          <GripVertical size={13} style={{ color: 'var(--editor-accent, #3b82f6)', flexShrink: 0, opacity: 0.8 }} />
          {dragPreview.node.icon && (
            <span style={{ fontSize: 14, flexShrink: 0 }}>{dragPreview.node.icon}</span>
          )}
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              flex: 1,
            }}
          >
            {dragPreview.node.text || '要点'}
          </span>
          {dragPreview.descendantCount > 0 && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                background: 'rgba(59, 130, 246, 0.14)',
                color: 'var(--editor-accent, #3b82f6)',
                padding: '1px 6px',
                borderRadius: 10,
                flexShrink: 0,
              }}
            >
              +{dragPreview.descendantCount}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
