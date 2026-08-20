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
  level: number;
  branchIndex: number;
  totalSubHeight: number;
  children: LayoutNode[];
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
const NODE_V_GAP = 16;
const NODE_HEIGHT = 36;
const ROOT_NODE_HEIGHT = 44;

export function MindmapRenderer({
  root,
  onChange,
  zoom,
  onZoomChange,
}: MindmapRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // 画布平移状态
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 80, y: 160 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // 正在就地编辑的节点
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  // 估算文本宽度
  const estimateNodeWidth = useCallback((text: string, isRoot: boolean): number => {
    const len = text.length || 2;
    const base = isRoot ? 110 : 80;
    return Math.min(260, Math.max(base, len * 13 + 36));
  }, []);

  // 递归计算整棵树的包围盒与高度 (自底向上度量)
  const measureSubTree = useCallback(
    (node: MindNode, level: number): LayoutNode => {
      const isRoot = level === 0;
      const width = estimateNodeWidth(node.text || '中心主题', isRoot);
      const height = isRoot ? ROOT_NODE_HEIGHT : NODE_HEIGHT;
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
    [estimateNodeWidth],
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

  // 画布鼠标拖拽平移
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.nb-mindmap-node')) return;
    setIsPanning(true);
    panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPanning) return;
    setPan({
      x: e.clientX - panStartRef.current.x,
      y: e.clientY - panStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

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
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
        cursor: isPanning ? 'grabbing' : 'grab',
        background: 'var(--editor-bg, #ffffff)',
        userSelect: 'none',
      }}
    >
      {/* 缩放与平移图层 */}
      <div
        style={{
          position: 'absolute',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
          transition: isPanning ? 'none' : 'transform 0.05s ease-out',
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

        {/* 节点卡片 DOM 图层 */}
        {nodes.map((n) => {
          const isRoot = n.level === 0;
          const isLevel1 = n.level === 1;
          const isEditing = editingNodeId === n.node.id;
          const hasChildren = Boolean(n.node.children && n.node.children.length > 0);
          const isExpanded = n.node.isExpanded !== false;
          const nodeColor = BRANCH_COLORS[n.branchIndex % BRANCH_COLORS.length];

          return (
            <div
              key={n.node.id}
              className="nb-mindmap-node"
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
                  : 'var(--editor-surface, #ffffff)',
                color: isRoot
                  ? '#ffffff'
                  : 'var(--editor-text, #1e293b)',
                border: isRoot
                  ? 'none'
                  : `1.5px solid ${isLevel1 ? nodeColor : 'var(--editor-border, #cbd5e1)'}`,
                borderRadius: isRoot ? 10 : 6,
                boxShadow: isRoot
                  ? '0 6px 16px rgba(59, 130, 246, 0.35)'
                  : '0 2px 6px rgba(0, 0, 0, 0.05)',
                fontSize: isRoot ? 15 : isLevel1 ? 13 : 12,
                fontWeight: isRoot ? 600 : isLevel1 ? 500 : 400,
                padding: '0 12px',
                cursor: isEditing ? 'text' : 'pointer',
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
