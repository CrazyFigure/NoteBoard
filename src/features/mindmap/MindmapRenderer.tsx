// NoteBoard 思维导图可视化渲染器 (Mindmap Visual Mode)
// 轻量自研 SVG 矢量渲染 + 紧凑树自适应无重叠布局 (Tidy Right-Tree) + 贝塞尔平滑连接 + 节点就地编辑
// 详见 docs/09-开发路线图.md

import React, { useState, useRef, useMemo, useCallback } from 'react';
import type { MindNode } from './mindmapTypes';
import { generateNodeId } from './mindmapConverter';

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
  depth: number;
  children: LayoutNode[];
}

interface MeasuredNode {
  node: MindNode;
  depth: number;
  width: number;
  height: number;
  subTreeHeight: number;
  children: MeasuredNode[];
}

const NODE_H_GAP = 56; // 水平间距
const NODE_V_GAP = 20; // 垂直间距

// 测量节点近似宽高
function measureNode(node: MindNode, depth: number): { width: number; height: number } {
  const textLength = node.text ? node.text.length : 4;
  const charWidth = depth === 0 ? 14 : depth === 1 ? 12 : 10;
  const paddingX = depth === 0 ? 36 : depth === 1 ? 26 : 20;
  const width = Math.max(76, Math.min(360, textLength * charWidth + paddingX));
  const height = depth === 0 ? 46 : depth === 1 ? 38 : 32;
  return { width, height };
}

// 第一阶段：后序遍历自底向上计算每个子树的总高度
function measureSubTree(node: MindNode, depth = 0): MeasuredNode {
  const { width, height } = measureNode(node, depth);
  const isExpanded = node.isExpanded !== false;
  const hasChildren = node.children && node.children.length > 0;

  if (!hasChildren || !isExpanded) {
    return {
      node,
      depth,
      width,
      height,
      subTreeHeight: height,
      children: [],
    };
  }

  const measuredChildren = node.children.map((c) => measureSubTree(c, depth + 1));
  const childrenTotalHeight =
    measuredChildren.reduce((sum, c) => sum + c.subTreeHeight, 0) +
    (measuredChildren.length - 1) * NODE_V_GAP;
  const subTreeHeight = Math.max(height, childrenTotalHeight);

  return {
    node,
    depth,
    width,
    height,
    subTreeHeight,
    children: measuredChildren,
  };
}

// 第二阶段：前序遍历自顶向下分配绝对 (x, y) 坐标，根节点为绝对基准
function assignCoordinates(
  mNode: MeasuredNode,
  startX: number,
  startY: number,
  nodes: LayoutNode[],
  links: Array<{ from: LayoutNode; to: LayoutNode }>,
): LayoutNode {
  const currentLayout: LayoutNode = {
    node: mNode.node,
    depth: mNode.depth,
    x: startX,
    y: startY,
    width: mNode.width,
    height: mNode.height,
    children: [],
  };
  nodes.push(currentLayout);

  if (mNode.children.length > 0) {
    const childStartX = startX + mNode.width + NODE_H_GAP;
    const childrenTotalHeight =
      mNode.children.reduce((sum, c) => sum + c.subTreeHeight, 0) +
      (mNode.children.length - 1) * NODE_V_GAP;

    // 所有子节点的总起始顶部 Y 坐标，使得子节点群体的几何中心与父节点垂直对齐
    let currentTopY = startY + mNode.height / 2 - childrenTotalHeight / 2;

    for (const child of mNode.children) {
      // 当前子节点的 Y 居中于它的子树空间
      const childNodeY = currentTopY + child.subTreeHeight / 2 - child.height / 2;
      const childLayout = assignCoordinates(child, childStartX, childNodeY, nodes, links);
      currentLayout.children.push(childLayout);
      links.push({ from: currentLayout, to: childLayout });
      currentTopY += child.subTreeHeight + NODE_V_GAP;
    }
  }

  return currentLayout;
}

export function MindmapRenderer({
  root,
  onChange,
  zoom,
  onZoomChange,
}: MindmapRendererProps) {
  const [pan, setPan] = useState({ x: 80, y: 220 });
  const [isDragging, setIsDragging] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dropTargetNodeId, setDropTargetNodeId] = useState<string | null>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });

  // 检查 target 是否是 source 或其子孙节点（防止循环引用）
  const isDescendant = (sourceId: string, targetId: string): boolean => {
    if (sourceId === targetId) return true;
    function check(n: MindNode): boolean {
      if (n.id === sourceId) {
        function search(sub: MindNode): boolean {
          if (sub.id === targetId) return true;
          for (const c of sub.children || []) {
            if (search(c)) return true;
          }
          return false;
        }
        return search(n);
      }
      for (const c of n.children || []) {
        if (check(c)) return true;
      }
      return false;
    }
    return check(root);
  };

  // 计算无重叠思维导图绝对坐标
  const { nodes, links } = useMemo(() => {
    const measuredRoot = measureSubTree(root, 0);
    const flatNodes: LayoutNode[] = [];
    const flatLinks: Array<{ from: LayoutNode; to: LayoutNode }> = [];
    assignCoordinates(measuredRoot, 0, 0, flatNodes, flatLinks);
    return { nodes: flatNodes, links: flatLinks };
  }, [root]);

  // 深度克隆并更新树
  const updateTree = useCallback(
    (mutator: (clonedRoot: MindNode) => void) => {
      const cloned = JSON.parse(JSON.stringify(root)) as MindNode;
      mutator(cloned);
      onChange(cloned);
    },
    [root, onChange],
  );

  // 处理思维导图节点拖拽放置
  const handleNodeDrop = (targetNodeId: string) => {
    if (!draggingNodeId || isDescendant(draggingNodeId, targetNodeId)) {
      setDraggingNodeId(null);
      setDropTargetNodeId(null);
      return;
    }

    const sourceId = draggingNodeId;
    setDraggingNodeId(null);
    setDropTargetNodeId(null);

    updateTree((cloned) => {
      let extracted: MindNode | null = null;
      function removeSource(n: MindNode): boolean {
        if (n.children) {
          const idx = n.children.findIndex((c) => c.id === sourceId);
          if (idx !== -1) {
            [extracted] = n.children.splice(idx, 1);
            return true;
          }
          for (const c of n.children) {
            if (removeSource(c)) return true;
          }
        }
        return false;
      }
      removeSource(cloned);
      if (!extracted) return;

      function insertIntoTarget(n: MindNode): boolean {
        if (n.id === targetNodeId) {
          if (!n.children) n.children = [];
          n.children.push(extracted!);
          n.isExpanded = true;
          return true;
        }
        for (const c of n.children || []) {
          if (insertIntoTarget(c)) return true;
        }
        return false;
      }
      insertIntoTarget(cloned);
    });
  };

  // 切换节点折叠
  const handleToggleExpand = (id: string) => {
    updateTree((cloned) => {
      function findAndToggle(n: MindNode) {
        if (n.id === id) {
          n.isExpanded = !n.isExpanded;
          return true;
        }
        for (const c of n.children) {
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
        for (const c of n.children) {
          if (findAndAdd(c)) return true;
        }
        return false;
      }
      findAndAdd(cloned);
    });

    setEditingNodeId(newNode.id);
    setEditText('新要点');
  };

  // 完成就地编辑
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
        for (const c of n.children) {
          if (findAndSet(c)) return true;
        }
        return false;
      }
      findAndSet(cloned);
    });

    setEditingNodeId(null);
  };

  // 画布鼠标拖拽平移
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).tagName === 'INPUT') return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // 画布滚轮缩放
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      onZoomChange(Math.max(0.2, Math.min(3, zoom + delta)));
    }
  };

  // 优雅的分支色彩盘（适配深浅色）
  const BRANCH_COLORS = [
    '#3b82f6', // 蓝
    '#10b981', // 绿
    '#f59e0b', // 琥珀橙
    '#8b5cf6', // 紫
    '#ec4899', // 玫红
    '#06b6d4', // 青
  ];

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
        background: 'var(--editor-bg, #f8fafc)',
        cursor: isDragging ? 'grabbing' : 'grab',
        userSelect: 'none',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      {/* 矢量画布 */}
      <svg
        style={{
          width: '100%',
          height: '100%',
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
        }}
      >
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {/* 渲染平滑贝塞尔连接曲线 */}
          {links.map((link, idx) => {
            const startX = link.from.x + link.from.width;
            const startY = link.from.y + link.from.height / 2;
            const endX = link.to.x;
            const endY = link.to.y + link.to.height / 2;
            const controlDist = Math.max(28, (endX - startX) * 0.45);

            const pathData = `M ${startX} ${startY} C ${startX + controlDist} ${startY}, ${endX - controlDist} ${endY}, ${endX} ${endY}`;
            const lineColor = BRANCH_COLORS[idx % BRANCH_COLORS.length];

            return (
              <path
                key={`${link.from.node.id}-${link.to.node.id}`}
                d={pathData}
                fill="none"
                stroke={lineColor}
                strokeWidth={link.from.depth === 0 ? 2.5 : 1.8}
                strokeLinecap="round"
                opacity={0.85}
              />
            );
          })}
        </g>
      </svg>

      {/* 节点 DOM 容器 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
          pointerEvents: 'auto',
        }}
      >
        {nodes.map((n, idx) => {
          const isRoot = n.depth === 0;
          const isLevel1 = n.depth === 1;
          const hasChildren = n.node.children && n.node.children.length > 0;
          const isExpanded = n.node.isExpanded !== false;
          const nodeColor = BRANCH_COLORS[idx % BRANCH_COLORS.length];
          const isEditing = editingNodeId === n.node.id;
          const isDropTarget = dropTargetNodeId === n.node.id;

          return (
            <div
              key={n.node.id}
              className="nb-mindmap-node"
              draggable={!isRoot && !isEditing}
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.setData('text/plain', n.node.id);
                setDraggingNodeId(n.node.id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (draggingNodeId && !isDescendant(draggingNodeId, n.node.id)) {
                  setDropTargetNodeId(n.node.id);
                }
              }}
              onDragLeave={(e) => {
                e.stopPropagation();
                if (dropTargetNodeId === n.node.id) setDropTargetNodeId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleNodeDrop(n.node.id);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditingNodeId(n.node.id);
                setEditText(n.node.text);
              }}
              style={{
                position: 'absolute',
                left: n.x,
                top: n.y,
                width: n.width,
                height: n.height,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: isRoot
                  ? 'var(--editor-accent, #3b82f6)'
                  : isDropTarget
                    ? 'rgba(59, 130, 246, 0.15)'
                    : 'var(--editor-surface, #ffffff)',
                color: isRoot
                  ? '#ffffff'
                  : 'var(--editor-text, #1e293b)',
                border: isRoot
                  ? isDropTarget ? '2px dashed #ffffff' : 'none'
                  : isDropTarget
                    ? '2px dashed var(--editor-accent, #3b82f6)'
                    : `1.5px solid ${isLevel1 ? nodeColor : 'var(--editor-border, #cbd5e1)'}`,
                borderRadius: isRoot ? 10 : 6,
                boxShadow: isRoot
                  ? '0 6px 16px rgba(59, 130, 246, 0.35)'
                  : isDropTarget
                    ? '0 0 0 3px rgba(59, 130, 246, 0.25)'
                    : '0 2px 6px rgba(0, 0, 0, 0.05)',
                fontSize: isRoot ? 15 : isLevel1 ? 13 : 12,
                fontWeight: isRoot ? 600 : isLevel1 ? 500 : 400,
                padding: '0 12px',
                cursor: isEditing ? 'text' : !isRoot ? 'grab' : 'pointer',
                opacity: draggingNodeId === n.node.id ? 0.35 : 1,
                boxSizing: 'border-box',
                transition: 'border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease',
              }}
            >
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
                    width: '100%',
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    color: isRoot ? '#ffffff' : 'inherit',
                    fontSize: 'inherit',
                    fontWeight: 'inherit',
                    textAlign: 'center',
                  }}
                />
              ) : (
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={n.node.text}
                >
                  {n.node.text || '未命名'}
                </span>
              )}

              {/* 折叠/展开徽标 */}
              {hasChildren && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleExpand(n.node.id);
                  }}
                  title={isExpanded ? '收起子分支' : '展开子分支'}
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
                  }}
                >
                  {isExpanded ? '-' : n.node.children.length}
                </button>
              )}

              {/* 悬停添加子节点按钮 */}
              <button
                type="button"
                className="nb-node-add-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleAddChild(n.node.id);
                }}
                title="添加子分支"
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
                }}
              >
                +
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
