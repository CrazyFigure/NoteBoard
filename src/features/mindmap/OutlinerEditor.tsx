// NoteBoard 幕布式大纲编辑器 (Outliner Mode)
// 树形列表 + Pointer Events 丝滑整树拖拽换行重排序 + 目标行级零误差高亮指示线 + 键盘导航
// 详见 docs/09-开发路线图.md

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronRight,
  ChevronDown,
  Plus,
  Trash2,
  GripVertical,
  Smile,
  FileText,
  Image as ImageIcon,
  X,
} from 'lucide-react';
import type { MindNode } from './mindmapTypes';
import { generateNodeId, moveMindNode, isMindNodeDescendant } from './mindmapConverter';
import { cloneMindmapTree } from './mindmapTree';
import { MindmapIconPicker } from './MindmapIconPicker';
import { MindmapImagePreview } from './MindmapImagePreview';
import { adjustMarksForTextChange } from './mindmapRichText';
import { Tooltip } from '../../components/Tooltip';
import type { MindmapSearchHighlight } from './mindmapSearch';
import { formatShortcut } from '../../core/shortcuts';

interface OutlinerEditorProps {
  root: MindNode;
  onChange: (newRoot: MindNode) => void;
  /** 搜索匹配高亮与当前项定位 */
  searchHighlight?: MindmapSearchHighlight;
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

export function OutlinerEditor({ root, onChange, searchHighlight }: OutlinerEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const noteInputRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetNodeIdRef = useRef<string | null>(null);
  const focusTargetIdRef = useRef<string | null>(null);
  const selectOnFocusRef = useRef(true);
  const focusNoteTargetIdRef = useRef<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  // 图标选择器弹窗状态
  const [iconPickerState, setIconPickerState] = useState<{
    nodeId: string;
    currentIcon?: string;
    x: number;
    y: number;
  } | null>(null);

  // 图片全屏预览弹窗
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // Pointer Events 拖拽会话状态
  const dragSessionRef = useRef<DragSession | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; text: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ targetId: string; pos: DropPosition } | null>(null);

  // 展平节点树（用于顺序键盘导航与渲染）
  const flatItems = React.useMemo(() => {
    const list: FlatItem[] = [];

    const stack: Array<{ node: MindNode; parent: MindNode | null; parentArray: MindNode[]; indexInParent: number; depth: number }> = [
      { node: root, parent: null, parentArray: [], indexInParent: 0, depth: 0 },
    ];
    while (stack.length > 0) {
      const { node, parent, parentArray, indexInParent, depth } = stack.pop()!;
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
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          stack.push({ node: node.children[index], parent: node, parentArray: node.children, indexInParent: index, depth: depth + 1 });
        }
      }
    }

    return list;
  }, [root]);

  // 小大纲沿用原布局，大大纲按真实行高虚拟化；当前输入和待聚焦行始终保留，不能因滚动丢焦点。
  const virtualized = flatItems.length > 500;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: flatItems.length,
    enabled: virtualized,
    getScrollElement: () => containerRef.current,
    getItemKey: (index) => flatItems[index].node.id,
    estimateSize: () => 48,
    overscan: 8,
    scrollMargin: 36,
    rangeExtractor: (range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      const pinned = new Set([activeNodeId, focusTargetIdRef.current, focusNoteTargetIdRef.current, iconPickerState?.nodeId, dragSessionRef.current?.sourceId]);
      flatItems.forEach((item, index) => { if (pinned.has(item.node.id)) indexes.add(index); });
      return [...indexes].sort((left, right) => left - right);
    },
  });
  const virtualRows = virtualizer.getVirtualItems();
  const renderedItems = virtualized
    ? virtualRows.map((virtualRow) => ({ item: flatItems[virtualRow.index], idx: virtualRow.index, virtualRow }))
    : flatItems.map((item, idx) => ({ item, idx, virtualRow: undefined }));

  /** 键盘导航先把目标滚入视口，挂载后的 effect 再恢复输入焦点。 */
  const focusRow = (index: number) => {
    const target = flatItems[index];
    if (!target) return;
    const input = inputRefs.current.get(target.node.id);
    if (input) { input.focus(); return; }
    // 上下方向键只转移焦点，不把整行文字全选；新建节点仍沿用原有全选行为。
    selectOnFocusRef.current = false;
    focusTargetIdRef.current = target.node.id;
    setActiveNodeId(target.node.id);
    if (virtualized) virtualizer.scrollToIndex(index, { align: 'auto' });
  };

  // 当新增或切换聚焦节点时自动激活对应 input
  useEffect(() => {
    if (focusTargetIdRef.current) {
      const input = inputRefs.current.get(focusTargetIdRef.current);
      if (input) {
        input.focus();
        if (selectOnFocusRef.current) input.select();
        selectOnFocusRef.current = true;
        focusTargetIdRef.current = null;
      }
    }
  });

  // 自动聚焦备注输入框
  useEffect(() => {
    if (focusNoteTargetIdRef.current) {
      const noteInput = noteInputRefs.current.get(focusNoteTargetIdRef.current);
      if (noteInput) {
        noteInput.focus();
        noteInput.selectionStart = noteInput.value.length;
        noteInput.selectionEnd = noteInput.value.length;
        focusNoteTargetIdRef.current = null;
      }
    }
  });

  // 深度克隆并触发更新
  const updateTree = useCallback(
    (mutator: (clonedRoot: MindNode) => void) => {
      const cloned = cloneMindmapTree(root);
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
          // 大纲模式编辑纯文本时，导图中设置的格式随文字平移
          n.marks = adjustMarksForTextChange(n.text, text, n.marks);
          if (!n.marks) delete n.marks;
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

  // 更新指定节点的图标
  const handleIconChange = (id: string, icon?: string) => {
    updateTree((cloned) => {
      function findAndSet(n: MindNode) {
        if (n.id === id) {
          n.icon = icon;
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

  // 更新指定节点的备注文字
  const handleNoteChange = (id: string, note?: string) => {
    updateTree((cloned) => {
      function findAndSet(n: MindNode) {
        if (n.id === id) {
          n.note = note;
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

  // 更新指定节点的图片
  const handleImageChange = (id: string, image?: string) => {
    updateTree((cloned) => {
      function findAndSet(n: MindNode) {
        if (n.id === id) {
          n.image = image;
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

  // 上传图片处理 (转 Base64 Data URL)
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetNodeId = uploadTargetNodeIdRef.current;
    if (!file || !targetNodeId) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        handleImageChange(targetNodeId, reader.result);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // 粘贴图片处理
  const handlePasteInNote = (e: React.ClipboardEvent, nodeId: string) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === 'string') {
              handleImageChange(nodeId, reader.result);
            }
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    }
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
      const rowEl = rowRefs.current.get(item.node.id);
      if (!rowEl) continue;
      if (isMindNodeDescendant(root, session.sourceId, item.node.id)) {
        continue;
      }

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
        // 整体替换根节点字段，避免图标、图片、格式、宽度等字段在搬移后丢失
        for (const key of Object.keys(cloned)) delete (cloned as unknown as Record<string, unknown>)[key];
        Object.assign(cloned, nextRoot);
      });
    }
  };

  // 搜索跳转：把当前匹配行滚动到可视区中央（focusSeq 每次显式跳转递增；
  // 跳转可能刚展开折叠分支，effect 在新行渲染后执行）
  const searchFocusSeq = searchHighlight?.focusSeq ?? 0;
  useEffect(() => {
    if (!searchFocusSeq || !searchHighlight?.currentId) return;
    const index = flatItems.findIndex((item) => item.node.id === searchHighlight.currentId);
    if (virtualized && index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
    rowRefs.current.get(searchHighlight.currentId)?.scrollIntoView({ block: 'center' });
    // 仅响应跳转序号变化
  }, [searchFocusSeq]);

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
      {/* 隐藏的图片选择 input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />

      <div style={{ maxWidth: 860, margin: '0 auto', position: 'relative', height: virtualized ? virtualizer.getTotalSize() : undefined }}>
        {renderedItems.map(({ item, idx, virtualRow }) => {
          const isRoot = item.depth === 0;
          const paddingLeft = item.depth * 28;
          const isTarget = dropTarget?.targetId === item.node.id;
          const dropPos = isTarget ? dropTarget?.pos : null;
          const isInsideTarget = isTarget && dropPos === 'inside';
          const hasNote = item.node.note !== undefined;
          const hasImage = Boolean(item.node.image);
          // 搜索命中：标题底色标出命中行，当前项再加强调色描边
          const isSearchMatch = Boolean(searchHighlight?.ranges.has(item.node.id));
          const isSearchCurrent = searchHighlight?.currentId === item.node.id;

          const renderedRow = (
            <div
              key={item.node.id}
              ref={(el) => {
                if (el) rowRefs.current.set(item.node.id, el);
                else rowRefs.current.delete(item.node.id);
              }}
              className="nb-outliner-row"
              onFocusCapture={() => setActiveNodeId(item.node.id)}
              style={{
                display: 'flex',
                flexDirection: 'column',
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

              {/* 节点主行 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  paddingLeft,
                  position: 'relative',
                }}
              >
                {/* 拖拽把手 */}
                {!isRoot && (
                  <Tooltip content="按住拖拽整行换到其他行或调整层级" side="left" sideOffset={4}>
                    <div
                      className="nb-drag-handle"
                      onPointerDown={(e) => handlePointerDownHandle(e, item)}
                      onPointerUp={handlePointerUp}
                      aria-label="按住拖拽整行换到其他行或调整层级"
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
                  </Tooltip>
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

                {/* 节点前置图标按钮（有图标则直接渲染，点击可修改或移除） */}
                {item.node.icon && (
                  <Tooltip content="点击更改或移除图标" side="top" sideOffset={4}>
                    <button
                      type="button"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setIconPickerState({
                          nodeId: item.node.id,
                          currentIcon: item.node.icon,
                          x: rect.left,
                          y: rect.bottom + 4,
                        });
                      }}
                      aria-label="点击更改或移除图标"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: isRoot ? 20 : 16,
                        lineHeight: 1,
                        padding: '0 4px',
                        marginRight: 4,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 4,
                        transition: 'transform 0.12s ease',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.2)')}
                      onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                    >
                      {item.node.icon}
                    </button>
                  </Tooltip>
                )}

                {/* 节点标题输入栏 */}
                <input
                  ref={(el) => {
                    if (el) inputRefs.current.set(item.node.id, el);
                    else inputRefs.current.delete(item.node.id);
                  }}
                  type="text"
                  value={item.node.text}
                  placeholder={isRoot ? '输入中心主题' : '输入大纲要点 (按 Enter 换行，Shift+Enter 添加备注)'}
                  onChange={(e) => handleTextChange(item.node.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (e.shiftKey) {
                        // Shift+Enter 快速开启/聚焦备注
                        if (item.node.note === undefined) {
                          handleNoteChange(item.node.id, '');
                        }
                        focusNoteTargetIdRef.current = item.node.id;
                      } else {
                        handleEnterKey(item);
                      }
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
                      focusRow(idx - 1);
                    } else if (e.key === 'ArrowDown' && idx < flatItems.length - 1) {
                      e.preventDefault();
                      focusRow(idx + 1);
                    }
                  }}
                  style={{
                    flex: 1,
                    border: 'none',
                    outline: 'none',
                    color: isRoot ? 'var(--editor-heading, #0f172a)' : 'var(--editor-text, #1e293b)',
                    fontSize: isRoot ? 24 : item.depth === 1 ? 16 : 14,
                    fontWeight: isRoot ? 700 : item.depth === 1 ? 600 : 400,
                    lineHeight: 1.5,
                    padding: '4px 8px',
                    borderRadius: 4,
                    background: isSearchMatch ? 'var(--cm-search-match-bg)' : 'transparent',
                    boxShadow: isSearchCurrent ? 'inset 0 0 0 2px var(--cm-search-active-bg)' : undefined,
                    pointerEvents: isDragging ? 'none' : 'auto',
                  }}
                />

                {/* 悬停辅助操作按钮组 */}
                <div
                  className="nb-outliner-actions"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    marginLeft: 8,
                  }}
                >
                  {/* 设置/更换图标按钮 */}
                  <Tooltip content="设置节点图标/标记" side="top" sideOffset={4}>
                    <button
                      type="button"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setIconPickerState({
                          nodeId: item.node.id,
                          currentIcon: item.node.icon,
                          x: rect.left,
                          y: rect.bottom + 4,
                        });
                      }}
                      aria-label="设置节点图标/标记"
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
                    >
                      <Smile size={13} />
                    </button>
                  </Tooltip>

                  {/* 添加/聚焦备注按钮 */}
                  <Tooltip content="添加/编辑备注 (Shift+Enter)" side="top" sideOffset={4}>
                    <button
                      type="button"
                      onClick={() => {
                        if (item.node.note === undefined) {
                          handleNoteChange(item.node.id, '');
                        }
                        focusNoteTargetIdRef.current = item.node.id;
                      }}
                      aria-label="添加/编辑备注 (Shift+Enter)"
                      style={{
                        background: 'transparent',
                        border: '1px solid transparent',
                        borderRadius: 4,
                        cursor: 'pointer',
                        padding: '3px 5px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: hasNote ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-secondary, #475569)',
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
                        e.currentTarget.style.color = hasNote ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-secondary, #475569)';
                        e.currentTarget.style.transform = 'scale(1)';
                      }}
                    >
                      <FileText size={13} />
                    </button>
                  </Tooltip>

                  {/* 插入图片按钮 */}
                  <Tooltip content="上传/添加图片" side="top" sideOffset={4}>
                    <button
                      type="button"
                      onClick={() => {
                        uploadTargetNodeIdRef.current = item.node.id;
                        fileInputRef.current?.click();
                      }}
                      aria-label="上传/添加图片"
                      style={{
                        background: 'transparent',
                        border: '1px solid transparent',
                        borderRadius: 4,
                        cursor: 'pointer',
                        padding: '3px 5px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: hasImage ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-secondary, #475569)',
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
                        e.currentTarget.style.color = hasImage ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-secondary, #475569)';
                        e.currentTarget.style.transform = 'scale(1)';
                      }}
                    >
                      <ImageIcon size={13} />
                    </button>
                  </Tooltip>

                  {/* 添加同级要点按钮 */}
                  <Tooltip content="添加同级要点 (Enter)" side="top" sideOffset={4}>
                    <button
                      type="button"
                      onClick={() => handleEnterKey(item)}
                      aria-label="添加同级要点 (Enter)"
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
                    >
                      <Plus size={14} />
                    </button>
                  </Tooltip>

                  {/* 删除此要点 */}
                  {!isRoot && (
                    <Tooltip content="删除此要点及子要点" side="top" sideOffset={4}>
                      <button
                        type="button"
                        onClick={() => handleBackspaceKey(item, idx)}
                        aria-label="删除此要点及子要点"
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
                      >
                        <Trash2 size={14} />
                      </button>
                    </Tooltip>
                  )}
                </div>
              </div>

              {/* 节点备注区域（浅色小字多行输入 + 图片） */}
              {(hasNote || hasImage) && (
                <div
                  style={{
                    paddingLeft: paddingLeft + 32,
                    marginTop: 2,
                    marginBottom: 4,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  {/* 备注文字输入（浅色小字） */}
                  {hasNote && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, position: 'relative' }}>
                      <textarea
                        ref={(el) => {
                          if (el) noteInputRefs.current.set(item.node.id, el);
                          else noteInputRefs.current.delete(item.node.id);
                        }}
                        rows={Math.min(6, (item.node.note?.split('\n').length || 1))}
                        value={item.node.note || ''}
                        placeholder={formatShortcut('添加备注 (支持多行文字，直接按 Ctrl+V 粘贴图片)')}
                        onChange={(e) => handleNoteChange(item.node.id, e.target.value)}
                        onPaste={(e) => handlePasteInNote(e, item.node.id)}
                        onKeyDown={(e) => {
                          // 空行按 Backspace 自动删除备注并返回标题输入
                          if (e.key === 'Backspace' && item.node.note === '') {
                            e.preventDefault();
                            handleNoteChange(item.node.id, undefined);
                            inputRefs.current.get(item.node.id)?.focus();
                          } else if (e.key === 'Escape') {
                            inputRefs.current.get(item.node.id)?.focus();
                          }
                        }}
                        style={{
                          width: '100%',
                          maxWidth: 720,
                          fontSize: 12,
                          lineHeight: 1.6,
                          color: 'var(--editor-text-secondary, #64748b)',
                          background: 'var(--editor-surface, rgba(0, 0, 0, 0.02))',
                          border: '1px solid var(--editor-border, #e2e8f0)',
                          borderRadius: 6,
                          padding: '6px 10px',
                          outline: 'none',
                          resize: 'vertical',
                          fontFamily: 'inherit',
                          boxSizing: 'border-box',
                          transition: 'border-color 0.15s ease',
                        }}
                        onFocus={(e) => (e.target.style.borderColor = 'var(--editor-accent, #3b82f6)')}
                        onBlur={(e) => (e.target.style.borderColor = 'var(--editor-border, #e2e8f0)')}
                      />
                      <Tooltip content="删除备注" side="top" sideOffset={4}>
                        <button
                          type="button"
                          onClick={() => handleNoteChange(item.node.id, undefined)}
                          aria-label="删除备注"
                          style={{
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            color: 'var(--editor-text-muted, #94a3b8)',
                            padding: 2,
                            marginTop: 4,
                            borderRadius: 4,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
                          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--editor-text-muted, #94a3b8)')}
                        >
                          <X size={13} />
                        </button>
                      </Tooltip>
                    </div>
                  )}

                  {/* 节点挂载图片缩略图 */}
                  {hasImage && item.node.image && (
                    <div
                      style={{
                        position: 'relative',
                        display: 'inline-block',
                        maxWidth: 320,
                        borderRadius: 6,
                        overflow: 'hidden',
                        border: '1px solid var(--editor-border, #e2e8f0)',
                        background: 'var(--editor-surface, #ffffff)',
                      }}
                    >
                      <Tooltip content="点击全屏放大预览" side="top" sideOffset={4}>
                        <img
                          src={item.node.image}
                          alt="节点图片"
                          onClick={() => setPreviewImage(item.node.image!)}
                          style={{
                            display: 'block',
                            maxWidth: '100%',
                            maxHeight: 180,
                            objectFit: 'contain',
                            cursor: 'zoom-in',
                            transition: 'transform 0.15s ease',
                          }}
                        />
                      </Tooltip>
                      <Tooltip content="删除图片" side="top" sideOffset={4}>
                        <button
                          type="button"
                          onClick={() => handleImageChange(item.node.id, undefined)}
                          aria-label="删除图片"
                          style={{
                            position: 'absolute',
                            top: 4,
                            right: 4,
                            background: 'rgba(0, 0, 0, 0.65)',
                            color: '#ffffff',
                            border: 'none',
                            borderRadius: '50%',
                            width: 20,
                            height: 20,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            transition: 'background 0.15s ease',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(239, 68, 68, 0.9)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(0, 0, 0, 0.65)')}
                        >
                          <X size={12} />
                        </button>
                      </Tooltip>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
          return virtualRow ? <div key={item.node.id} data-index={idx} ref={virtualizer.measureElement}
            style={{ position: 'absolute', left: 0, top: 0, width: '100%', display: 'flow-root', transform: `translateY(${virtualRow.start - 36}px)` }}>
            {renderedRow}
          </div> : renderedRow;
        })}
      </div>

      {/* 图标选择器浮层 */}
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

      {/* 图片放大预览：Portal 到 body，支持滚轮缩放与拖动 */}
      {previewImage && (
        <MindmapImagePreview src={previewImage} onClose={() => setPreviewImage(null)} />
      )}

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
