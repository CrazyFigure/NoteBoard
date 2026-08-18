// NoteBoard 块把手
// 智能跟随鼠标悬停与光标吸附段落左侧 (-24px ~ -28px)
// ProseMirror 原生 NodeSelection + view.dragging 拖拽调序
// 详见 docs/09-开发路线图.md 8.10

import { useState, useEffect, useRef, useCallback } from 'react';
import { type Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';

interface DragHandleState {
  visible: boolean;
  top: number;
  left: number;
  nodePos: number | null;
}

export function BlockDragHandle({ editor }: { editor: Editor | null }) {
  const [state, setState] = useState<DragHandleState>({
    visible: false,
    top: 0,
    left: 0,
    nodePos: null,
  });
  const [isHoveringHandle, setIsHoveringHandle] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleRef = useRef<HTMLDivElement>(null);

  // 监听编辑器区域 mousemove，动态计算鼠标所在顶层块
  useEffect(() => {
    if (!editor) return;
    const editorDom = editor.view.dom;
    const scrollParent = editorDom.closest('.nb-prose')?.parentElement ?? editorDom.parentElement ?? editorDom;

    const handleMouseMove = (e: MouseEvent) => {
      // 如果正在悬停把手本身，不移动把手
      if (handleRef.current && handleRef.current.contains(e.target as Node)) {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        return;
      }

      const clientX = e.clientX;
      const clientY = e.clientY;

      // 获取鼠标所在的顶层元素
      const targetElement = document.elementFromPoint(clientX, clientY);
      if (!targetElement || !editorDom.contains(targetElement)) {
        // 移出编辑器区域时延迟隐藏
        if (!hideTimerRef.current) {
          hideTimerRef.current = setTimeout(() => {
            if (!isHoveringHandle) {
              setState((s) => ({ ...s, visible: false }));
            }
          }, 300);
        }
        return;
      }

      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }

      // 向上寻找 ProseMirror 下的直接子块元素
      let blockEl: HTMLElement | null = targetElement as HTMLElement;
      while (blockEl && blockEl.parentElement && blockEl.parentElement !== editorDom) {
        blockEl = blockEl.parentElement;
      }

      if (!blockEl || blockEl === editorDom) return;

      try {
        const domPos = editor.view.posAtDOM(blockEl, 0);
        const $pos = editor.state.doc.resolve(domPos);
        const depth = Math.min($pos.depth, 1);
        const topLevelPos = depth === 0 ? domPos : $pos.before(depth);
        const node = editor.state.doc.nodeAt(topLevelPos);

        if (!node) return;

        const blockRect = blockEl.getBoundingClientRect();
        const scrollRect = scrollParent.getBoundingClientRect();

        const top = blockRect.top - scrollRect.top + scrollParent.scrollTop;
        const left = blockRect.left - scrollRect.left - 24;

        setState({
          visible: true,
          top,
          left: Math.max(left, 4),
          nodePos: topLevelPos,
        });
      } catch {
        // ignore
      }
    };

    const handleMouseLeave = () => {
      if (!isHoveringHandle) {
        hideTimerRef.current = setTimeout(() => {
          setState((s) => ({ ...s, visible: false }));
        }, 300);
      }
    };

    editorDom.addEventListener('mousemove', handleMouseMove);
    scrollParent.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      editorDom.removeEventListener('mousemove', handleMouseMove);
      scrollParent.removeEventListener('mouseleave', handleMouseLeave);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [editor, isHoveringHandle]);

  // 原生 ProseMirror 块拖拽触发
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      if (!editor || state.nodePos === null) return;

      const { state: editorState, view } = editor;
      const node = editorState.doc.nodeAt(state.nodePos);
      if (!node) return;

      try {
        // 1. 设置 ProseMirror NodeSelection
        const selection = NodeSelection.create(editorState.doc, state.nodePos);
        view.dispatch(editorState.tr.setSelection(selection));

        // 2. 清理原生 dragging 状态，防止 ProseMirror-tables 拦截删除导致原表格残留空壳
        (view as unknown as { dragging: unknown }).dragging = null;

        // 3. 安全的数据传输设置（注入专用块拖拽标识与源节点位置）
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(
          'application/x-noteboard-block-drag',
          JSON.stringify({ pos: state.nodePos, nodeType: node.type.name }),
        );

        // 4. 设置把手为拖拽图象
        if (handleRef.current) {
          e.dataTransfer.setDragImage(handleRef.current, 10, 10);
        }
      } catch (err) {
        console.error('初始化块拖拽失败:', err);
      }
    },
    [editor, state.nodePos],
  );

  const handleDragEnd = useCallback(() => {
    setState((s) => ({ ...s, visible: false }));
  }, []);

  if (!state.visible) {
    return null;
  }

  return (
    <div
      ref={handleRef}
      contentEditable={false}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onMouseEnter={() => setIsHoveringHandle(true)}
      onMouseLeave={() => setIsHoveringHandle(false)}
      style={{
        position: 'absolute',
        top: state.top + 2,
        left: state.left,
        width: 18,
        height: 22,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'grab',
        opacity: isHoveringHandle ? 1 : 0.45,
        transition: 'opacity 150ms ease',
        color: 'var(--editor-text-secondary)',
        fontSize: 14,
        userSelect: 'none',
        zIndex: 20,
        borderRadius: 3,
        background: isHoveringHandle ? 'var(--editor-selection)' : 'transparent',
      }}
      title="拖拽可上下移动此段落"
    >
      ⠿
    </div>
  );
}
