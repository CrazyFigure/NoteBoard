// NoteBoard 幕布式大纲编辑器 (Outliner Mode)
// 树形列表 + Pointer Events 丝滑整树拖拽换行重排序 + 目标行级零误差高亮指示线 + 键盘导航
// 详见 docs/09-开发路线图.md

import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Plus,
  Trash2,
  GripVertical,
} from 'lucide-react';
import type { MindNode } from './mindmapTypes';
import { generateNodeId, moveMindNode, isMindNodeDescendant } from './mindmapConverter';

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

type DropPosition = 'before' | 'inside' | 'after';

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  sourceId: string;
  sourceText: string;
  isDragging: boolean;
}

export function OutlinerEditor({ root, onChange }: OutlinerEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const focusTargetIdRef = useRef<string | null>(null);

  // Pointer Events 拖拽会话状态
  const dragSessionRef = useRef<DragSession | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; text: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ targetId: string; pos: DropPosition } | null>(null);

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

  // ── Pointer Events 拖拽核心实现 ──

  const handlePointerDownHandle = (e: React.PointerEvent, item: FlatItem) => {
    if (e.button !== 0 || item.depth === 0) return;
    e.preventDefault();
    e.stopPropagation();

    const handleEl = e.currentTarget as HTMLElement;
    handleEl.setPointerCapture(e.pointerId);

    dragSessionRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      sourceId: item.node.id,
      sourceText: item.node.text || '要点',
      isDragging: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const session = dragSessionRef.current;
    if (!session) return;

    const deltaX = Math.abs(e.clientX - session.startX);
    const deltaY = Math.abs(e.clientY - session.startY);

    // 位移超过 4px 正式进入拖拽态
    if (!session.isDragging) {
      if (deltaX > 4 || deltaY > 4) {
        session.isDragging = true;
        setIsDragging(true);
        document.body.style.cursor = 'grabbing';
      } else {
        return;
      }
    }

    setDragPreview({
      x: e.clientX + 16,
      y: e.clientY + 16,
      text: session.sourceText,
    });

    // 动态基于各行真实高度与位置计算目标
    let closestTarget: { targetId: string; pos: DropPosition } | null = null;
    let minDistance = Infinity;

    for (const item of flatItems) {
      if (isMindNodeDescendant(root, session.sourceId, item.node.id)) {
        continue;
      }

      const rowEl = rowRefs.current.get(item.node.id);
      if (!rowEl) continue;

      const rect = rowEl.getBoundingClientRect();
      const rowCenterY = rect.top + rect.height / 2;
      const dist = Math.abs(e.clientY - rowCenterY);

      if (dist < minDistance && dist < Math.max(36, rect.height * 1.2)) {
        minDistance = dist;
        const offsetY = e.clientY - rect.top;
        let pos: DropPosition = 'after';

        if (item.depth === 0) {
          pos = 'inside';
        } else if (offsetY < rect.height * 0.35) {
          pos = 'before';
        } else if (offsetY > rect.height * 0.65) {
          pos = 'after';
        } else {
          pos = 'inside';
        }

        closestTarget = {
          targetId: item.node.id,
          pos,
        };
      }
    }

    setDropTarget(closestTarget);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const session = dragSessionRef.current;
    if (!session) return;

    const sourceId = session.sourceId;
    const currentDropTarget = dropTarget;

    try {
      const handleEl = e.currentTarget as HTMLElement;
      if (handleEl.hasPointerCapture(session.pointerId)) {
        handleEl.releasePointerCapture(session.pointerId);
      }
    } catch {
      // ignore
    }

    dragSessionRef.current = null;
    setIsDragging(false);
    setDragPreview(null);
    setDropTarget(null);
    document.body.style.cursor = 'default';

    if (session.isDragging && currentDropTarget) {
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
        cloned.color = nextRoot.color;
      });
    }
  };

  // 按 Esc 键随时取消拖拽
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragSessionRef.current) {
        dragSessionRef.current = null;
        setIsDragging(false);
        setDragPreview(null);
        setDropTarget(null);
        document.body.style.cursor = 'default';
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      style={{
        width: '100%',
        height: '100%',
        overflowY: 'auto',
        padding: '36px 48px',
        background: 'var(--editor-bg, #ffffff)',
        color: 'var(--editor-text, #1e293b)',
        fontFamily: 'var(--content-font-family, inherit)',
        boxSizing: 'border-box',
        position: 'relative',
      }}
    >
      <div style={{ maxWidth: 860, margin: '0 auto', position: 'relative' }}>
        {flatItems.map((item, idx) => {
          const isRoot = item.depth === 0;
          const paddingLeft = item.depth * 28;
          const isTarget = dropTarget?.targetId === item.node.id;
          const dropPos = isTarget ? dropTarget?.pos : null;
          const isInsideTarget = isTarget && dropPos === 'inside';

          return (
            <div
              key={item.node.id}
              ref={(el) => {
                if (el) rowRefs.current.set(item.node.id, el);
                else rowRefs.current.delete(item.node.id);
              }}
              className="nb-outliner-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                paddingLeft,
                margin: isRoot ? '12px 0 20px 0' : '4px 0',
                position: 'relative',
                transition: 'background 0.12s ease',
                borderRadius: 6,
                background: isInsideTarget ? 'rgba(59, 130, 246, 0.12)' : 'transparent',
              }}
            >
              {/* 行级精确落位高亮指示线 (Drop Indicator Line) - 紧贴目标行边界 */}
              {isTarget && dropPos === 'before' && (
                <div
                  style={{
                    position: 'absolute',
                    top: -2,
                    left: paddingLeft,
                    right: 0,
                    height: 2,
                    background: 'var(--editor-accent, #3b82f6)',
                    zIndex: 50,
                    pointerEvents: 'none',
                    borderRadius: 1,
                    boxShadow: '0 0 6px rgba(59, 130, 246, 0.6)',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      left: -4,
                      top: -3,
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: 'var(--editor-accent, #3b82f6)',
                      boxShadow: '0 0 4px rgba(59, 130, 246, 0.8)',
                    }}
                  />
                </div>
              )}

              {isTarget && dropPos === 'after' && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: -2,
                    left: paddingLeft,
                    right: 0,
                    height: 2,
                    background: 'var(--editor-accent, #3b82f6)',
                    zIndex: 50,
                    pointerEvents: 'none',
                    borderRadius: 1,
                    boxShadow: '0 0 6px rgba(59, 130, 246, 0.6)',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      left: -4,
                      top: -3,
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: 'var(--editor-accent, #3b82f6)',
                      boxShadow: '0 0 4px rgba(59, 130, 246, 0.8)',
                    }}
                  />
                </div>
              )}

              {/* 拖拽把手 */}
              {!isRoot && (
                <div
                  className="nb-drag-handle"
                  onPointerDown={(e) => handlePointerDownHandle(e, item)}
                  onPointerUp={handlePointerUp}
                  title="按住拖拽整行换到其他行或调整层级"
                  style={{
                    width: 18,
                    height: 24,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: isDragging ? 'grabbing' : 'grab',
                    color: 'var(--editor-text-secondary, #64748b)',
                    opacity: 0.6,
                    transition: 'opacity 0.15s ease, color 0.15s ease',
                    flexShrink: 0,
                    marginRight: 2,
                    touchAction: 'none',
                    userSelect: 'none',
                  }}
                  onMouseEnter={(e) => {
                    if (!isDragging) {
                      e.currentTarget.style.opacity = '1';
                      e.currentTarget.style.color = 'var(--editor-accent, #3b82f6)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isDragging) {
                      e.currentTarget.style.opacity = '0.6';
                      e.currentTarget.style.color = 'var(--editor-text-secondary, #64748b)';
                    }
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
                  pointerEvents: isDragging ? 'none' : 'auto',
                }}
              />

              {/* 悬停辅助操作按钮组 */}
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

      {/* 浮动拖拽跟随胶囊 */}
      {isDragging && dragPreview && (
        <div
          style={{
            position: 'fixed',
            left: dragPreview.x,
            top: dragPreview.y,
            zIndex: 99999,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            background: 'var(--editor-surface, #ffffff)',
            color: 'var(--editor-text, #1e293b)',
            border: '1px solid var(--editor-border-focus, #3b82f6)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
            fontSize: 12,
            fontWeight: 500,
            transform: 'scale(1.02)',
            opacity: 0.95,
          }}
        >
          <GripVertical size={13} color="var(--editor-accent, #3b82f6)" />
          <span>移动：{dragPreview.text.slice(0, 20) || '大纲要点'}</span>
        </div>
      )}
    </div>
  );
}
