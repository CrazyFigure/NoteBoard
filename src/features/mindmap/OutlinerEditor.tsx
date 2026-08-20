// NoteBoard 幕布式大纲编辑器 (Outliner Mode)
// 树形列表 + 拖拽把手整树拖拽排序 (支持 before / inside / after) + 键盘导航 + 状态反馈
// 详见 docs/09-开发路线图.md

import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Circle,
  Plus,
  Trash2,
  GripVertical,
} from 'lucide-react';
import type { MindNode } from './mindmapTypes';
import { generateNodeId } from './mindmapConverter';

interface OutlinerEditorProps {
  root: MindNode;
  onChange: (newRoot: MindNode) => void;
}

interface FlatItem {
  node: MindNode;
  parent: MindNode | null;
  parentArray: MindNode[];
  indexInParent: number;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

type DropPosition = 'before' | 'inside' | 'after' | null;

export function OutlinerEditor({ root, onChange }: OutlinerEditorProps) {
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const focusTargetIdRef = useRef<string | null>(null);

  // 拖拽状态
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: DropPosition } | null>(null);

  // 展平节点树（用于顺序键盘导航与渲染）
  const flatItems = React.useMemo(() => {
    const list: FlatItem[] = [];

    function traverse(
      node: MindNode,
      parent: MindNode | null,
      parentArray: MindNode[],
      indexInParent: number,
      depth: number,
    ) {
      const hasChildren = Boolean(node.children && node.children.length > 0);
      const isExpanded = node.isExpanded !== false;

      list.push({
        node,
        parent,
        parentArray,
        indexInParent,
        depth,
        hasChildren,
        isExpanded,
      });

      if (hasChildren && isExpanded && node.children) {
        node.children.forEach((child, idx) => {
          traverse(child, node, node.children!, idx, depth + 1);
        });
      }
    }

    traverse(root, null, [], 0, 0);
    return list;
  }, [root]);

  // 当新增或切换聚焦节点时自动激活对应 input
  useEffect(() => {
    if (focusTargetIdRef.current) {
      const input = inputRefs.current.get(focusTargetIdRef.current);
      if (input) {
        input.focus();
        input.select();
      }
      focusTargetIdRef.current = null;
    }
  }, [flatItems]);

  // 深度克隆并触发更新
  const updateTree = useCallback(
    (mutator: (clonedRoot: MindNode) => void) => {
      const cloned = JSON.parse(JSON.stringify(root)) as MindNode;
      mutator(cloned);
      onChange(cloned);
    },
    [root, onChange],
  );

  // 更新指定节点的文本
  const handleTextChange = (id: string, text: string) => {
    updateTree((cloned) => {
      function findAndSet(n: MindNode) {
        if (n.id === id) {
          n.text = text;
          return true;
        }
        for (const child of n.children || []) {
          if (findAndSet(child)) return true;
        }
        return false;
      }
      findAndSet(cloned);
    });
  };

  // 切换节点的展开/折叠
  const handleToggleExpand = (id: string) => {
    updateTree((cloned) => {
      function findAndToggle(n: MindNode) {
        if (n.id === id) {
          n.isExpanded = !n.isExpanded;
          return true;
        }
        for (const child of n.children || []) {
          if (findAndToggle(child)) return true;
        }
        return false;
      }
      findAndToggle(cloned);
    });
  };

  // 回车：在当前行下方创建新的同级兄弟节点
  const handleEnterKey = (item: FlatItem) => {
    const newNode: MindNode = {
      id: generateNodeId(),
      text: '',
      isExpanded: true,
      children: [],
    };

    updateTree((cloned) => {
      if (!item.parent) {
        // 在根节点下插入首个子节点
        if (!cloned.children) cloned.children = [];
        cloned.children.unshift(newNode);
        cloned.isExpanded = true;
      } else {
        function findParentAndInsert(n: MindNode): boolean {
          if (n.id === item.parent?.id) {
            if (!n.children) n.children = [];
            n.children.splice(item.indexInParent + 1, 0, newNode);
            return true;
          }
          for (const c of n.children || []) {
            if (findParentAndInsert(c)) return true;
          }
          return false;
        }
        findParentAndInsert(cloned);
      }
    });

    focusTargetIdRef.current = newNode.id;
  };

  // Tab：降级（成为前一个兄弟节点的子节点）
  const handleTabKey = (item: FlatItem) => {
    if (!item.parent || item.indexInParent === 0) return;

    const prevSibling = item.parentArray[item.indexInParent - 1];
    if (!prevSibling) return;

    updateTree((cloned) => {
      function doIndent(n: MindNode): boolean {
        if (n.id === item.parent?.id) {
          const [extracted] = n.children.splice(item.indexInParent, 1);
          if (!prevSibling.children) prevSibling.children = [];
          prevSibling.children.push(extracted);
          prevSibling.isExpanded = true;
          return true;
        }
        for (const c of n.children || []) {
          if (doIndent(c)) return true;
        }
        return false;
      }
      doIndent(cloned);
    });

    focusTargetIdRef.current = item.node.id;
  };

  // Shift+Tab：升级（提升到父节点的同级）
  const handleShiftTabKey = (item: FlatItem) => {
    if (!item.parent || item.depth <= 1) return;

    updateTree((cloned) => {
      function findParentAndLift(n: MindNode, grandParent: MindNode | null): boolean {
        if (n.id === item.parent?.id && grandParent) {
          const idx = n.children.findIndex((c) => c.id === item.node.id);
          if (idx !== -1) {
            const [extracted] = n.children.splice(idx, 1);
            const parentIdx = grandParent.children.findIndex((c) => c.id === n.id);
            grandParent.children.splice(parentIdx + 1, 0, extracted);
            return true;
          }
        }
        for (const c of n.children || []) {
          if (findParentAndLift(c, n)) return true;
        }
        return false;
      }
      findParentAndLift(cloned, null);
    });

    focusTargetIdRef.current = item.node.id;
  };

  // Backspace：空行时删除并跳到前一个节点
  const handleBackspaceKey = (item: FlatItem, currentIdx: number) => {
    if (item.node.text.length > 0 || !item.parent) return;

    const prevItem = flatItems[currentIdx - 1];
    if (prevItem) {
      focusTargetIdRef.current = prevItem.node.id;
    }

    updateTree((cloned) => {
      function doDelete(n: MindNode): boolean {
        if (n.id === item.parent?.id) {
          n.children.splice(item.indexInParent, 1);
          return true;
        }
        for (const c of n.children || []) {
          if (doDelete(c)) return true;
        }
        return false;
      }
      doDelete(cloned);
    });
  };

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

  // 处理拖拽开始
  const handleDragStart = (e: React.DragEvent, nodeId: string) => {
    e.stopPropagation();
    e.dataTransfer.setData('text/plain', nodeId);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingNodeId(nodeId);
  };

  // 处理拖拽结束（无论放置成功与否，立即复位）
  const handleDragEnd = () => {
    setDraggingNodeId(null);
    setDropTarget(null);
  };

  // 处理拖拽悬停计算放置位置
  const handleDragOver = (e: React.DragEvent, item: FlatItem) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    if (!draggingNodeId || isDescendant(draggingNodeId, item.node.id)) {
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    const height = rect.height;

    let pos: DropPosition = 'after';
    if (item.depth === 0) {
      pos = 'inside';
    } else if (offsetY < height * 0.3) {
      pos = 'before';
    } else if (offsetY > height * 0.7) {
      pos = 'after';
    } else {
      pos = 'inside';
    }

    setDropTarget({ id: item.node.id, pos });
  };

  // 拖拽放置执行节点与子树迁移
  const handleDrop = (e: React.DragEvent, targetItem: FlatItem) => {
    e.preventDefault();
    e.stopPropagation();
    const sourceId = draggingNodeId || e.dataTransfer.getData('text/plain');
    const pos = dropTarget?.pos || 'after';

    setDraggingNodeId(null);
    setDropTarget(null);

    if (!sourceId || isDescendant(sourceId, targetItem.node.id)) return;

    updateTree((cloned) => {
      // 1. 查找并抽离 source 节点
      let extractedNode: MindNode | null = null;
      function removeSource(n: MindNode): boolean {
        if (n.children) {
          const idx = n.children.findIndex((c) => c.id === sourceId);
          if (idx !== -1) {
            [extractedNode] = n.children.splice(idx, 1);
            return true;
          }
          for (const c of n.children) {
            if (removeSource(c)) return true;
          }
        }
        return false;
      }
      removeSource(cloned);
      if (!extractedNode) return;

      // 2. 插入到 target 相应位置
      if (pos === 'inside' || targetItem.depth === 0) {
        function insertInside(n: MindNode): boolean {
          if (n.id === targetItem.node.id) {
            if (!n.children) n.children = [];
            n.children.push(extractedNode!);
            n.isExpanded = true;
            return true;
          }
          for (const c of n.children || []) {
            if (insertInside(c)) return true;
          }
          return false;
        }
        insertInside(cloned);
      } else {
        function insertSibling(n: MindNode): boolean {
          if (n.children) {
            const idx = n.children.findIndex((c) => c.id === targetItem.node.id);
            if (idx !== -1) {
              const insertIdx = pos === 'before' ? idx : idx + 1;
              n.children.splice(insertIdx, 0, extractedNode!);
              return true;
            }
            for (const c of n.children) {
              if (insertSibling(c)) return true;
            }
          }
          return false;
        }
        insertSibling(cloned);
      }
    });
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        overflowY: 'auto',
        padding: '36px 48px',
        background: 'var(--editor-bg, #ffffff)',
        color: 'var(--editor-text, #1e293b)',
        fontFamily: 'var(--content-font-family, inherit)',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        {flatItems.map((item, idx) => {
          const isRoot = item.depth === 0;
          const paddingLeft = item.depth * 28;
          const isTarget = dropTarget?.id === item.node.id;
          const dropPos = isTarget ? dropTarget?.pos : null;
          const isCurrentDragging = draggingNodeId === item.node.id;

          return (
            <div
              key={item.node.id}
              className="nb-outliner-row"
              onDragOver={(e) => handleDragOver(e, item)}
              onDrop={(e) => handleDrop(e, item)}
              style={{
                display: 'flex',
                alignItems: 'center',
                paddingLeft,
                margin: isRoot ? '12px 0 20px 0' : '4px 0',
                position: 'relative',
                transition: 'background 0.12s ease, opacity 0.15s ease',
                borderRadius: 6,
                borderTop: dropPos === 'before' ? '2px solid var(--editor-accent, #3b82f6)' : '2px solid transparent',
                borderBottom: dropPos === 'after' ? '2px solid var(--editor-accent, #3b82f6)' : '2px solid transparent',
                background: dropPos === 'inside' ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                opacity: isCurrentDragging ? 0.35 : 1,
              }}
            >
              {/* 拖拽把手（仅在把手上触发 dragstart） */}
              {!isRoot && (
                <div
                  className="nb-drag-handle"
                  draggable
                  onDragStart={(e) => handleDragStart(e, item.node.id)}
                  onDragEnd={handleDragEnd}
                  title="按住拖拽整行（及其所有子要点）调整顺序与层级"
                  style={{
                    width: 18,
                    height: 24,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'grab',
                    color: 'var(--editor-text-secondary, #64748b)',
                    opacity: 0.6,
                    transition: 'opacity 0.15s ease, color 0.15s ease',
                    flexShrink: 0,
                    marginRight: 2,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.opacity = '1';
                    e.currentTarget.style.color = 'var(--editor-accent, #3b82f6)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.opacity = '0.6';
                    e.currentTarget.style.color = 'var(--editor-text-secondary, #64748b)';
                  }}
                >
                  <GripVertical size={14} />
                </div>
              )}

              {/* 展开/折叠指示箭头与大纲圆点 */}
              <div
                style={{
                  width: 24,
                  height: 24,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 6,
                  flexShrink: 0,
                }}
              >
                {item.hasChildren ? (
                  <button
                    type="button"
                    onClick={() => handleToggleExpand(item.node.id)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 2,
                      display: 'flex',
                      alignItems: 'center',
                      color: 'var(--editor-text-secondary, #475569)',
                      borderRadius: 4,
                      transition: 'all 0.12s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--toolbar-hover, rgba(0,0,0,0.06))';
                      e.currentTarget.style.color = 'var(--editor-accent, #3b82f6)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.color = 'var(--editor-text-secondary, #475569)';
                    }}
                  >
                    {item.isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                ) : (
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: isRoot ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-border, #94a3b8)',
                    }}
                  />
                )}
              </div>

              {/* 节点输入栏 */}
              <input
                ref={(el) => {
                  if (el) inputRefs.current.set(item.node.id, el);
                  else inputRefs.current.delete(item.node.id);
                }}
                type="text"
                value={item.node.text}
                placeholder={isRoot ? '输入中心主题…' : '输入大纲要点… (按 Enter 换行，Tab 缩进)'}
                onChange={(e) => handleTextChange(item.node.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleEnterKey(item);
                  } else if (e.key === 'Tab') {
                    e.preventDefault();
                    if (e.shiftKey) {
                      handleShiftTabKey(item);
                    } else {
                      handleTabKey(item);
                    }
                  } else if (e.key === 'Backspace' && item.node.text === '') {
                    e.preventDefault();
                    handleBackspaceKey(item, idx);
                  } else if (e.key === 'ArrowUp' && idx > 0) {
                    e.preventDefault();
                    inputRefs.current.get(flatItems[idx - 1].node.id)?.focus();
                  } else if (e.key === 'ArrowDown' && idx < flatItems.length - 1) {
                    e.preventDefault();
                    inputRefs.current.get(flatItems[idx + 1].node.id)?.focus();
                  }
                }}
                style={{
                  flex: 1,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: isRoot ? 'var(--editor-heading, #0f172a)' : 'var(--editor-text, #1e293b)',
                  fontSize: isRoot ? 24 : item.depth === 1 ? 16 : 14,
                  fontWeight: isRoot ? 700 : item.depth === 1 ? 600 : 400,
                  lineHeight: 1.5,
                  padding: '4px 8px',
                  borderRadius: 4,
                }}
              />

              {/* 悬停辅助操作按钮组（深色与 Hover/Active 状态反馈） */}
              <div
                className="nb-outliner-actions"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginLeft: 8,
                }}
              >
                <button
                  type="button"
                  onClick={() => handleEnterKey(item)}
                  title="添加同级要点 (Enter)"
                  style={{
                    background: 'transparent',
                    border: '1px solid transparent',
                    borderRadius: 4,
                    cursor: 'pointer',
                    padding: '3px 5px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--editor-text-secondary, #475569)',
                    transition: 'all 0.12s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--toolbar-hover, rgba(59, 130, 246, 0.12))';
                    e.currentTarget.style.borderColor = 'var(--editor-border, #cbd5e1)';
                    e.currentTarget.style.color = 'var(--editor-accent, #3b82f6)';
                    e.currentTarget.style.transform = 'scale(1.05)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.borderColor = 'transparent';
                    e.currentTarget.style.color = 'var(--editor-text-secondary, #475569)';
                    e.currentTarget.style.transform = 'scale(1)';
                  }}
                  onMouseDown={(e) => {
                    e.currentTarget.style.transform = 'scale(0.92)';
                  }}
                  onMouseUp={(e) => {
                    e.currentTarget.style.transform = 'scale(1.05)';
                  }}
                >
                  <Plus size={14} />
                </button>

                {!isRoot && (
                  <button
                    type="button"
                    onClick={() => handleBackspaceKey(item, idx)}
                    title="删除此要点及子要点"
                    style={{
                      background: 'transparent',
                      border: '1px solid transparent',
                      borderRadius: 4,
                      cursor: 'pointer',
                      padding: '3px 5px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--editor-text-secondary, #475569)',
                      transition: 'all 0.12s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(239, 68, 68, 0.12)';
                      e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.3)';
                      e.currentTarget.style.color = '#ef4444';
                      e.currentTarget.style.transform = 'scale(1.05)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.borderColor = 'transparent';
                      e.currentTarget.style.color = 'var(--editor-text-secondary, #475569)';
                      e.currentTarget.style.transform = 'scale(1)';
                    }}
                    onMouseDown={(e) => {
                      e.currentTarget.style.transform = 'scale(0.92)';
                    }}
                    onMouseUp={(e) => {
                      e.currentTarget.style.transform = 'scale(1.05)';
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
