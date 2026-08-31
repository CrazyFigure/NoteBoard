// NoteBoard 思维导图可视化渲染器 (Mindmap Visual Mode)
// 轻量自研 SVG 矢量渲染 + 紧凑树自适应无重叠布局 (Tidy Right-Tree) + 贝塞尔平滑连接 + 节点就地编辑
// 详见 docs/09-开发路线图.md

import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import {
  Smile,
  FileText,
  Image as ImageIcon,
  Plus,
  Trash2,
  X,
  GripVertical,
} from 'lucide-react';
import type { MindNode } from './mindmapTypes';
import { generateNodeId, moveMindNode, isMindNodeDescendant } from './mindmapConverter';
import { MindmapIconPicker } from './MindmapIconPicker';
import { Tooltip } from '../../components/Tooltip';

interface MindmapRendererProps {
  root: MindNode;
  onChange: (newRoot: MindNode) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

interface LayoutNode {
  node: MindNode;
  x: number;
  y: number;
  width: number;
  height: number;
  level: number;
  branchIndex: number;
  totalSubHeight: number;
  children: LayoutNode[];
}

type DropPosition = 'before' | 'inside' | 'after';

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  sourceNode: MindNode;
  isDragging: boolean;
}

interface DropTargetState {
  targetId: string;
  pos: DropPosition;
  targetLayout: LayoutNode;
}

// 递归统计某节点下的所有子孙节点总数
function countSubtreeDescendants(node: MindNode): number {
  let count = 0;
  if (node.children && node.children.length > 0) {
    count += node.children.length;
    for (const child of node.children) {
      count += countSubtreeDescendants(child);
    }
  }
  return count;
}

const BRANCH_COLORS = [
  '#3b82f6', // 蓝
  '#10b981', // 绿
  '#f59e0b', // 橙黄
  '#8b5cf6', // 紫
  '#ec4899', // 粉
  '#06b6d4', // 青
];

const NODE_H_GAP = 54;
const NODE_V_GAP = 18;
const BASE_NODE_HEIGHT = 36;
const ROOT_NODE_HEIGHT = 44;

export function MindmapRenderer({
  root,
  onChange,
  zoom,
  onZoomChange,
}: MindmapRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetNodeIdRef = useRef<string | null>(null);

  // 画布平移状态
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 80, y: 160 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

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

  // 正在就地编辑标题的节点
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

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

  // 估算节点卡片宽度与高度
  const estimateNodeSize = useCallback((node: MindNode, isRoot: boolean): { width: number; height: number } => {
    const textLen = (node.text || '中心主题').length;
    const hasIcon = Boolean(node.icon);
    const hasNote = Boolean(node.note);
    const hasImage = Boolean(node.image);

    let baseWidth = isRoot ? 120 : 90;
    if (hasIcon) baseWidth += 24;
    let width = Math.min(280, Math.max(baseWidth, textLen * 13 + (hasIcon ? 56 : 36)));

    let height = isRoot ? ROOT_NODE_HEIGHT : BASE_NODE_HEIGHT;

    // 备注文字根据实际多行行数精确计算高度与宽度
    if (hasNote) {
      const noteLines = (node.note || '').split('\n');
      const lineCount = Math.max(1, noteLines.length);
      const visibleLines = Math.min(8, lineCount);
      // 每行备注约 16px 行高 + 6px 边距
      const noteHeight = visibleLines * 16 + 6;
      height += noteHeight;

      const maxLineLen = Math.max(...noteLines.map((l) => l.length), 0);
      width = Math.min(320, Math.max(width, Math.min(280, maxLineLen * 11 + 36)));
    }

    // 图片增加高度
    if (hasImage) {
      height += 60;
      width = Math.max(width, 160);
    }

    return { width, height };
  }, []);

  // 递归计算整棵树的包围盒与高度 (自底向上度量)
  const measureSubTree = useCallback(
    (node: MindNode, level: number): LayoutNode => {
      const isRoot = level === 0;
      const { width, height } = estimateNodeSize(node, isRoot);
      const isExpanded = node.isExpanded !== false;

      if (!isExpanded || !node.children || node.children.length === 0) {
        return {
          node,
          x: 0,
          y: 0,
          width,
          height,
          level,
          branchIndex: 0,
          totalSubHeight: height,
          children: [],
        };
      }

      const measuredChildren = node.children.map((c) => measureSubTree(c, level + 1));
      const totalChildrenHeight =
        measuredChildren.reduce((sum, c) => sum + c.totalSubHeight, 0) +
        (measuredChildren.length - 1) * NODE_V_GAP;

      const totalSubHeight = Math.max(height, totalChildrenHeight);

      return {
        node,
        x: 0,
        y: 0,
        width,
        height,
        level,
        branchIndex: 0,
        totalSubHeight,
        children: measuredChildren,
      };
    },
    [estimateNodeSize],
  );

  // 前序遍历自顶向下分配绝对坐标 (紧凑无重叠 Tidy Tree)
  const assignCoordinates = useCallback(
    (
      layoutRoot: LayoutNode,
      startX: number,
      startY: number,
      outNodes: LayoutNode[],
      outLinks: Array<{ from: LayoutNode; to: LayoutNode }>,
      parentBranchIndex = 0,
    ) => {
      layoutRoot.x = startX;
      layoutRoot.y = startY + (layoutRoot.totalSubHeight - layoutRoot.height) / 2;
      layoutRoot.branchIndex = parentBranchIndex;
      outNodes.push(layoutRoot);

      if (layoutRoot.children.length === 0) return;

      let currentChildY = startY;
      const childStartX = startX + layoutRoot.width + NODE_H_GAP;

      layoutRoot.children.forEach((child, idx) => {
        const branchIdx = layoutRoot.level === 0 ? idx % BRANCH_COLORS.length : parentBranchIndex;
        child.branchIndex = branchIdx;
        assignCoordinates(child, childStartX, currentChildY, outNodes, outLinks, branchIdx);
        outLinks.push({ from: layoutRoot, to: child });
        currentChildY += child.totalSubHeight + NODE_V_GAP;
      });
    },
    [],
  );

  // 计算无重叠思维导图绝对坐标
  const { nodes, links } = useMemo(() => {
    const measuredRoot = measureSubTree(root, 0);
    const flatNodes: LayoutNode[] = [];
    const flatLinks: Array<{ from: LayoutNode; to: LayoutNode }> = [];
    assignCoordinates(measuredRoot, 0, 0, flatNodes, flatLinks);
    return { nodes: flatNodes, links: flatLinks };
  }, [root, measureSubTree, assignCoordinates]);

  // 深度克隆并更新树
  const updateTree = useCallback(
    (mutator: (clonedRoot: MindNode) => void) => {
      const cloned = JSON.parse(JSON.stringify(root)) as MindNode;
      mutator(cloned);
      onChange(cloned);
    },
    [root, onChange],
  );

  // 切换节点折叠
  const handleToggleExpand = (id: string) => {
    updateTree((cloned) => {
      function findAndToggle(n: MindNode) {
        if (n.id === id) {
          n.isExpanded = !n.isExpanded;
          return true;
        }
        for (const c of n.children || []) {
          if (findAndToggle(c)) return true;
        }
        return false;
      }
      findAndToggle(cloned);
    });
  };

  // 添加子节点
  const handleAddChild = (parentId: string) => {
    const newNode: MindNode = {
      id: generateNodeId(),
      text: '新要点',
      isExpanded: true,
      children: [],
    };

    updateTree((cloned) => {
      function findAndAdd(n: MindNode) {
        if (n.id === parentId) {
          if (!n.children) n.children = [];
          n.children.push(newNode);
          n.isExpanded = true;
          return true;
        }
        for (const c of n.children || []) {
          if (findAndAdd(c)) return true;
        }
        return false;
      }
      findAndAdd(cloned);
    });

    setEditingNodeId(newNode.id);
    setEditText('新要点');
    setSelectedNodeId(newNode.id);
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

  // 完成就地标题编辑
  const handleFinishEdit = () => {
    if (!editingNodeId) return;
    const targetId = editingNodeId;
    const newText = editText.trim() || '无标题';

    updateTree((cloned) => {
      function findAndSet(n: MindNode) {
        if (n.id === targetId) {
          n.text = newText;
          return true;
        }
        for (const c of n.children || []) {
          if (findAndSet(c)) return true;
        }
        return false;
      }
      findAndSet(cloned);
    });

    setEditingNodeId(null);
    setEditText('');
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

  // ── 节点拖拽核心逻辑 (Pointer Events 丝滑整树拖拽) ──

  // 节点按下准备拖拽
  const handleNodePointerDown = (e: React.PointerEvent, layoutNode: LayoutNode) => {
    // 仅允许左键且非根节点参与拖拽
    if (e.button !== 0 || layoutNode.level === 0) return;

    // 排除点击输入框、按钮等交互子元素
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('textarea')) {
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
    const descendantCount = countSubtreeDescendants(session.sourceNode);
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
    const worldX = (e.clientX - rect.left - pan.x) / zoom;
    const worldY = (e.clientY - rect.top - pan.y) / zoom;

    // 寻找最近有效落点目标 (严格过滤自身及所有子孙节点，防止成环)
    let closest: DropTargetState | null = null;
    let minDistance = Infinity;

    for (const lNode of nodes) {
      const tId = lNode.node.id;
      if (
        tId === session.sourceNode.id ||
        isMindNodeDescendant(root, session.sourceNode.id, tId)
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
        cloned.text = nextRoot.text;
        cloned.isExpanded = nextRoot.isExpanded;
        cloned.children = nextRoot.children;
        cloned.note = nextRoot.note;
        cloned.icon = nextRoot.icon;
        cloned.image = nextRoot.image;
        cloned.color = nextRoot.color;
      });
      setSelectedNodeId(sourceId);
    }
  };

  // 画布鼠标按下平移
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.nb-mindmap-node')) return;
    setIsPanning(true);
    setSelectedNodeId(null);
    panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
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

  // 滚轮缩放与平移
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const nextZoom = Math.min(3, Math.max(0.2, zoom + delta));
      onZoomChange(nextZoom);
    } else {
      setPan((p) => ({
        x: p.x - e.deltaX * 0.8,
        y: p.y - e.deltaY * 0.8,
      }));
    }
  };

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
        cursor: isDraggingNode ? 'grabbing' : isPanning ? 'grabbing' : 'default',
        background: 'var(--editor-bg, #ffffff)',
        userSelect: 'none',
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
        style={{
          position: 'absolute',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
          transition: isPanning || isDraggingNode ? 'none' : 'transform 0.05s ease-out',
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
          {links.map((link, idx) => {
            const x1 = link.from.x + link.from.width;
            const y1 = link.from.y + link.from.height / 2;
            const x2 = link.to.x;
            const y2 = link.to.y + link.to.height / 2;

            const cX1 = x1 + (x2 - x1) * 0.55;
            const cY1 = y1;
            const cX2 = x1 + (x2 - x1) * 0.45;
            const cY2 = y2;

            const d = `M ${x1} ${y1} C ${cX1} ${cY1}, ${cX2} ${cY2}, ${x2} ${y2}`;
            const color = BRANCH_COLORS[link.to.branchIndex % BRANCH_COLORS.length];

            return (
              <path
                key={idx}
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={link.from.level === 0 ? 2.5 : 1.8}
                strokeLinecap="round"
                opacity={0.8}
              />
            );
          })}
        </svg>

        {/* 拖拽重排序落位高亮指示线 (Drop Indicator Line - 前置 before / 后置 after) */}
        {isDraggingNode && dropTarget && dropTarget.pos === 'before' && (
          <div
            style={{
              position: 'absolute',
              left: dropTarget.targetLayout.x - 4,
              top: dropTarget.targetLayout.y - 6,
              width: dropTarget.targetLayout.width + 8,
              height: 3,
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
                left: -4,
                top: -3.5,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: 'var(--editor-accent, #3b82f6)',
                boxShadow: '0 0 6px rgba(59, 130, 246, 0.9)',
              }}
            />
          </div>
        )}

        {isDraggingNode && dropTarget && dropTarget.pos === 'after' && (
          <div
            style={{
              position: 'absolute',
              left: dropTarget.targetLayout.x - 4,
              top: dropTarget.targetLayout.y + dropTarget.targetLayout.height + 3,
              width: dropTarget.targetLayout.width + 8,
              height: 3,
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
                left: -4,
                top: -3.5,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: 'var(--editor-accent, #3b82f6)',
                boxShadow: '0 0 6px rgba(59, 130, 246, 0.9)',
              }}
            />
          </div>
        )}

        {/* 节点卡片 DOM 图层 */}
        {nodes.map((n) => {
          const isRoot = n.level === 0;
          const isLevel1 = n.level === 1;
          const isEditing = editingNodeId === n.node.id;
          const isSelected = selectedNodeId === n.node.id;
          const hasChildren = Boolean(n.node.children && n.node.children.length > 0);
          const isExpanded = n.node.isExpanded !== false;
          const nodeColor = BRANCH_COLORS[n.branchIndex % BRANCH_COLORS.length];
          const hasIcon = Boolean(n.node.icon);
          const hasNote = Boolean(n.node.note);
          const hasImage = Boolean(n.node.image);

          // 拖拽相关状态计算
          const isBeingDragged = isDraggingNode && draggedNodeId === n.node.id;
          const isDescendantOfDragged =
            isDraggingNode &&
            draggedNodeId !== null &&
            isMindNodeDescendant(root, draggedNodeId, n.node.id);
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
                if (!isDraggingNode) {
                  setEditingNodeId(n.node.id);
                  setEditText(n.node.text);
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
                    ? 'var(--editor-accent, #3b82f6)'
                    : 'rgba(59, 130, 246, 0.12)'
                  : isRoot
                    ? 'var(--editor-accent, #3b82f6)'
                    : 'var(--editor-surface, #ffffff)',
                color: isRoot
                  ? '#ffffff'
                  : 'var(--editor-text, #1e293b)',
                border: isRoot
                  ? isSelected || isDropTargetInside
                    ? '2px solid #ffffff'
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
                      ? '0 6px 16px rgba(59, 130, 246, 0.35)'
                      : '0 2px 6px rgba(0, 0, 0, 0.05)',
                padding: isRoot ? '6px 12px' : '5px 10px',
                cursor: isEditing ? 'text' : isDraggingNode ? 'grabbing' : isRoot ? 'default' : 'grab',
                opacity: isSourceOrDescendant ? 0.35 : 1,
                transform: isSourceOrDescendant ? 'scale(0.97)' : isDropTargetInside ? 'scale(1.02)' : 'none',
                boxSizing: 'border-box',
                transition: 'border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease, opacity 0.2s ease, transform 0.15s ease',
              }}
            >
              {/* 作为子分支接入的高亮指示圆点 */}
              {isDropTargetInside && (
                <div
                  style={{
                    position: 'absolute',
                    right: -8,
                    top: '50%',
                    transform: 'translateY(-50%)',
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
                  minHeight: isRoot ? 28 : 22,
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
                        fontSize: isRoot ? 18 : 14,
                        lineHeight: 1,
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
                  <input
                    type="text"
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={handleFinishEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === 'Escape') {
                        handleFinishEdit();
                      }
                    }}
                    style={{
                      flex: 1,
                      width: '100%',
                      border: 'none',
                      outline: 'none',
                      background: 'transparent',
                      color: isRoot ? '#ffffff' : 'inherit',
                      fontSize: isRoot ? 14 : isLevel1 ? 13 : 12,
                      fontWeight: isRoot ? 600 : isLevel1 ? 500 : 400,
                      textAlign: hasNote || hasImage ? 'left' : 'center',
                    }}
                  />
                ) : (
                  <Tooltip content={n.node.text || '未命名'} side="top" sideOffset={4}>
                    <span
                      style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: isRoot ? 14 : isLevel1 ? 13 : 12,
                        fontWeight: isRoot ? 600 : isLevel1 ? 500 : 400,
                        textAlign: hasNote || hasImage ? 'left' : 'center',
                      }}
                    >
                      {n.node.text || '未命名'}
                    </span>
                  </Tooltip>
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
                      lineHeight: 1.45,
                      color: isRoot ? 'rgba(255, 255, 255, 0.85)' : 'var(--editor-text-secondary, #64748b)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      textAlign: 'left',
                      width: '100%',
                      marginTop: 3,
                      paddingTop: 3,
                      borderTop: isRoot ? '1px solid rgba(255, 255, 255, 0.2)' : '1px solid var(--editor-border, #f1f5f9)',
                      opacity: 0.9,
                      cursor: 'pointer',
                    }}
                  >
                    {n.node.note}
                  </div>
                </Tooltip>
              )}

              {/* 挂载图片缩略图 */}
              {hasImage && n.node.image && (
                <div
                  style={{
                    marginTop: 4,
                    borderRadius: 4,
                    overflow: 'hidden',
                    maxHeight: 56,
                    position: 'relative',
                    border: '1px solid var(--editor-border, rgba(0,0,0,0.08))',
                  }}
                >
                  <Tooltip content="点击放大查看大图" side="top" sideOffset={4}>
                    <img
                      src={n.node.image}
                      alt="节点缩略图"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreviewImage(n.node.image!);
                      }}
                      style={{
                        width: '100%',
                        height: 54,
                        objectFit: 'cover',
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
                  top: -28,
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
                <Tooltip content="设置图标" side="top" sideOffset={4}>
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
                    aria-label="设置图标"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--editor-text-secondary, #64748b)',
                      padding: 3,
                      borderRadius: 3,
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    <Smile size={12} />
                  </button>
                </Tooltip>

                <Tooltip content="添加/编辑备注" side="top" sideOffset={4}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingNoteNodeId(n.node.id);
                      setEditNoteText(n.node.note || '');
                    }}
                    aria-label="添加/编辑备注"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: hasNote ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-secondary, #64748b)',
                      padding: 3,
                      borderRadius: 3,
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    <FileText size={12} />
                  </button>
                </Tooltip>

                <Tooltip content="上传/替换图片" side="top" sideOffset={4}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      uploadTargetNodeIdRef.current = n.node.id;
                      fileInputRef.current?.click();
                    }}
                    aria-label="上传/替换图片"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: hasImage ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-secondary, #64748b)',
                      padding: 3,
                      borderRadius: 3,
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    <ImageIcon size={12} />
                  </button>
                </Tooltip>

                <Tooltip content="添加子分支" side="top" sideOffset={4}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddChild(n.node.id);
                    }}
                    aria-label="添加子分支"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--editor-accent, #3b82f6)',
                      padding: 3,
                      borderRadius: 3,
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    <Plus size={12} />
                  </button>
                </Tooltip>

                {!isRoot && (
                  <Tooltip content="删除节点" side="top" sideOffset={4}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteNode(n.node.id);
                      }}
                      aria-label="删除节点"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: '#ef4444',
                        padding: 3,
                        borderRadius: 3,
                        display: 'flex',
                        alignItems: 'center',
                      }}
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
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleExpand(n.node.id);
                    }}
                    aria-label={isExpanded ? '收起子分支' : '展开子分支'}
                    style={{
                      position: 'absolute',
                      right: -9,
                      top: '50%',
                      transform: 'translateY(-50%)',
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
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAddChild(n.node.id);
                  }}
                  aria-label="添加子分支"
                  style={{
                    position: 'absolute',
                    right: hasChildren ? -28 : -14,
                    top: '50%',
                    transform: 'translateY(-50%)',
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
            </div>
          );
        })}
      </div>

      {/* 节点图标选择器浮层 */}
      {iconPickerState && (
        <MindmapIconPicker
          currentIcon={iconPickerState.currentIcon}
          position={{ x: iconPickerState.x, y: iconPickerState.y }}
          onSelect={(icon) => {
            handleIconChange(iconPickerState.nodeId, icon);
            setIconPickerState(null);
          }}
          onClose={() => setIconPickerState(null)}
        />
      )}

      {/* 备注编辑对话框 (在导图模式下快速编辑多行备注) */}
      {editingNoteNodeId && (
        <div
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
                onClick={() => handleFinishNoteEdit()}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--editor-text-muted, #94a3b8)',
                }}
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
                onClick={() => {
                  setEditingNoteNodeId(null);
                  setEditNoteText('');
                }}
                style={{
                  padding: '5px 12px',
                  borderRadius: 5,
                  border: '1px solid var(--editor-border, #cbd5e1)',
                  background: 'transparent',
                  color: 'var(--editor-text-secondary, #64748b)',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleFinishNoteEdit()}
                style={{
                  padding: '5px 14px',
                  borderRadius: 5,
                  border: 'none',
                  background: 'var(--editor-accent, #3b82f6)',
                  color: '#ffffff',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                保存备注
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 图片全屏放大预览弹窗 (Lightbox) */}
      {previewImage && (
        <div
          onClick={() => setPreviewImage(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            zIndex: 100000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            cursor: 'zoom-out',
          }}
        >
          <img
            src={previewImage}
            alt="大图预览"
            style={{
              maxWidth: '90%',
              maxHeight: '90%',
              objectFit: 'contain',
              borderRadius: 8,
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.4)',
            }}
          />
        </div>
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
