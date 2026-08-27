// NoteBoard 思维导图可视化渲染器 (Mindmap Visual Mode)
// 轻量自研 SVG 矢量渲染 + 紧凑树自适应无重叠布局 (Tidy Right-Tree) + 贝塞尔平滑连接 + 节点就地编辑
// 详见 docs/09-开发路线图.md

import React, { useState, useRef, useMemo, useCallback } from 'react';
import {
  Smile,
  FileText,
  Image as ImageIcon,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { MindNode } from './mindmapTypes';
import { generateNodeId } from './mindmapConverter';
import { MindmapIconPicker } from './MindmapIconPicker';

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

  // 画布鼠标拖拽平移
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.nb-mindmap-node')) return;
    setIsPanning(true);
    setSelectedNodeId(null);
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
          const isSelected = selectedNodeId === n.node.id;
          const hasChildren = Boolean(n.node.children && n.node.children.length > 0);
          const isExpanded = n.node.isExpanded !== false;
          const nodeColor = BRANCH_COLORS[n.branchIndex % BRANCH_COLORS.length];
          const hasIcon = Boolean(n.node.icon);
          const hasNote = Boolean(n.node.note);
          const hasImage = Boolean(n.node.image);

          return (
            <div
              key={n.node.id}
              className="nb-mindmap-node"
              onClick={(e) => {
                e.stopPropagation();
                setSelectedNodeId(n.node.id);
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
                flexDirection: 'column',
                justifyContent: hasNote || hasImage ? 'flex-start' : 'center',
                background: isRoot
                  ? 'var(--editor-accent, #3b82f6)'
                  : 'var(--editor-surface, #ffffff)',
                color: isRoot
                  ? '#ffffff'
                  : 'var(--editor-text, #1e293b)',
                border: isRoot
                  ? isSelected
                    ? '2px solid #ffffff'
                    : 'none'
                  : `1.5px solid ${isSelected ? 'var(--editor-accent, #3b82f6)' : isLevel1 ? nodeColor : 'var(--editor-border, #cbd5e1)'}`,
                borderRadius: isRoot ? 10 : 8,
                boxShadow: isSelected
                  ? '0 0 0 2px var(--editor-accent, #3b82f6), 0 8px 20px rgba(0, 0, 0, 0.12)'
                  : isRoot
                    ? '0 6px 16px rgba(59, 130, 246, 0.35)'
                    : '0 2px 6px rgba(0, 0, 0, 0.05)',
                padding: isRoot ? '6px 12px' : '5px 10px',
                cursor: isEditing ? 'text' : 'pointer',
                boxSizing: 'border-box',
                transition: 'border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease',
              }}
            >
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
                    title="点击修改或移除图标"
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
                    title={n.node.text}
                  >
                    {n.node.text || '未命名'}
                  </span>
                )}
              </div>

              {/* 浅色小字备注 (支持多行文本与换行) */}
              {hasNote && (
                <div
                  title={n.node.note}
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
                  <img
                    src={n.node.image}
                    alt="节点缩略图"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPreviewImage(n.node.image!);
                    }}
                    title="点击放大查看大图"
                    style={{
                      width: '100%',
                      height: 54,
                      objectFit: 'cover',
                      display: 'block',
                      cursor: 'zoom-in',
                    }}
                  />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteImage(n.node.id);
                    }}
                    title="删除图片"
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
                  title="设置图标"
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
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingNoteNodeId(n.node.id);
                    setEditNoteText(n.node.note || '');
                  }}
                  title="添加/编辑备注"
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
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    uploadTargetNodeIdRef.current = n.node.id;
                    fileInputRef.current?.click();
                  }}
                  title="上传/替换图片"
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
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAddChild(n.node.id);
                  }}
                  title="添加子分支"
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
                {!isRoot && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteNode(n.node.id);
                    }}
                    title="删除节点"
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
                )}
              </div>

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
                    zIndex: 5,
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
                  zIndex: 5,
                }}
              >
                +
              </button>
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
    </div>
  );
}
