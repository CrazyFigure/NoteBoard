// NoteBoard 思维导图可视化渲染器 (Mindmap Visual Mode)
// 轻量自研 SVG 矢量渲染 + 紧凑树自适应无重叠布局 (Tidy Right-Tree) + 贝塞尔平滑连接 + 节点就地编辑
// 详见 docs/09-开发路线图.md

import React, { forwardRef, useState, useRef, useMemo, useCallback, useEffect, useImperativeHandle, useLayoutEffect } from 'react';
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
  Spline,
  Pencil,
  Link2,
} from 'lucide-react';
import type {
  MindNode,
  MindmapLayout,
  MindmapEdgeStyle,
  MindmapImageFit,
  MindmapTextAlign,
} from './mindmapTypes';
import { generateNodeId, moveMindNodes } from './mindmapConverter';
import { cloneMindmapTree, findMindNode, findMindNodeParent, getTopLevelMindNodeIds, walkMindNodes } from './mindmapTree';
import { getMindmapViewport, isMindmapNodeVisible, isMindmapLinkVisible } from './mindmapViewport';
import {
  attachmentMinWidth,
  computeMindmapLayout,
  clampManualWidth,
  titleBlockHeight,
  GALLERY_TOP_GAP,
  type LayoutNode,
  type NodeSide,
  type TextDraft,
} from './mindmapLayout';
import type { MindmapTheme } from './mindmapTheme';
import { MindmapIconPicker } from './MindmapIconPicker';
import { MindmapImagePreview } from './MindmapImagePreview';
import { MindmapFileLink } from './MindmapFileLink';
import { openFileLink, pickFileLinks } from './mindmapFileLinks';
import { appendWithLimit, getNodeFiles, getNodeImages, MAX_NODE_FILES, MAX_NODE_IMAGES } from './mindmapAttachments';
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
  FILE_LIST_TOP_GAP,
  FILE_ROW_GAP,
  NOTE_LINE_HEIGHT,
  getNodeTextStyle,
  getSharedTextMeasurer,
} from './mindmapTextMeasure';
import { Tooltip } from '../../components/Tooltip';
import { CanvasMinimap, type CanvasMinimapHandle, type MinimapScene } from '../../components/minimap/CanvasMinimap';
import { useSettingsStore } from '../../stores/settingsStore';
import { IS_MOBILE_UI, USES_COMMAND_KEY } from '../../core/platform';
import type { MindmapSearchHighlight } from './mindmapSearch';
import { formatShortcut } from '../../core/shortcuts';
import { showToast } from '../../stores/toastStore';
import {
  computeMindmapStructures,
  dragRangeEnd,
  rangeFixedEndId,
  findStructure,
  generateStructureId,
  getSiblingRangeForSelection,
  getStructureText,
  removeStructure,
  setStructureText,
  BOUNDARY_TITLE_FONT_SIZE,
  BOUNDARY_TITLE_HEIGHT,
  RELATION_FONT_SIZE,
  RELATION_LINE_HEIGHT,
  SUMMARY_FONT_SIZE,
  SUMMARY_LINE_HEIGHT,
  SUMMARY_PLACEHOLDER,
  type LayoutBoundary,
  type MindStructureRef,
} from './mindmapStructures';
import type { MindNodeRange, MindPoint } from './mindmapTypes';

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
  /** 选中节点变化（顶部操作栏据此决定概要 / 外框 / 联系线按钮是否可用） */
  onSelectionChange?: (selection: MindmapSelectionInfo) => void;
  /** 历史记录差异标记：节点 id → 新增 / 删除 / 修改 / 移动（渲染为 data-diff 属性，由历史查看样式着色） */
  diffMarks?: ReadonlyMap<string, string>;
  /** 所属文档（解析节点文件链接的相对路径）；缺省时以当前激活文档为基准 */
  docKey?: string;
}

/** 当前选中节点概况 */
export interface MindmapSelectionInfo {
  /** 选中的节点 id（多选时为全部） */
  nodeIds: readonly string[];
  /** 是否包含中心主题 */
  includesRoot: boolean;
}

/** 顶部操作栏调用的画布命令 */
export interface MindmapRendererHandle {
  addSummary: () => void;
  addBoundary: () => void;
  startConnect: () => void;
  /** 整图或中心主题移到画面中央（沉浸阅读切换后视口尺寸变化时使用） */
  centerContent: () => void;
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
  /** 实际搬移的节点：按住多选中的节点拖动时为多选的顶层节点，否则只有源节点 */
  sourceIds?: string[];
}

/** 仅保留最后一个指针采样，避免高频移动事件反复扫描导图和刷新预览。 */
interface DragPoint {
  pointerId: number;
  x: number;
  y: number;
}

/** 空 id 集合（多选 / 拖拽状态的初始值，保持引用稳定） */
const NO_IDS: readonly string[] = [];

/** 多选修饰键：Mac 用 Cmd（Ctrl + 单击是右键菜单），其余平台用 Ctrl */
function isMultiSelectModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return USES_COMMAND_KEY ? e.metaKey : e.ctrlKey;
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
  /** 附件（图片 / 文件链接）要求的最小宽度 */
  minWidth: number;
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

/** 首次显示整图居中后，中心主题与画布边缘至少保留的距离 */
const INITIAL_ROOT_MARGIN = 24;

/** 联系线颜色：未选中为次级文字色，选中为强调色 */
const RELATION_COLOR = 'var(--editor-text-secondary, #64748b)';
const ACCENT_COLOR = 'var(--editor-accent, #3b82f6)';

/** 外框图形：有阶梯形轮廓时画 path，否则画圆角矩形；其余 SVG 属性原样透传 */
function BoundaryShape({ boundary, ...props }: { boundary: LayoutBoundary } & React.SVGProps<SVGPathElement> & React.SVGProps<SVGRectElement>) {
  if (boundary.path) return <path d={boundary.path} {...(props as React.SVGProps<SVGPathElement>)} />;
  const { rect } = boundary;
  return <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={12} {...(props as React.SVGProps<SVGRectElement>)} />;
}

/** 结构元素是否为同一个 */
function isSameStructure(a: MindStructureRef | null, b: MindStructureRef | null): boolean {
  return Boolean(a && b && a.kind === b.kind && a.id === b.id && a.ownerId === b.ownerId);
}

/** 拖动联系线控制点的会话 */
interface ControlSession {
  pointerId: number;
  ownerId: string;
  id: string;
  /** 拖的是起点侧（0）还是终点侧（1）的控制点 */
  index: 0 | 1;
  /** 两个控制点相对两端节点中心的偏移（拖动开始时的值） */
  controls: [MindPoint, MindPoint];
  /** 被拖控制点所属端的节点中心 */
  center: MindPoint;
  moved: boolean;
}

/** 拖动概要 / 外框端点调整范围的会话 */
interface RangeSession {
  pointerId: number;
  ref: MindStructureRef;
  /** 不动的一端子节点 */
  fixedId: string;
  original: Pick<MindNodeRange, 'startId' | 'endId'>;
}

export const MindmapRenderer = forwardRef<MindmapRendererHandle, MindmapRendererProps>(function MindmapRenderer({
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
  onSelectionChange,
  diffMarks,
  docKey,
}, ref) {
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
  // 坐标立即累加，图层、缩略图和裁剪检查每帧只同步一次，避免触控板高频事件重复触发布局与绘制。
  const setPan = useCallback((next: React.SetStateAction<{ x: number; y: number }>) => {
    const value = typeof next === 'function' ? next(panRef.current) : next;
    panRef.current = value;
    if (panFrameRef.current === null) panFrameRef.current = requestAnimationFrame(() => {
      panFrameRef.current = null;
      const current = panRef.current;
      if (transformLayerRef.current) transformLayerRef.current.style.transform = `translate3d(${current.x}px, ${current.y}px, 0) scale(${zoomRef.current})`;
      minimapRef.current?.syncViewport();
      checkOffscreenRef.current();
      // 移动接近既有缓冲区边缘时才让 React 补绘，保留原有裁剪范围和坐标规则。
      const committed = committedPanRef.current;
      if (Math.max(Math.abs(current.x - committed.x), Math.abs(current.y - committed.y)) >= 128) commitPan(current);
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
      panFrameRef.current = null;
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
  // 最近一次触摸时间：用于忽略触屏点按后浏览器补发的兼容 mousedown，避免误入鼠标平移态
  const lastTouchAtRef = useRef(0);

  // 节点拖拽状态 (Pointer Events 丝滑整树拖拽)
  const dragSessionRef = useRef<DragSession | null>(null);
  const [isDraggingNode, setIsDraggingNode] = useState(false);
  // 正在被拖动的节点（多选拖动时为多个）
  const [draggedIds, setDraggedIds] = useState<readonly string[]>(NO_IDS);
  const [dragPreview, setDragPreview] = useState<{
    node: MindNode;
    descendantCount: number;
    /** 一起拖动的节点数（多选拖动时 > 1） */
    count: number;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);
  // 预览位置和实际落点用 ref 保存；只有预览内容、落点变化时才需要重绘节点。
  const dragPreviewElementRef = useRef<HTMLDivElement>(null);
  const dragPointRef = useRef<DragPoint>({ pointerId: 0, x: 0, y: 0 });
  const dropTargetRef = useRef<DropTargetState | null>(null);
  const dragMoveFrameRef = useRef<number | null>(null);
  const pendingDragPointRef = useRef<DragPoint | null>(null);
  const applyDragPointRef = useRef<(point: DragPoint) => void>(() => undefined);

  /** 消费最后一次移动；松手也同步调用，确保未到下一帧时仍按最新指针位置提交落点。 */
  const flushNodeDrag = useCallback(() => {
    if (dragMoveFrameRef.current !== null) cancelAnimationFrame(dragMoveFrameRef.current);
    dragMoveFrameRef.current = null;
    const point = pendingDragPointRef.current;
    pendingDragPointRef.current = null;
    if (point) applyDragPointRef.current(point);
  }, []);

  /** 结束或取消节点拖动时一并清除待绘帧，防止预览在松手、Esc 或捏合后重新出现。 */
  const resetNodeDrag = useCallback(() => {
    if (dragMoveFrameRef.current !== null) cancelAnimationFrame(dragMoveFrameRef.current);
    dragMoveFrameRef.current = null;
    pendingDragPointRef.current = null;
    dragSessionRef.current = null;
    dropTargetRef.current = null;
    setIsDraggingNode(false);
    setDraggedIds(NO_IDS);
    setDragPreview(null);
    setDropTarget(null);
    document.body.style.cursor = 'default';
  }, []);

  // 卸载时不再提交状态，只撤销本组件的待绘任务及拖动光标。
  useEffect(() => () => {
    if (dragMoveFrameRef.current !== null) cancelAnimationFrame(dragMoveFrameRef.current);
    if (dragSessionRef.current?.isDragging) document.body.style.cursor = 'default';
  }, []);

  // 正在就地编辑标题的节点与草稿（文本 + 富文本格式）
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<TextDraft>({ text: '' });
  // 标题编辑框句柄（格式菜单通过它对选区应用格式）与当前选区
  const titleEditorRef = useRef<MindmapTitleEditorHandle>(null);
  const [formatSelection, setFormatSelection] = useState<TitleSelectionInfo | null>(null);

  // 单个节点样式浮层（对齐 / 图片显示方式）
  const [nodeStylePopover, setNodeStylePopover] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  // 删除含子节点的节点前的二次确认
  const [deleteConfirm, setDeleteConfirm] = useState<{ nodeIds: readonly string[]; descendantCount: number } | null>(null);
  const deleteConfirmRef = useRef(deleteConfirm);
  deleteConfirmRef.current = deleteConfirm;

  // 正在编辑备注的节点
  const [editingNoteNodeId, setEditingNoteNodeId] = useState<string | null>(null);
  const [editNoteText, setEditNoteText] = useState('');

  // 选中的节点与悬浮工具栏状态：selectedNodeId 为主选中（工具栏挂在它上面），
  // multiSelectedIds 为 Ctrl / Cmd + 单击多选的全部节点（至少 2 个时才非空，含主选中）
  const [selectedNodeId, setPrimarySelectedId] = useState<string | null>(null);
  const [multiSelectedIds, setMultiSelectedIds] = useState<readonly string[]>(NO_IDS);
  // 选中的结构元素（概要 / 外框 / 联系线），与节点选中互斥
  const [selectedStructure, setSelectedStructure] = useState<MindStructureRef | null>(null);
  const selectedStructureRef = useRef(selectedStructure);
  selectedStructureRef.current = selectedStructure;
  // 正在编辑文字的结构元素与草稿
  const [editingStructure, setEditingStructure] = useState<{ ref: MindStructureRef; text: string } | null>(null);
  // 联系线连接模式：起点节点 + 指针当前位置（导图坐标）
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const connectFromRef = useRef(connectFrom);
  connectFromRef.current = connectFrom;
  const [connectPointer, setConnectPointer] = useState<{ x: number; y: number } | null>(null);
  // 拖动联系线控制点：会话 + 实时预览
  const controlSessionRef = useRef<ControlSession | null>(null);
  const [controlPreview, setControlPreview] = useState<{ id: string; controls: [MindPoint, MindPoint] } | null>(null);
  // 拖动概要 / 外框端点：会话 + 实时预览
  const rangeSessionRef = useRef<RangeSession | null>(null);
  const [rangePreview, setRangePreview] = useState<{ id: string; startId: string; endId: string } | null>(null);
  /** 单选（或取消选中）：同时退出多选，既有的单选入口都经由它 */
  const setSelectedNodeId = useCallback((id: string | null) => {
    setPrimarySelectedId(id);
    setMultiSelectedIds(NO_IDS);
    setSelectedStructure(null);
  }, []);
  /** 选中结构元素：取消节点选中 */
  const selectStructure = useCallback((ref: MindStructureRef | null) => {
    setPrimarySelectedId(null);
    setMultiSelectedIds(NO_IDS);
    setSelectedStructure(ref);
  }, []);
  const isMultiSelecting = multiSelectedIds.length > 1;

  // 图标选择器弹窗状态
  const [iconPickerState, setIconPickerState] = useState<{
    nodeId: string;
    currentIcon?: string;
    x: number;
    y: number;
  } | null>(null);

  // 图片大图预览：记录节点与图片序号，预览中可左右切换节点内的多张图片
  const [previewImage, setPreviewImage] = useState<{ nodeId: string; index: number } | null>(null);

  // 节点宽度拉伸：会话记录在 ref，实时预览宽度放在 state 参与排版
  const resizeSessionRef = useRef<ResizeSession | null>(null);
  const [resizePreview, setResizePreview] = useState<{ id: string; width: number } | null>(null);
  // 从折叠按钮上拖动调宽后，紧随松手的 click 不再触发折叠（记录截止时间）
  const suppressFoldClickUntilRef = useRef(0);

  // 按住 Ctrl / Cmd 时文件链接呈可点击态：直接写容器属性，不触发重渲染
  useEffect(() => {
    if (IS_MOBILE_UI) return;
    const sync = (e: KeyboardEvent | MouseEvent) => {
      const held = USES_COMMAND_KEY ? e.metaKey : e.ctrlKey;
      const el = containerRef.current;
      if (el && (el.dataset.linkMod === 'true') !== held) el.dataset.linkMod = String(held);
    };
    const clear = () => {
      if (containerRef.current) containerRef.current.dataset.linkMod = 'false';
    };
    window.addEventListener('keydown', sync, true);
    window.addEventListener('keyup', sync, true);
    // 在别处松开按键（如切换窗口）时，鼠标重新进入即可纠正状态
    window.addEventListener('mousemove', sync, { passive: true });
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', sync, true);
      window.removeEventListener('keyup', sync, true);
      window.removeEventListener('mousemove', sync);
      window.removeEventListener('blur', clear);
    };
  }, []);

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
  const multiSelectedIdsRef = useRef(multiSelectedIds);
  multiSelectedIdsRef.current = multiSelectedIds;
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

  // 概要 / 外框 / 联系线几何：排版之后按节点实际坐标计算，始终跟随节点位置
  const controlOverrides = useMemo(
    () => (controlPreview ? new Map([[controlPreview.id, controlPreview.controls]]) : undefined),
    [controlPreview],
  );
  const rangeOverrides = useMemo(
    () => (rangePreview ? new Map([[rangePreview.id, rangePreview]]) : undefined),
    [rangePreview],
  );
  const structures = useMemo(
    () => computeMindmapStructures(nodes, { measure: getSharedTextMeasurer(), fontFamily, controlOverrides, rangeOverrides }),
    // fontVersion 仅用于字体加载完成后强制重新测量
    [nodes, fontFamily, fontVersion, controlOverrides, rangeOverrides],
  );

  // 布局仍覆盖全部已展开节点，只有真正的节点和连线 DOM 按视口裁剪。
  const viewport = useMemo(() => getMindmapViewport(panRef.current, zoom, viewportSize.width, viewportSize.height), [pan, zoom, viewportSize]);
  // 多选集合（查找用）
  const multiSelectedSet = useMemo(() => new Set(multiSelectedIds), [multiSelectedIds]);
  const visibleNodes = useMemo(() => nodes.filter((node) =>
    isMindmapNodeVisible(node, viewport) ||
    multiSelectedSet.has(node.node.id) ||
    draggedIds.includes(node.node.id) ||
    [selectedNodeId, editingNodeId, editingNoteNodeId, resizePreview?.id].includes(node.node.id)),
  [nodes, viewport, multiSelectedSet, draggedIds, selectedNodeId, editingNodeId, editingNoteNodeId, resizePreview?.id]);
  const visibleLinks = useMemo(() => links.filter((link) => isMindmapLinkVisible(link, viewport)), [links, viewport]);
  // 拖动一次只生成一次后代集合（含被拖节点自身），落点扫描和节点样式不再对每个节点重复遍历整树。
  const draggedDescendantIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of draggedIds) {
      const source = findMindNode(root, id);
      if (source) for (const node of walkMindNodes(source)) ids.add(node.id);
    }
    return ids;
  }, [root, draggedIds]);

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
    // 概要文字、外框与联系线可能伸出节点范围
    const extra = structures.bounds;
    if (extra) {
      left = Math.min(left, extra.x);
      top = Math.min(top, extra.y);
      right = Math.max(right, extra.x + extra.width);
      bottom = Math.max(bottom, extra.y + extra.height);
    }
    return { left, top, width: right - left, height: bottom - top };
  }, [nodes, structures]);

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

  // 内容居中的目标平移：整图放得下（或指定 wholeContent）就居中整图，否则把中心主题移到画面中央
  const getContentCenterPan = (width: number, height: number, z: number, wholeContent = false) => {
    if (!contentBounds) return null;
    const fits = wholeContent || (contentBounds.width * z <= width && contentBounds.height * z <= height);
    const rootNode = nodes.find((n) => n.level === 0);
    const target = fits || !rootNode
      ? { x: contentBounds.left + contentBounds.width / 2, y: contentBounds.top + contentBounds.height / 2 }
      : { x: rootNode.x + rootNode.width / 2, y: rootNode.y + rootNode.height / 2 };
    return { x: width / 2 - target.x * z, y: height / 2 - target.y * z };
  };

  // 回到内容：缩放不变，只平移
  const handleScrollBackToContent = () => {
    const next = getContentCenterPan(viewportSize.width, viewportSize.height, zoomRef.current);
    if (next) setPan(next);
  };

  // 首次显示：首帧绘制前按画布实际尺寸居中，避免先停在默认偏移再跳到中央。
  // 画布尚未布局（尺寸为 0，如隐藏的保活宿主）时等尺寸测得后再居中；
  // 用户还没移动过视图时，恢复的缩放比例生效后也重新居中
  const autoCenterRef = useRef<{ pan: { x: number; y: number }; zoom: number } | null>(null);
  useLayoutEffect(() => {
    const auto = autoCenterRef.current;
    if (auto && (panRef.current !== auto.pan || auto.zoom === zoom)) return;
    const container = containerRef.current;
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return;
    // 首次显示以整图居中为准，一屏放不下时也不改成以中心主题居中
    const next = getContentCenterPan(container.clientWidth, container.clientHeight, zoom, true);
    if (!next) return;
    // 但中心主题必须完整可见：超出画面时只平移到刚好露出（留边距）
    const rootNode = nodes.find((n) => n.level === 0);
    if (rootNode) {
      const keepVisible = (offset: number, start: number, length: number, viewLength: number) => {
        const size = length * zoom;
        // 画面放不下边距时边距收窄，主题比画面还大时贴齐起始边
        const margin = Math.min(INITIAL_ROOT_MARGIN, Math.max(0, (viewLength - size) / 2));
        const screenStart = offset + start * zoom;
        if (screenStart < margin) return offset + margin - screenStart;
        const overflow = screenStart + size - (viewLength - margin);
        return overflow > 0 ? offset - Math.min(overflow, screenStart - margin) : offset;
      };
      next.x = keepVisible(next.x, rootNode.x, rootNode.width, container.clientWidth);
      next.y = keepVisible(next.y, rootNode.y, rootNode.height, container.clientHeight);
    }
    autoCenterRef.current = { pan: next, zoom };
    // 同步提交而非走逐帧合并，保证首帧就是居中后的位置
    panRef.current = next;
    commitPan(next);
  }, [contentBounds, viewportSize, zoom]);

  // 画布容器虽是 overflow:hidden，编辑节点时浏览器仍会滚动它把光标露出来，
  // 导致缩略图等绝对定位控件整体上移；视图位置只由 pan 决定，滚动一律复位
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
  // 异步操作（文件选择对话框、读取图片）结束时导图可能已变化，需基于最新的树修改
  const rootRef = useRef(root);
  rootRef.current = root;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const updateLatestTree = useCallback((mutator: (clonedRoot: MindNode) => void) => {
    const cloned = cloneMindmapTree(rootRef.current);
    mutator(cloned);
    onChangeRef.current(cloned);
  }, []);

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

  /**
   * 删除节点（可多个，一次树更新即一个撤销步），随后选中第一个被删节点的父节点，便于连续操作
   * @param ids 顶层节点 id（由 getTopLevelMindNodeIds 过滤，不含根节点）
   */
  const deleteNodesAndSelectParent = (ids: readonly string[]) => {
    if (ids.length === 0) return;
    const parent = findParentNode(root, ids[0]);
    updateTree((cloned) => {
      for (const id of ids) {
        const parentInfo = findMindNodeParent(cloned, id);
        if (parentInfo) parentInfo.parent.children.splice(parentInfo.index, 1);
      }
    });
    setSelectedNodeId(parent?.id ?? null);
  };

  /**
   * 请求删除节点（单个或多选）：含子节点时先弹二次确认
   */
  const requestDeleteNodes = (ids: readonly string[]) => {
    const topIds = getTopLevelMindNodeIds(root, ids);
    if (topIds.length === 0) return;
    let descendantCount = 0;
    for (const id of topIds) {
      const target = findNodeById(root, id);
      if (target) descendantCount += countSubtreeDescendants(target);
    }
    if (descendantCount > 0) {
      setDeleteConfirm({ nodeIds: topIds, descendantCount });
      return;
    }
    deleteNodesAndSelectParent(topIds);
  };
  const requestDeleteNodesRef = useRef(requestDeleteNodes);
  requestDeleteNodesRef.current = requestDeleteNodes;

  /**
   * 操作目标：节点属于当前多选时作用于全部多选节点，否则只作用于该节点
   * （工具栏只挂在主选中节点上，多选时它的按钮即为批量操作）
   */
  const getActionTargetIds = (id: string): readonly string[] =>
    isMultiSelecting && multiSelectedSet.has(id) ? multiSelectedIds : [id];

  /** Ctrl / Cmd + 单击：切换节点是否在多选中（根节点不参与），只剩一个时退回单选 */
  const toggleMultiSelect = (id: string) => {
    if (id === root.id) return;
    const base = isMultiSelecting
      ? multiSelectedIds
      : selectedNodeId && selectedNodeId !== root.id
        ? [selectedNodeId]
        : NO_IDS;
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    if (next.length <= 1) {
      setSelectedNodeId(next[0] ?? null);
      return;
    }
    // 新加入的节点成为主选中；移出的恰是主选中时改由最后一个接替
    const primary = next.includes(id) ? id : selectedNodeId && next.includes(selectedNodeId) ? selectedNodeId : next[next.length - 1];
    setPrimarySelectedId(primary);
    setMultiSelectedIds(next);
    setSelectedStructure(null);
  };

  /** Shift + 单击：与当前选中节点同级时，连选两者之间的全部同级节点；否则按多选切换处理 */
  const selectSiblingRange = (id: string) => {
    const anchorId = selectedNodeId;
    const anchor = anchorId ? findMindNodeParent(root, anchorId) : null;
    const target = findMindNodeParent(root, id);
    if (!anchor || !target || anchor.parent !== target.parent || anchorId === id) {
      toggleMultiSelect(id);
      return;
    }
    const [from, to] = anchor.index <= target.index ? [anchor.index, target.index] : [target.index, anchor.index];
    const ids = anchor.parent.children.slice(from, to + 1).map((child) => child.id);
    // 锚点保持为主选中，便于继续 Shift 调整范围
    setPrimarySelectedId(anchorId);
    setMultiSelectedIds(ids);
    setSelectedStructure(null);
  };

  /** 当前选中的节点（多选时为全部，否则为单选节点） */
  const currentSelectionIds = (): readonly string[] =>
    isMultiSelecting ? multiSelectedIds : selectedNodeId ? [selectedNodeId] : NO_IDS;

  // ── 概要 / 外框 / 联系线 ──

  /** 为选中节点添加概要或外框（多选时覆盖首尾之间的全部同层节点，可跨父节点），随后选中新元素 */
  const addRangeStructure = (kind: 'summary' | 'boundary', ids: readonly string[]) => {
    const range = getSiblingRangeForSelection(root, ids);
    if (!range.ok) {
      showToast(range.reason, 'error');
      return;
    }
    const id = generateStructureId(kind);
    updateTree((cloned) => {
      updateNodeById(cloned, range.parentId, (parent) => {
        if (kind === 'summary') {
          (parent.summaries ??= []).push({ id, startId: range.startId, endId: range.endId, text: SUMMARY_PLACEHOLDER });
        } else {
          (parent.boundaries ??= []).push({ id, startId: range.startId, endId: range.endId });
        }
        // 范围内节点必须展开显示，否则新元素看不到
        parent.isExpanded = true;
      });
    });
    const ref: MindStructureRef = { kind, ownerId: range.parentId, id };
    selectStructure(ref);
    // 新概要直接进入文字编辑，便于立即输入
    if (kind === 'summary') setEditingStructure({ ref, text: SUMMARY_PLACEHOLDER });
  };

  /** 进入联系线连接模式：随后点击目标节点完成连接 */
  const startConnect = (fromId: string) => {
    setSelectedNodeId(null);
    setConnectFrom(fromId);
    setConnectPointer(null);
  };

  const cancelConnect = () => {
    setConnectFrom(null);
    setConnectPointer(null);
  };

  /** 点击目标节点完成连线；已存在同向联系线时直接选中它 */
  const finishConnect = (targetId: string) => {
    const fromId = connectFromRef.current;
    cancelConnect();
    if (!fromId || fromId === targetId) return;
    const existing = findNodeById(root, fromId)?.relations?.find((relation) => relation.targetId === targetId);
    if (existing) {
      selectStructure({ kind: 'relation', ownerId: fromId, id: existing.id });
      return;
    }
    const id = generateStructureId('relation');
    updateTree((cloned) => {
      updateNodeById(cloned, fromId, (node) => {
        (node.relations ??= []).push({ id, targetId });
      });
    });
    selectStructure({ kind: 'relation', ownerId: fromId, id });
  };

  /** 删除结构元素（一个撤销步） */
  const deleteStructure = (ref: MindStructureRef) => {
    updateTree((cloned) => {
      const owner = findMindNode(cloned, ref.ownerId);
      if (owner) removeStructure(owner, ref);
    });
    setSelectedStructure(null);
    setEditingStructure(null);
  };
  const deleteStructureRef = useRef(deleteStructure);
  deleteStructureRef.current = deleteStructure;

  /** 开始编辑结构元素文字 */
  const beginEditStructure = (ref: MindStructureRef) => {
    const item = findStructure(findNodeById(root, ref.ownerId), ref);
    if (!item) return;
    selectStructure(ref);
    setEditingStructure({ ref, text: getStructureText(item, ref.kind) });
  };
  const beginEditStructureRef = useRef(beginEditStructure);
  beginEditStructureRef.current = beginEditStructure;

  /** 提交结构元素文字；未改动时不产生撤销步 */
  const commitStructureEdit = () => {
    const editing = editingStructure;
    if (!editing) return;
    setEditingStructure(null);
    const { ref } = editing;
    const item = findStructure(findNodeById(root, ref.ownerId), ref);
    const text = editing.text.trim();
    if (!item || text === getStructureText(item, ref.kind)) return;
    updateTree((cloned) => {
      const owner = findMindNode(cloned, ref.ownerId);
      if (owner) setStructureText(owner, ref, text);
    });
  };

  /** 屏幕坐标换算为导图坐标 */
  const clientToWorld = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: (clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - panRef.current.y) / zoomRef.current,
    };
  };

  /** 捕获指针（拖动手柄期间指针移出手柄也持续收到事件） */
  const capturePointer = (e: React.PointerEvent<HTMLElement>) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const releasePointer = (e: React.PointerEvent<HTMLElement>) => {
    e.stopPropagation();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  // 拖动联系线控制点：控制点直接跟随指针，曲线从节点朝控制点的一侧出线；松手一次写入（一个撤销步）
  const handleControlPointerDown = (e: React.PointerEvent<HTMLElement>, relation: (typeof structures.relations)[number], index: 0 | 1) => {
    if (e.button !== 0) return;
    capturePointer(e);
    controlSessionRef.current = {
      pointerId: e.pointerId,
      ownerId: relation.ownerId,
      id: relation.id,
      index,
      controls: [
        { x: relation.cp1.x - relation.c1.x, y: relation.cp1.y - relation.c1.y },
        { x: relation.cp2.x - relation.c2.x, y: relation.cp2.y - relation.c2.y },
      ],
      center: index === 0 ? relation.c1 : relation.c2,
      moved: false,
    };
  };

  const handleControlPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const session = controlSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const point = clientToWorld(e.clientX, e.clientY);
    if (!point) return;
    session.moved = true;
    const controls: [MindPoint, MindPoint] = [...session.controls];
    controls[session.index] = { x: Math.round(point.x - session.center.x), y: Math.round(point.y - session.center.y) };
    session.controls = controls;
    setControlPreview({ id: session.id, controls });
  };

  const handleControlPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const session = controlSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    releasePointer(e);
    controlSessionRef.current = null;
    setControlPreview(null);
    if (!session.moved) return;
    updateTree((cloned) => {
      const relation = findMindNode(cloned, session.ownerId)?.relations?.find((item) => item.id === session.id);
      if (!relation) return;
      relation.controls = session.controls;
      delete relation.bend;
    });
  };

  /** 恢复联系线自动走线 */
  const resetRelationShape = (ref: MindStructureRef) => {
    updateTree((cloned) => {
      const relation = findMindNode(cloned, ref.ownerId)?.relations?.find((item) => item.id === ref.id);
      if (!relation) return;
      delete relation.controls;
      delete relation.bend;
    });
  };

  // 拖动概要 / 外框端点：沿同级排列方向扩大或缩小覆盖的节点
  const handleRangePointerDown = (e: React.PointerEvent<HTMLElement>, structureRef: MindStructureRef, handle: MindPoint) => {
    if (e.button !== 0) return;
    const owner = nodes.find((n) => n.node.id === structureRef.ownerId);
    const item = findStructure(owner?.node ?? null, structureRef) as MindNodeRange | null;
    if (!owner || !item) return;
    capturePointer(e);
    rangeSessionRef.current = {
      pointerId: e.pointerId,
      ref: structureRef,
      fixedId: rangeFixedEndId(owner, item, handle),
      original: { startId: item.startId, endId: item.endId },
    };
  };

  const handleRangePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const session = rangeSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const point = clientToWorld(e.clientX, e.clientY);
    const owner = nodes.find((n) => n.node.id === session.ref.ownerId);
    if (!point || !owner) return;
    const next = dragRangeEnd(owner, session.fixedId, point);
    // 只在范围真正变化时更新预览，避免每帧重算
    if (next && (next.startId !== rangePreview?.startId || next.endId !== rangePreview?.endId)) {
      setRangePreview({ id: session.ref.id, ...next });
    }
  };

  const handleRangePointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const session = rangeSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    releasePointer(e);
    rangeSessionRef.current = null;
    const preview = rangePreview;
    setRangePreview(null);
    if (!preview || (preview.startId === session.original.startId && preview.endId === session.original.endId)) return;
    updateTree((cloned) => {
      const item = findStructure(findMindNode(cloned, session.ref.ownerId), session.ref) as MindNodeRange | null;
      if (!item) return;
      item.startId = preview.startId;
      item.endId = preview.endId;
    });
  };

  // 顶部操作栏命令：作用于当前选中的节点（闭包每次渲染更新，句柄经 ref 读取最新版本）
  const commandsRef = useRef<MindmapRendererHandle | null>(null);
  commandsRef.current = {
    addSummary: () => addRangeStructure('summary', currentSelectionIds()),
    addBoundary: () => addRangeStructure('boundary', currentSelectionIds()),
    startConnect: () => {
      const ids = currentSelectionIds();
      if (ids.length === 1) startConnect(ids[0]);
    },
    centerContent: handleScrollBackToContent,
  };
  useImperativeHandle(ref, () => ({
    addSummary: () => commandsRef.current?.addSummary(),
    addBoundary: () => commandsRef.current?.addBoundary(),
    startConnect: () => commandsRef.current?.startConnect(),
    centerContent: () => commandsRef.current?.centerContent(),
  }), []);

  // 选中变化通知顶部操作栏
  useEffect(() => {
    const nodeIds = isMultiSelecting ? multiSelectedIds : selectedNodeId ? [selectedNodeId] : NO_IDS;
    onSelectionChange?.({ nodeIds, includesRoot: nodeIds.includes(root.id) });
  }, [selectedNodeId, multiSelectedIds, isMultiSelecting, root.id, onSelectionChange]);

  /** 结构元素工具栏锚点（导图坐标，工具栏显示在其正上方） */
  const getStructureAnchor = (ref: MindStructureRef): { x: number; y: number } | null => {
    if (ref.kind === 'summary') {
      const s = structures.summaries.find((item) => item.id === ref.id && item.ownerId === ref.ownerId);
      return s ? { x: s.label.x + s.label.width / 2, y: s.label.y } : null;
    }
    if (ref.kind === 'boundary') {
      const b = structures.boundaries.find((item) => item.id === ref.id && item.ownerId === ref.ownerId);
      return b ? { x: b.rect.x + b.rect.width / 2, y: b.rect.y } : null;
    }
    const r = structures.relations.find((item) => item.id === ref.id && item.ownerId === ref.ownerId);
    return r ? { x: r.mid.x, y: r.labelBox ? r.labelBox.y - 4 : r.mid.y - 8 } : null;
  };

  /** 结构元素文字输入框位置（导图坐标） */
  const getStructureEditBox = (ref: MindStructureRef): { x: number; y: number; width: number } | null => {
    if (ref.kind === 'summary') {
      const s = structures.summaries.find((item) => item.id === ref.id && item.ownerId === ref.ownerId);
      return s ? { x: s.label.x, y: s.label.y + s.label.height / 2 - 13, width: Math.max(140, s.label.width) } : null;
    }
    if (ref.kind === 'boundary') {
      const b = structures.boundaries.find((item) => item.id === ref.id && item.ownerId === ref.ownerId);
      return b ? { x: b.titleAnchor.x, y: b.titleAnchor.y - 13, width: Math.max(160, b.titleBox?.width ?? 0) } : null;
    }
    const r = structures.relations.find((item) => item.id === ref.id && item.ownerId === ref.ownerId);
    return r ? { x: r.mid.x - 80, y: r.mid.y - 13, width: 160 } : null;
  };

  /** 设置节点的对齐 / 图片显示方式（可多个，一次撤销步）；传 undefined 表示恢复跟随设置 */
  const setNodeStyleField = (ids: readonly string[], field: 'textAlign' | 'imageFit', value: string | undefined) => {
    updateTree((cloned) => {
      for (const id of ids) {
        updateNodeById(cloned, id, (node) => {
          if (value === undefined) delete node[field];
          else (node as unknown as Record<string, unknown>)[field] = value;
        });
      }
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
  const handleIconChange = (ids: readonly string[], icon?: string) => {
    updateTree((cloned) => {
      // 多选时批量设置，一次树更新即一个撤销步
      for (const id of ids) {
        updateNodeById(cloned, id, (node) => {
          node.icon = icon;
        });
      }
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

  // 上传图片（可多选，追加到节点已有图片之后）
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const targetNodeId = uploadTargetNodeIdRef.current;
    e.target.value = '';
    if (files.length === 0 || !targetNodeId) return;
    addNodeImagesFromFiles(targetNodeId, files);
  };

  /** 读取图片文件并追加为节点图片（文件选择与编辑时粘贴共用），超出 10 张的部分忽略并提示 */
  const addNodeImagesFromFiles = (targetNodeId: string, files: readonly File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    void Promise.all(imageFiles.map((file) => new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    }))).then((results) => {
      const sources = results.filter((src): src is string => Boolean(src));
      if (sources.length === 0) return;
      let dropped = 0;
      updateLatestTree((cloned) => {
        updateNodeById(cloned, targetNodeId, (node) => {
          const result = appendWithLimit(node.images, sources, MAX_NODE_IMAGES);
          node.images = result.next;
          dropped = result.dropped;
        });
      });
      if (dropped > 0) showToast(`每个节点最多 ${MAX_NODE_IMAGES} 张图片，已忽略 ${dropped} 张`, 'warning');
    });
  };

  // 删除节点中的某张图片
  const handleDeleteImage = (id: string, index: number) => {
    updateTree((cloned) => {
      updateNodeById(cloned, id, (node) => {
        const next = (node.images ?? []).filter((_, i) => i !== index);
        if (next.length > 0) node.images = next;
        else delete node.images;
      });
    });
  };

  /** 选择本地文件并追加为节点文件链接（同一路径不重复添加） */
  const handleAddFileLinks = async (id: string) => {
    const target = findNodeById(rootRef.current, id);
    if (target && getNodeFiles(target).length >= MAX_NODE_FILES) {
      showToast(`每个节点最多链接 ${MAX_NODE_FILES} 个文件`, 'warning');
      return;
    }
    const links = await pickFileLinks(docKey);
    if (links.length === 0) return;
    let dropped = 0;
    updateLatestTree((cloned) => {
      updateNodeById(cloned, id, (node) => {
        const result = appendWithLimit(node.files, links, MAX_NODE_FILES, true);
        node.files = result.next;
        dropped = result.dropped;
      });
    });
    if (dropped > 0) showToast(`每个节点最多链接 ${MAX_NODE_FILES} 个文件，已忽略 ${dropped} 个`, 'warning');
  };

  // 移除节点中的某个文件链接
  const handleRemoveFileLink = (id: string, index: number) => {
    updateTree((cloned) => {
      updateNodeById(cloned, id, (node) => {
        const next = (node.files ?? []).filter((_, i) => i !== index);
        if (next.length > 0) node.files = next;
        else delete node.files;
      });
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

  const handleResizePointerDown = (e: React.PointerEvent<HTMLElement>, layoutNode: LayoutNode) => {
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
      minWidth: attachmentMinWidth(layoutNode.node),
      moved: false,
    };
    document.body.style.cursor = 'ew-resize';
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const session = resizeSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    e.stopPropagation();
    // 屏幕位移换算到导图坐标，左侧手柄向左拉为变宽
    const delta = ((e.clientX - session.startX) / zoom) * (session.edge === 'right' ? 1 : -1);
    if (!session.moved && Math.abs(delta) < 1) return;
    session.moved = true;
    setResizePreview({
      id: session.nodeId,
      width: clampManualWidth(session.startWidth + delta, session.minWidth),
    });
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLElement>) => {
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
    if (session.moved) suppressFoldClickUntilRef.current = Date.now() + 300;
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
      target.closest('[data-mindmap-file]') ||
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

  // 触屏双指捏合（捕获阶段）：手柄捕获指针后会阻止 move 冒泡，必须在捕获阶段更新触点，
  // 否则一指按在概要端点 / 控制点上时捏合只能读到另一指的坐标
  const handleTouchPointerMoveCapture = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch' || !touchPointsRef.current.has(e.pointerId)) return;
    touchPointsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pinch = pinchRef.current;
    const containerEl = containerRef.current;
    if (!pinch || !containerEl || touchPointsRef.current.size < 2) return;
    // 捏合期间的移动只用于缩放，不再交给节点拖拽、手柄或画布平移
    e.stopPropagation();
    // 按两指距离比例缩放，并让捏合中心跟随手指移动
    const [p1, p2] = Array.from(touchPointsRef.current.values());
    const rect = containerEl.getBoundingClientRect();
    const dist = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
    const midX = (p1.x + p2.x) / 2 - rect.left;
    const midY = (p1.y + p2.y) / 2 - rect.top;
    const nextZoom = Math.min(3, Math.max(0.2, pinch.startZoom * (dist / pinch.startDist)));
    setPan({ x: midX - pinch.worldX * nextZoom, y: midY - pinch.worldY * nextZoom });
    onZoomChange(nextZoom);
  };

  // 全局指针移动：处理拖拽中位移计算与最近有效落点判定，或画布平移
  const handlePointerMove = (e: React.PointerEvent) => {
    // 连接模式：预览线跟随指针
    if (connectFromRef.current) {
      const point = clientToWorld(e.clientX, e.clientY);
      if (point) setConnectPointer(point);
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

    if (e.pointerId !== session.pointerId) return;
    pendingDragPointRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    if (dragMoveFrameRef.current === null) dragMoveFrameRef.current = requestAnimationFrame(flushNodeDrag);
  };

  /** 按显示帧移动预览并判定落点；相同落点不触发 React 重绘，树结构仍只在松手时提交。 */
  applyDragPointRef.current = (point) => {
    const session = dragSessionRef.current;
    if (!session || point.pointerId !== session.pointerId) return;
    const deltaX = Math.abs(point.x - session.startX);
    const deltaY = Math.abs(point.y - session.startY);

    // 位移超过 4px 正式激活拖拽状态
    if (!session.isDragging) {
      if (deltaX > 4 || deltaY > 4) {
        session.isDragging = true;
        // 按住多选中的节点拖动：多选的顶层节点一起搬移
        const multi = multiSelectedIdsRef.current;
        session.sourceIds =
          multi.length > 1 && multi.includes(session.sourceNode.id)
            ? getTopLevelMindNodeIds(root, multi)
            : [session.sourceNode.id];
        setIsDraggingNode(true);
        setDraggedIds(session.sourceIds);
        document.body.style.cursor = 'grabbing';
      } else {
        return;
      }
    }

    // 更新跟随光标的半透明悬浮卡片
    const sourceIds = session.sourceIds ?? [session.sourceNode.id];
    if (!session.descendantIds) {
      // 全部被拖子树的并集：落点不能落在其中任何一处（防止成环）
      const ids = new Set<string>();
      for (const id of sourceIds) {
        const source = id === session.sourceNode.id ? session.sourceNode : findMindNode(root, id);
        if (source) for (const node of walkMindNodes(source)) ids.add(node.id);
      }
      session.descendantIds = ids;
    }
    dragPointRef.current = point;
    const preview = dragPreviewElementRef.current;
    if (preview) {
      preview.style.transform = `translate3d(${point.x + 14}px, ${point.y + 14}px, 0) scale(1.04)`;
    } else {
      // 卡片内容在同一次拖动中不变，首次挂载后只移动合成层。
      setDragPreview({ node: session.sourceNode, descendantCount: session.descendantIds.size - sourceIds.length, count: sourceIds.length });
    }

    // 屏幕视口坐标转导图世界坐标系
    const containerEl = containerRef.current;
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const worldX = (point.x - rect.left - panRef.current.x) / zoomRef.current;
    const worldY = (point.y - rect.top - panRef.current.y) / zoomRef.current;

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

    const previous = dropTargetRef.current;
    dropTargetRef.current = closest;
    if (previous?.targetId !== closest?.targetId || previous?.pos !== closest?.pos || previous?.targetLayout !== closest?.targetLayout) {
      setDropTarget(closest);
    }
  };

  // 全局指针释放：提交树结构变更或重置状态
  const handlePointerUp = (e: React.PointerEvent) => {
    if (isPanning) {
      setIsPanning(false);
    }

    const session = dragSessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;

    // 最后一个 pointermove 可能尚在等待绘制；pointerup 的坐标作为最终落点采样。
    pendingDragPointRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    flushNodeDrag();

    try {
      const el = e.currentTarget as HTMLElement;
      if (el && el.hasPointerCapture && el.hasPointerCapture(session.pointerId)) {
        el.releasePointerCapture(session.pointerId);
      }
    } catch {
      // ignore
    }

    const currentDropTarget = dropTargetRef.current;
    const sourceId = session.sourceNode.id;
    const sourceIds = session.sourceIds ?? [sourceId];
    const wasDragging = session.isDragging;

    resetNodeDrag();

    // 若处于真实拖拽态且存在有效落点，执行整树转移
    if (wasDragging && currentDropTarget) {
      updateTree((cloned) => {
        const nextRoot = moveMindNodes(
          cloned,
          sourceIds,
          currentDropTarget.targetId,
          currentDropTarget.pos,
        );
        // 整体替换根节点字段，避免新增字段（格式、宽度等）在搬移后丢失
        for (const key of Object.keys(cloned)) delete (cloned as unknown as Record<string, unknown>)[key];
        Object.assign(cloned, nextRoot);
      });
      // 多选拖动后保持多选，单个拖动后选中被拖节点
      if (sourceIds.length <= 1) setSelectedNodeId(sourceId);
    }
  };

  /** 中止概要 / 外框端点、联系线控制点、节点宽度手柄的拖动会话（不提交，丢弃预览） */
  const abortHandleSessions = () => {
    const hadSession = Boolean(rangeSessionRef.current || controlSessionRef.current || resizeSessionRef.current);
    rangeSessionRef.current = null;
    controlSessionRef.current = null;
    resizeSessionRef.current = null;
    if (!hadSession) return;
    setRangePreview(null);
    setControlPreview(null);
    setResizePreview(null);
    document.body.style.cursor = 'default';
  };

  // 触屏按下（捕获阶段，节点自身的 pointerdown 会阻止冒泡）：单指空白处平移，第二指落下进入捏合
  const handleTouchPointerDownCapture = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    // 经 Portal 渲染的浮层（图片预览等）在 React 树上仍是画布子孙，其触点不属于画布手势
    if (!containerRef.current?.contains(e.target as Node)) return;
    lastTouchAtRef.current = Date.now();
    // 主触点按下意味着此前所有手指都已抬起：清掉可能残留的旧触点，避免把幽灵触点算进捏合
    if (e.isPrimary && touchPointsRef.current.size > 0) {
      touchPointsRef.current.clear();
      pinchRef.current = null;
    }
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
      if (
        !target.closest('.nb-mindmap-node') &&
        !target.closest('[data-mindmap-structure]') &&
        !target.closest('[data-mindmap-overlay]') &&
        !target.closest('button, input, textarea')
      ) {
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
    setIsPanning(false);
    if (dragSessionRef.current) {
      resetNodeDrag();
    }
    // 第一指按在手柄上时同样让位给捏合
    abortHandleSessions();
    // 后落下的手指只参与捏合，不再让节点 / 手柄开启新的拖动会话
    e.stopPropagation();
  };

  // 触点抬起 / 被系统取消：移出触点表；捏合结束后若仍剩一指，则从该指位置无缝续接平移
  const handleTouchPointerEnd = (e: { pointerType: string; pointerId: number }) => {
    if (e.pointerType !== 'touch' || !touchPointsRef.current.has(e.pointerId)) return;
    lastTouchAtRef.current = Date.now();
    touchPointsRef.current.delete(e.pointerId);
    if (pinchRef.current && touchPointsRef.current.size < 2) {
      pinchRef.current = null;
      const rest = Array.from(touchPointsRef.current.values())[0];
      if (rest) {
        setIsPanning(true);
        panStartRef.current = { x: rest.x - panRef.current.x, y: rest.y - panRef.current.y };
      }
    }
  };
  const handleTouchPointerEndRef = useRef(handleTouchPointerEnd);
  handleTouchPointerEndRef.current = handleTouchPointerEnd;

  // 触点抬起改在 window 捕获阶段统一登记：概要端点、控制点、宽度手柄在 pointerup 时会阻止冒泡，
  // 画布自身的 onPointerUp 收不到，触点表里会残留"幽灵手指"，导致之后双指捏合失效
  useEffect(() => {
    const handleEnd = (e: PointerEvent) => handleTouchPointerEndRef.current(e);
    window.addEventListener('pointerup', handleEnd, true);
    window.addEventListener('pointercancel', handleEnd, true);
    return () => {
      window.removeEventListener('pointerup', handleEnd, true);
      window.removeEventListener('pointercancel', handleEnd, true);
    };
  }, []);

  // 画布鼠标按下平移
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.nb-mindmap-node')) return;
    // 概要 / 外框 / 联系线自行处理点选，不进入画布平移
    if ((e.target as Element).closest('[data-mindmap-structure]')) return;
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
      // Esc 退出联系线连接模式
      if (e.key === 'Escape' && connectFromRef.current) {
        setConnectFrom(null);
        setConnectPointer(null);
      }
      if (e.key === 'Escape' && dragSessionRef.current) {
        resetNodeDrag();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [resetNodeDrag]);

  // 选中节点后：Tab 新增子节点，Enter 新增同级节点（两者均把光标移到新节点）
  useEffect(() => {
    const handleShortcut = (e: KeyboardEvent) => {
      // 已由编辑框处理或用于输入法上屏的按键不能创建节点；长按 Enter 也不能越过刚结束的编辑态。
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || (e.key === 'Enter' && e.repeat)) return;
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

      // 选中概要 / 外框 / 联系线：Delete 删除，Enter 编辑文字，Esc 取消选中
      const structure = selectedStructureRef.current;
      if (structure) {
        if (e.key === 'Delete' || (USES_COMMAND_KEY && e.key === 'Backspace')) {
          const container = containerRef.current;
          if (el && el !== document.body && container && !container.contains(el) && !el.contains(container)) return;
          e.preventDefault();
          deleteStructureRef.current(structure);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          beginEditStructureRef.current(structure);
        } else if (e.key === 'Escape') {
          setSelectedStructure(null);
        }
        return;
      }

      const selected = selectedNodeIdRef.current;
      if (!selected) return;
      const multi = multiSelectedIdsRef.current;

      // Mac 键盘的 delete 键对应 Backspace，同样用于删除节点（多选时批量删除）
      if (e.key === 'Delete' || (USES_COMMAND_KEY && e.key === 'Backspace')) {
        // 焦点在画布之外（如文件树、其他面板）时不响应，避免误删节点
        const container = containerRef.current;
        if (el && el !== document.body && container && !container.contains(el) && !el.contains(container)) return;
        e.preventDefault();
        requestDeleteNodesRef.current(multi.length > 1 ? multi : [selected]);
      } else if (e.key === 'Escape' && multi.length > 1) {
        // Esc 退出多选，保留主选中节点
        setSelectedNodeId(selected);
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
      // 触屏界面没有修饰键，文件链接始终呈可点按的链接态
      className={IS_MOBILE_UI ? 'nb-touch-links' : undefined}
      onMouseDown={handleMouseDown}
      onPointerDownCapture={handleTouchPointerDownCapture}
      onPointerMoveCapture={handleTouchPointerMoveCapture}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        // 系统取消触点（如来电、手势被接管）：只复位状态，不提交拖拽落点（触点表由 window 监听移除）
        setIsPanning(false);
        if (dragSessionRef.current) {
          resetNodeDrag();
        }
      }}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
        cursor: isDraggingNode ? 'grabbing' : isPanning ? 'grabbing' : connectFrom ? 'crosshair' : 'default',
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
        multiple
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />

      {/* 缩放与平移图层 */}
      <div
        ref={transformLayerRef}
        className="nb-mindmap-transform"
        style={{
          position: 'absolute',
          // 统一用合成层平移；连续输入不叠加过渡插值，避免触控板平移时出现拖尾。
          transform: `translate3d(${panRef.current.x}px, ${panRef.current.y}px, 0) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {/* SVG 贝塞尔曲线连接线图层 */}
        <svg
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            // 图形使用绝对坐标并允许溢出，无需为连线保留 8000² 的空白绘制表面。
            width: 1,
            height: 1,
            pointerEvents: 'none',
            overflow: 'visible',
          }}
        >
          {/* 外框：浅色底 + 虚线边，位于连线与节点之下；只有边线可点选，框内空白仍可拖动画布 */}
          {structures.boundaries.map((b) => {
            const ref: MindStructureRef = { kind: 'boundary', ownerId: b.ownerId, id: b.id };
            const selected = isSameStructure(selectedStructure, ref);
            const color = theme.branchColors[b.branchIndex % theme.branchColors.length] ?? theme.branchColors[0];
            return (
              <g key={`boundary-${b.id}`} className="nb-mindmap-boundary" data-selected={selected}>
                {/* 跨父范围画阶梯形轮廓，同父范围仍为圆角矩形 */}
                <BoundaryShape
                  boundary={b}
                  className="nb-mindmap-boundary-frame"
                  fill={color}
                  fillOpacity={0.06}
                  stroke={selected ? ACCENT_COLOR : color}
                  strokeWidth={selected ? 2 : 1.5}
                  strokeDasharray="6 4"
                  strokeOpacity={selected ? 1 : 0.75}
                />
                <BoundaryShape
                  boundary={b}
                  data-mindmap-structure
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectStructure(ref);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    beginEditStructure(ref);
                  }}
                />
              </g>
            );
          })}
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
          {/* 概要大括号：开口朝向被概括的节点 */}
          {structures.summaries.map((s) => {
            const selected = isSameStructure(selectedStructure, { kind: 'summary', ownerId: s.ownerId, id: s.id });
            const color = theme.branchColors[s.branchIndex % theme.branchColors.length] ?? theme.branchColors[0];
            return (
              <path
                key={`summary-brace-${s.id}`}
                d={s.bracePath}
                fill="none"
                stroke={selected ? ACCENT_COLOR : color}
                strokeWidth={selected ? 2.2 : 1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={selected ? 1 : theme.edgeOpacity}
              />
            );
          })}
        </svg>

        {/* 外框标题与概要文字（节点卡片之下，避免遮挡节点） */}
        {structures.boundaries.map((b) => {
          if (!b.titleBox) return null;
          const ref: MindStructureRef = { kind: 'boundary', ownerId: b.ownerId, id: b.id };
          if (isSameStructure(editingStructure?.ref ?? null, ref)) return null;
          const selected = isSameStructure(selectedStructure, ref);
          const color = theme.branchColors[b.branchIndex % theme.branchColors.length] ?? theme.branchColors[0];
          return (
            <div
              key={`boundary-title-${b.id}`}
              data-mindmap-structure
              className="nb-mindmap-structure-tag"
              data-selected={selected}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                selectStructure(ref);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                beginEditStructure(ref);
              }}
              style={{
                position: 'absolute',
                left: b.titleBox.x,
                top: b.titleBox.y,
                width: b.titleBox.width,
                height: b.titleBox.height,
                lineHeight: `${BOUNDARY_TITLE_HEIGHT}px`,
                fontSize: BOUNDARY_TITLE_FONT_SIZE,
                fontWeight: 500,
                padding: '0 7px',
                boxSizing: 'border-box',
                borderRadius: BOUNDARY_TITLE_HEIGHT / 2,
                background: selected ? ACCENT_COLOR : color,
                color: '#ffffff',
                whiteSpace: 'pre',
                overflow: 'hidden',
                cursor: 'pointer',
              }}
            >
              {b.titleText}
            </div>
          );
        })}
        {structures.summaries.map((s) => {
          const ref: MindStructureRef = { kind: 'summary', ownerId: s.ownerId, id: s.id };
          if (isSameStructure(editingStructure?.ref ?? null, ref)) return null;
          const selected = isSameStructure(selectedStructure, ref);
          const color = theme.branchColors[s.branchIndex % theme.branchColors.length] ?? theme.branchColors[0];
          return (
            <div
              key={`summary-label-${s.id}`}
              data-mindmap-structure
              className="nb-mindmap-summary-label"
              data-selected={selected}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                selectStructure(ref);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                beginEditStructure(ref);
              }}
              style={{
                position: 'absolute',
                left: s.label.x,
                top: s.label.y,
                width: s.label.width,
                height: s.label.height,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                fontSize: SUMMARY_FONT_SIZE,
                fontWeight: 500,
                lineHeight: `${SUMMARY_LINE_HEIGHT}px`,
                boxSizing: 'border-box',
                border: `1.5px solid ${selected ? ACCENT_COLOR : color}`,
                borderRadius: 8,
                background: theme.nodeTint
                  ? `color-mix(in srgb, ${color} ${theme.nodeTint}%, var(--editor-surface, #ffffff))`
                  : 'var(--editor-surface, #ffffff)',
                color: 'var(--editor-text, #1e293b)',
                boxShadow: selected ? `0 0 0 2px ${ACCENT_COLOR}` : '0 2px 6px rgba(0, 0, 0, 0.05)',
                cursor: 'pointer',
              }}
            >
              {s.lines.map((line, idx) => (
                <div key={idx} className="nb-mindmap-title-line" style={{ height: SUMMARY_LINE_HEIGHT, opacity: s.text ? 1 : 0.5 }}>
                  {line}
                </div>
              ))}
            </div>
          );
        })}

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
          // 主选中节点挂工具栏；多选中的其余节点只显示选中描边
          const isPrimarySelected = selectedNodeId === n.node.id;
          const isSelected = isPrimarySelected || multiSelectedSet.has(n.node.id);
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
          const nodeImages = getNodeImages(n.node);
          const nodeFiles = getNodeFiles(n.node);
          const hasImage = nodeImages.length > 0;
          const hasFiles = nodeFiles.length > 0;
          // 标题排版参数与布局引擎共用，保证换行位置一致
          const textStyle = getNodeTextStyle(n.level);
          const titleHeight = titleBlockHeight(n.level, n.titleLines.length);
          // 对齐方式由布局引擎合并节点设置与全局设置
          const textAlign = n.textAlign;
          const hasCustomWidth = typeof n.node.width === 'number';
          // 折叠按钮与拉伸手柄在同一侧时会重叠：按钮叠在手柄之上，单击折叠、按住拖动调宽
          const foldDoublesAsResize = n.childSide === n.freeEdge && !isEditing;
          const foldLabel = isExpanded ? '收起子分支' : '展开子分支';
          const isResizing = resizePreview?.id === n.node.id;

          // 拖拽相关状态计算
          // 被拖节点集合已含其自身与全部子孙
          const isSourceOrDescendant = isDraggingNode && draggedDescendantIds.has(n.node.id);
          const isDropTargetInside =
            isDraggingNode && dropTarget?.targetId === n.node.id && dropTarget.pos === 'inside';

          return (
            <div
              key={n.node.id}
              className="nb-mindmap-node"
              data-node-id={n.node.id}
              data-diff={diffMarks?.get(n.node.id)}
              // 选中态供样式使用：触屏没有悬停，选中节点时显示图片 / 文件的移除按钮
              data-selected={isSelected || undefined}
              // 中心主题为主题色底，附件图标改用文字色保证对比度
              data-root={isRoot || undefined}
              onPointerDown={(e) => handleNodePointerDown(e, n)}
              onClick={(e) => {
                e.stopPropagation();
                if (isDraggingNode) return;
                // 连接模式：点击的节点即联系线终点
                if (connectFrom) {
                  finishConnect(n.node.id);
                  return;
                }
                // Ctrl / Cmd + 单击：加入或移出多选
                if (e.shiftKey) selectSiblingRange(n.node.id);
                else if (isMultiSelectModifier(e)) toggleMultiSelect(n.node.id);
                else setSelectedNodeId(n.node.id);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                // 双击图片、文件链接或拉伸手柄不进入标题编辑
                const target = e.target as HTMLElement;
                if (
                  target.closest('[data-mindmap-image]') ||
                  target.closest('[data-mindmap-file]') ||
                  target.closest('[data-resize-handle]')
                ) return;
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
                justifyContent: hasNote || hasImage || hasFiles ? 'flex-start' : 'center',
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
                cursor: connectFrom ? 'crosshair' : isEditing ? 'text' : isDraggingNode ? 'grabbing' : isRoot ? 'default' : 'grab',
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
                    // 软键盘可能连续上屏并确认，同步草稿引用，保证确认时保存的是最新文字。
                    onDraftChange={(draft) => {
                      editDraftRef.current = draft;
                      setEditDraft(draft);
                    }}
                    // 编辑时 Tab 仍新增子节点；Enter 只确认并选中当前节点，再按一次才新增同级节点。
                    onTab={() => createLinkedNode('child', n.node.id, true)}
                    onConfirm={() => {
                      handleFinishEdit(n.node.id);
                      setSelectedNodeId(n.node.id);
                    }}
                    onPasteImage={(file) => addNodeImagesFromFiles(n.node.id, [file])}
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

              {/* 多图网格：单元格统一裁切铺满，超出展示张数时末格叠加 +N，点击进入可左右切换的大图预览 */}
              {n.gallery && (
                <div
                  className="nb-mindmap-gallery"
                  style={{
                    marginTop: GALLERY_TOP_GAP,
                    width: n.gallery.width,
                    height: n.gallery.height,
                    gridTemplateColumns: `repeat(${n.gallery.columns}, ${n.gallery.cellWidth}px)`,
                    gridAutoRows: n.gallery.cellHeight,
                    gap: n.gallery.gap,
                  }}
                >
                  {nodeImages.slice(0, n.gallery.visibleCount).map((src, index) => {
                    const hiddenCount = index === n.gallery!.visibleCount - 1 ? nodeImages.length - n.gallery!.visibleCount : 0;
                    return (
                      <div key={index} className="nb-mindmap-gallery-cell">
                        <img
                          data-mindmap-image
                          draggable={false}
                          src={src}
                          alt={`节点图片 ${index + 1}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewImage({ nodeId: n.node.id, index });
                          }}
                        />
                        {hiddenCount > 0 ? (
                          <Tooltip content={`还有 ${hiddenCount} 张，点击浏览全部`} side="top" sideOffset={4}>
                            <div
                              data-mindmap-image
                              className="nb-mindmap-gallery-more"
                              onClick={(e) => {
                                e.stopPropagation();
                                setPreviewImage({ nodeId: n.node.id, index });
                              }}
                            >
                              +{hiddenCount}
                            </div>
                          </Tooltip>
                        ) : (
                          <Tooltip content="删除图片" side="top" sideOffset={4}>
                            <button
                              type="button"
                              className="nb-mindmap-image-remove"
                              aria-label="删除图片"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteImage(n.node.id, index);
                              }}
                            >
                              <X size={10} />
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 挂载单张图片：原始比例按固有宽高等比显示；宽度填充为固定高度裁切 */}
              {hasImage && !n.gallery && n.imageBox && (
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
                      src={nodeImages[0]}
                      alt="节点缩略图"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreviewImage({ nodeId: n.node.id, index: 0 });
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
                        handleDeleteImage(n.node.id, 0);
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

              {/* 本地文件链接：每个文件一行，Ctrl/Cmd + 单击（触屏点按）在应用内打开 */}
              {hasFiles && (
                <div
                  className="nb-mindmap-files"
                  style={{ marginTop: FILE_LIST_TOP_GAP, gap: FILE_ROW_GAP }}
                >
                  {nodeFiles.map((path, index) => (
                    <MindmapFileLink
                      key={`${index}:${path}`}
                      path={path}
                      onOpen={() => openFileLink(path, docKey)}
                      onRemove={() => handleRemoveFileLink(n.node.id, index)}
                    />
                  ))}
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
                  display: isPrimarySelected ? 'flex' : 'none',
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
                {/* 多选时只保留可批量的操作（图标、样式、删除），并提示选中数量 */}
                {isMultiSelecting && <span className="nb-mindmap-toolbar-count">已选 {multiSelectedIds.length} 个</span>}

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

                {/* 备注与图片只针对单个节点，多选时隐藏 */}
                {!isMultiSelecting && (
                  <>
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

                    {/* 添加图片（可多选，最多 10 张） */}
                    <Tooltip
                      content={nodeImages.length >= MAX_NODE_IMAGES ? `已达 ${MAX_NODE_IMAGES} 张上限` : hasImage ? `添加图片（${nodeImages.length}/${MAX_NODE_IMAGES}）` : '添加图片'}
                      side="top"
                      sideOffset={4}
                    >
                      <button
                        type="button"
                        className={`nb-mindmap-toolbar-btn${hasImage ? ' is-active-accent' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (nodeImages.length >= MAX_NODE_IMAGES) {
                            showToast(`每个节点最多 ${MAX_NODE_IMAGES} 张图片`, 'warning');
                            return;
                          }
                          uploadTargetNodeIdRef.current = n.node.id;
                          fileInputRef.current?.click();
                        }}
                        aria-label="添加图片"
                      >
                        <ImageIcon size={12} />
                      </button>
                    </Tooltip>

                    {/* 链接本地文件（可多选，最多 10 个） */}
                    <Tooltip
                      content={nodeFiles.length >= MAX_NODE_FILES ? `已达 ${MAX_NODE_FILES} 个上限` : hasFiles ? `链接文件（${nodeFiles.length}/${MAX_NODE_FILES}）` : '链接文件'}
                      side="top"
                      sideOffset={4}
                    >
                      <button
                        type="button"
                        className={`nb-mindmap-toolbar-btn${hasFiles ? ' is-active-accent' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleAddFileLinks(n.node.id);
                        }}
                        aria-label="链接文件"
                      >
                        <Link2 size={12} />
                      </button>
                    </Tooltip>
                  </>
                )}

                {/* 重置手动拉伸的宽度（仅自定义过宽度时显示） */}
                {hasCustomWidth && !isMultiSelecting && (
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
                {!isMultiSelecting && (
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
                )}

                {/* 删除节点（根节点不可删除；多选时删除全部选中节点） */}
                {!isRoot && (
                  <Tooltip content={isMultiSelecting ? '删除选中节点' : '删除节点'} side="top" sideOffset={4}>
                    <button
                      type="button"
                      className="nb-mindmap-toolbar-btn is-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDeleteNodes(getActionTargetIds(n.node.id));
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
                <Tooltip
                  content={foldDoublesAsResize ? `${foldLabel}，拖动调整宽度` : foldLabel}
                  side="right"
                  sideOffset={4}
                  disabled={isResizing}
                >
                  <button
                    type="button"
                    className="nb-mindmap-fold-btn"
                    data-side={n.childSide}
                    onPointerDown={foldDoublesAsResize ? (e) => handleResizePointerDown(e, n) : undefined}
                    onPointerMove={foldDoublesAsResize ? handleResizePointerMove : undefined}
                    onPointerUp={foldDoublesAsResize ? handleResizePointerUp : undefined}
                    onPointerCancel={foldDoublesAsResize ? handleResizePointerUp : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      // 刚从按钮上拖动调宽：松手后的 click 不算折叠
                      if (Date.now() < suppressFoldClickUntilRef.current) return;
                      handleToggleExpand(n.node.id);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    aria-label={foldLabel}
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
                      // 高于拉伸手柄（z-index 6），重叠处点击始终命中按钮
                      zIndex: 7,
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

        {/* 联系线图层：位于节点之上；只有线条本身可点选 */}
        <svg
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            // 与底层连线共用最小 SVG 视口，实际线条继续通过 overflow 绘制和命中。
            width: 1,
            height: 1,
            pointerEvents: 'none',
            overflow: 'visible',
          }}
        >
          {structures.relations.map((r) => {
            const ref: MindStructureRef = { kind: 'relation', ownerId: r.ownerId, id: r.id };
            const selected = isSameStructure(selectedStructure, ref);
            const color = selected ? ACCENT_COLOR : RELATION_COLOR;
            return (
              <g key={`relation-${r.id}`} className="nb-mindmap-relation" data-selected={selected}>
                <path
                  className="nb-mindmap-relation-line"
                  d={r.path}
                  fill="none"
                  stroke={color}
                  strokeWidth={selected ? 2.2 : 1.6}
                  strokeDasharray="6 4"
                  strokeLinecap="round"
                />
                <path d={r.arrowPath} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />
                <path
                  data-mindmap-structure
                  d={r.path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectStructure(ref);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    beginEditStructure(ref);
                  }}
                />
              </g>
            );
          })}
          {/* 连接模式预览线：从起点节点中心指向指针 */}
          {connectFrom && connectPointer && (() => {
            const source = nodes.find((n) => n.node.id === connectFrom);
            if (!source) return null;
            return (
              <line
                x1={source.x + source.width / 2}
                y1={source.y + source.height / 2}
                x2={connectPointer.x}
                y2={connectPointer.y}
                stroke={ACCENT_COLOR}
                strokeWidth={1.8}
                strokeDasharray="6 4"
                strokeLinecap="round"
              />
            );
          })()}
        </svg>

        {/* 联系线说明文字 */}
        {structures.relations.map((r) => {
          if (!r.labelBox) return null;
          const ref: MindStructureRef = { kind: 'relation', ownerId: r.ownerId, id: r.id };
          if (isSameStructure(editingStructure?.ref ?? null, ref)) return null;
          const selected = isSameStructure(selectedStructure, ref);
          return (
            <div
              key={`relation-label-${r.id}`}
              data-mindmap-structure
              className="nb-mindmap-structure-tag"
              data-selected={selected}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                selectStructure(ref);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                beginEditStructure(ref);
              }}
              style={{
                position: 'absolute',
                left: r.labelBox.x,
                top: r.labelBox.y,
                width: r.labelBox.width,
                height: r.labelBox.height,
                padding: '2px 6px',
                boxSizing: 'border-box',
                fontSize: RELATION_FONT_SIZE,
                lineHeight: `${RELATION_LINE_HEIGHT}px`,
                textAlign: 'center',
                borderRadius: 4,
                background: 'var(--editor-bg, #ffffff)',
                color: selected ? ACCENT_COLOR : 'var(--editor-text-secondary, #64748b)',
                cursor: 'pointer',
              }}
            >
              {r.lines.map((line, idx) => (
                <div key={idx} className="nb-mindmap-title-line" style={{ height: RELATION_LINE_HEIGHT }}>
                  {line}
                </div>
              ))}
            </div>
          );
        })}

        {/* 选中联系线：两个控制点手柄（与两端的虚线引导线），直接拖到想要的位置 */}
        {selectedStructure?.kind === 'relation' && !editingStructure && (() => {
          const r = structures.relations.find((item) => item.id === selectedStructure.id && item.ownerId === selectedStructure.ownerId);
          if (!r) return null;
          return (
            <>
              <svg style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}>
                {([[r.p1, r.cp1], [r.p2, r.cp2]] as const).map(([from, to], idx) => (
                  <line key={idx} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={ACCENT_COLOR} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
                ))}
              </svg>
              {([r.cp1, r.cp2] as const).map((point, idx) => (
                <Tooltip key={idx} content="拖动调整走线，双击恢复自动" followCursor>
                  <div
                    data-mindmap-structure
                    className="nb-mindmap-bend-handle"
                    onPointerDown={(e) => handleControlPointerDown(e, r, idx as 0 | 1)}
                    onPointerMove={handleControlPointerMove}
                    onPointerUp={handleControlPointerUp}
                    onPointerCancel={handleControlPointerUp}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      resetRelationShape(selectedStructure);
                    }}
                    style={{ left: point.x - 6, top: point.y - 6 }}
                  />
                </Tooltip>
              ))}
            </>
          );
        })()}

        {/* 选中概要 / 外框：两端手柄，拖动扩大或缩小覆盖的节点 */}
        {selectedStructure && selectedStructure.kind !== 'relation' && !editingStructure && (() => {
          const item = selectedStructure.kind === 'summary'
            ? structures.summaries.find((s) => s.id === selectedStructure.id && s.ownerId === selectedStructure.ownerId)
            : structures.boundaries.find((b) => b.id === selectedStructure.id && b.ownerId === selectedStructure.ownerId);
          if (!item) return null;
          const vertical = item.side === 'left' || item.side === 'right';
          return item.handles.map((point, idx) => (
            <Tooltip key={idx} content="拖动调整覆盖范围" followCursor>
              <div
                data-mindmap-structure
                className="nb-mindmap-range-handle"
                data-axis={vertical ? 'y' : 'x'}
                onPointerDown={(e) => handleRangePointerDown(e, selectedStructure, point)}
                onPointerMove={handleRangePointerMove}
                onPointerUp={handleRangePointerUp}
                onPointerCancel={handleRangePointerUp}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                style={vertical
                  ? { left: point.x - 8, top: point.y - 4, width: 16, height: 8 }
                  : { left: point.x - 4, top: point.y - 8, width: 8, height: 16 }}
              />
            </Tooltip>
          ));
        })()}

        {/* 选中结构元素的快捷工具栏：编辑文字 / 删除 */}
        {selectedStructure && !editingStructure && (() => {
          const anchor = getStructureAnchor(selectedStructure);
          if (!anchor) return null;
          const editLabel = selectedStructure.kind === 'summary' ? '编辑概要' : selectedStructure.kind === 'boundary' ? '编辑外框标题' : '编辑联系线文字';
          return (
            <div
              data-mindmap-structure
              className="nb-mindmap-node-toolbar"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                left: anchor.x,
                top: anchor.y,
                transform: 'translate(-50%, calc(-100% - 8px))',
                display: 'flex',
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
              <Tooltip content={editLabel} shortcut="Enter" side="top" sideOffset={4}>
                <button
                  type="button"
                  className="nb-mindmap-toolbar-btn"
                  onClick={() => beginEditStructure(selectedStructure)}
                  aria-label={editLabel}
                >
                  <Pencil size={12} />
                </button>
              </Tooltip>
              <Tooltip content="删除" shortcut={USES_COMMAND_KEY ? 'Backspace' : 'Delete'} side="top" sideOffset={4}>
                <button
                  type="button"
                  className="nb-mindmap-toolbar-btn is-danger"
                  onClick={() => deleteStructure(selectedStructure)}
                  aria-label="删除"
                >
                  <Trash2 size={12} />
                </button>
              </Tooltip>
            </div>
          );
        })()}

        {/* 结构元素文字就地编辑 */}
        {editingStructure && (() => {
          const box = getStructureEditBox(editingStructure.ref);
          if (!box) return null;
          const placeholder = editingStructure.ref.kind === 'summary' ? '输入概要' : editingStructure.ref.kind === 'boundary' ? '外框标题' : '联系线文字';
          return (
            <input
              data-mindmap-structure
              autoFocus
              className="nb-mindmap-structure-input"
              value={editingStructure.text}
              placeholder={placeholder}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setEditingStructure({ ref: editingStructure.ref, text: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitStructureEdit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditingStructure(null);
                }
              }}
              onBlur={commitStructureEdit}
              onMouseDown={(e) => e.stopPropagation()}
              style={{ left: box.x, top: box.y, width: box.width }}
            />
          );
        })()}
      </div>

      {/* 联系线连接模式提示 */}
      {connectFrom && (
        <div className="nb-mindmap-connect-hint" onMouseDown={(e) => e.stopPropagation()}>
          <Spline size={13} />
          <span>点击目标节点创建联系线</span>
          <button type="button" className="nb-mindmap-connect-cancel" onClick={cancelConnect}>
            取消
          </button>
        </div>
      )}

      {/* 内容全部移出视野时的回位按钮（底部居中） */}
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
              handleIconChange(getActionTargetIds(iconPickerState.nodeId), icon);
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
      {previewImage && (() => {
        // 从最新的树取图片列表：预览中删除图片后序号自动收敛到有效范围
        const target = findNodeById(root, previewImage.nodeId);
        const list = target ? getNodeImages(target) : [];
        if (list.length === 0) return null;
        const index = Math.min(previewImage.index, list.length - 1);
        return (
          <MindmapImagePreview
            src={list[index]}
            index={index}
            count={list.length}
            onNavigate={(next) => setPreviewImage({ nodeId: previewImage.nodeId, index: next })}
            onDelete={() => {
              handleDeleteImage(previewImage.nodeId, index);
              // 删完最后一张时关闭预览，否则停留在原位置（自动显示下一张）
              if (list.length === 1) setPreviewImage(null);
            }}
            onClose={() => setPreviewImage(null)}
          />
        );
      })()}

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
            // 显示方式只作用于单图，多图固定为网格裁切
            hasImage={target.images?.length === 1}
            defaultTextAlign={defaultTextAlign}
            defaultImageFit={defaultImageFit}
            onTextAlignChange={(value) => setNodeStyleField(getActionTargetIds(target.id), 'textAlign', value)}
            onImageFitChange={(value) => setNodeStyleField(getActionTargetIds(target.id), 'imageFit', value)}
            onClose={() => setNodeStylePopover(null)}
          />
        );
      })()}

      {/* 删除含子节点的节点前二次确认 */}
      {deleteConfirm && (
        <MindmapConfirmDialog
          title="删除节点"
          message={formatShortcut(
            deleteConfirm.nodeIds.length > 1
              ? `将删除 ${deleteConfirm.nodeIds.length} 个节点及其下 ${deleteConfirm.descendantCount} 个子节点。删除后可用 Ctrl+Z 撤销。`
              : `该节点下还有 ${deleteConfirm.descendantCount} 个子节点，将一并删除。删除后可用 Ctrl+Z 撤销。`,
          )}
          confirmLabel="删除"
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={() => {
            deleteNodesAndSelectParent(deleteConfirm.nodeIds);
            setDeleteConfirm(null);
          }}
        />
      )}

      {/* 跟随光标的半透明悬浮拖拽预览卡片 (Drag Ghost Preview) */}
      {dragPreview && (
        <div
          ref={dragPreviewElementRef}
          className="nb-mindmap-drag-preview"
          style={{
            position: 'fixed',
            left: 0,
            top: 0,
            minWidth: 100,
            maxWidth: 280,
            padding: '7px 12px',
            background: 'var(--editor-surface, #ffffff)',
            color: 'var(--editor-text, #1e293b)',
            border: '1.5px solid var(--editor-accent, #3b82f6)',
            borderRadius: 8,
            boxShadow: '0 14px 30px rgba(0, 0, 0, 0.18), 0 4px 12px rgba(59, 130, 246, 0.25)',
            pointerEvents: 'none',
            zIndex: 100001,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            // 实色预览不需要背景模糊；只变换位置，避免移动中重排和重复采样背景。
            transform: `translate3d(${dragPointRef.current.x + 14}px, ${dragPointRef.current.y + 14}px, 0) scale(1.04)`,
            willChange: 'transform',
          }}
        >
          <GripVertical size={13} style={{ color: 'var(--editor-accent, #3b82f6)', flexShrink: 0, opacity: 0.8 }} />
          {dragPreview.count <= 1 && dragPreview.node.icon && (
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
            {/* 多选拖动时显示节点数 */}
            {dragPreview.count > 1 ? `${dragPreview.count} 个节点` : dragPreview.node.text || '要点'}
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
});
