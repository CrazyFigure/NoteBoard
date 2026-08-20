// NoteBoard 块拖拽把手
// 智能跟随鼠标悬停，并通过 Pointer Events 与 Tauri 系统文件拖放安全共存
// 详见 docs/09-开发路线图.md 8.10

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { type Editor } from '@tiptap/core';
import {
  findTopLevelBlockElement,
  getTopLevelBlockInfo,
  isTopLevelBlockMoveAllowed,
  moveTopLevelBlock,
  resolveTopLevelDropTarget,
  type TopLevelDropTarget,
} from './blockReorder';

/** 超过此位移才进入拖动，避免单击把手时误触排序。 */
const DRAG_START_DISTANCE = 4;
/** 靠近滚动视口上下边缘时的自动滚动热区。 */
const AUTO_SCROLL_EDGE = 56;
/** 单次指针事件允许的最大滚动距离，兼顾长文档速度与落点稳定性。 */
const AUTO_SCROLL_MAX_STEP = 14;
/** 落位动画时长需与 globals.css 中的 nb-block-drag-settle 保持一致。 */
const DROP_SETTLE_DURATION = 320;
/** 跟随提示与指针、视口边缘的安全间距，以及用于防止提示溢出的保守尺寸。 */
const DRAG_PREVIEW_OFFSET = 14;
const DRAG_PREVIEW_VIEWPORT_GAP = 8;
const DRAG_PREVIEW_SAFE_WIDTH = 244;
const DRAG_PREVIEW_SAFE_HEIGHT = 64;

/** 常见 Markdown 顶层节点的人类可读名称，用于拖动预览提示。 */
const BLOCK_TYPE_LABELS: Record<string, string> = {
  paragraph: '段落',
  heading: '标题',
  bulletList: '无序列表',
  orderedList: '有序列表',
  taskList: '任务列表',
  blockquote: '引用块',
  table: '表格',
  codeBlock: '代码块',
  horizontalRule: '分隔线',
  image: '图片',
  mermaidBlock: 'Mermaid 图表',
  mathBlock: '公式块',
  githubAlert: '提示块',
};

interface DragHandleState {
  visible: boolean;
  top: number;
  left: number;
  nodePos: number | null;
  nodeType: string | null;
}

interface DragFeedbackState {
  clientX: number;
  clientY: number;
  valid: boolean;
  message: string;
  indicatorTop: number | null;
  indicatorLeft: number;
  indicatorWidth: number;
}

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  sourcePos: number;
  sourceElement: HTMLElement;
  scrollParent: HTMLElement;
  dragging: boolean;
  originalBodyCursor: string;
  originalBodyUserSelect: string;
}

/** 从编辑器向外查找真正承载滚动的可视化模式容器。 */
function findScrollParent(editorDom: HTMLElement): HTMLElement {
  let current = editorDom.parentElement;

  while (current) {
    const { overflowY } = window.getComputedStyle(current);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      return current;
    }
    current = current.parentElement;
  }

  return editorDom.parentElement ?? editorDom;
}

function getBlockTypeLabel(nodeType: string | null): string {
  if (!nodeType) return '内容块';
  return BLOCK_TYPE_LABELS[nodeType] ?? '内容块';
}

/** 将跟随提示限制在当前视口内，窗口较小时也不会遮到屏幕外。 */
function clampPreviewCoordinate(value: number, viewportSize: number, reservedSize: number): number {
  const max = Math.max(DRAG_PREVIEW_VIEWPORT_GAP, viewportSize - reservedSize);
  return Math.max(DRAG_PREVIEW_VIEWPORT_GAP, Math.min(value, max));
}

export function BlockDragHandle({ editor }: { editor: Editor | null }) {
  const [state, setState] = useState<DragHandleState>({
    visible: false,
    top: 0,
    left: 0,
    nodePos: null,
    nodeType: null,
  });
  const [isHoveringHandle, setIsHoveringHandle] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragFeedback, setDragFeedback] = useState<DragFeedbackState | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const isHoveringHandleRef = useRef(false);
  const dragSessionRef = useRef<DragSession | null>(null);
  const dropTargetRef = useRef<TopLevelDropTarget | null>(null);

  const clearHideTimer = useCallback(() => {
    if (!hideTimerRef.current) return;
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  /** 清理指针捕获、全局光标和源块临时样式；取消与成功落下共用同一出口。 */
  const cleanupDrag = useCallback((updateReactState = true) => {
    const session = dragSessionRef.current;
    dragSessionRef.current = null;
    dropTargetRef.current = null;

    if (session) {
      session.sourceElement.classList.remove(
        'nb-block-drag-source',
        'nb-block-drag-source-invalid',
      );
      document.body.style.cursor = session.originalBodyCursor;
      document.body.style.userSelect = session.originalBodyUserSelect;

      const handle = handleRef.current;
      if (handle?.hasPointerCapture(session.pointerId)) {
        handle.releasePointerCapture(session.pointerId);
      }
    }

    if (updateReactState) {
      isHoveringHandleRef.current = false;
      setIsHoveringHandle(false);
      setIsDragging(false);
      setDragFeedback(null);
    }
  }, []);

  // 监听编辑器区域 mousemove，动态计算鼠标所在的顶层块和把手坐标。
  useEffect(() => {
    if (!editor) return;
    const editorDom = editor.view.dom;
    const scrollParent = findScrollParent(editorDom);

    const scheduleHide = () => {
      if (hideTimerRef.current || dragSessionRef.current) return;
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null;
        if (!isHoveringHandleRef.current && !dragSessionRef.current) {
          setState((current) => ({ ...current, visible: false }));
        }
      }, 300);
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (dragSessionRef.current) return;

      // 把手是编辑器的兄弟节点；进入把手后保持当前源块，不再按坐标重算。
      if (handleRef.current?.contains(event.target as Node)) {
        clearHideTimer();
        return;
      }

      const targetElement = document.elementFromPoint(event.clientX, event.clientY);
      if (!targetElement || !editorDom.contains(targetElement)) {
        scheduleHide();
        return;
      }

      clearHideTimer();
      const blockElement = findTopLevelBlockElement(editorDom, targetElement);
      if (!blockElement) return;

      const blockInfo = getTopLevelBlockInfo(editor.view, blockElement);
      if (!blockInfo) return;

      const blockRect = blockElement.getBoundingClientRect();
      const scrollRect = scrollParent.getBoundingClientRect();
      const top = blockRect.top - scrollRect.top + scrollParent.scrollTop;
      const left = blockRect.left - scrollRect.left + scrollParent.scrollLeft - 24;

      setState({
        visible: true,
        top,
        left: Math.max(left, 4),
        nodePos: blockInfo.pos,
        nodeType: blockInfo.node.type.name,
      });
    };

    const handleMouseLeave = () => {
      if (!isHoveringHandleRef.current) scheduleHide();
    };

    const handleScroll = () => {
      // 普通滚动时隐藏旧坐标把手；拖动过程由指针坐标持续刷新落点，不受这里影响。
      if (!dragSessionRef.current) {
        setState((current) => ({ ...current, visible: false }));
      }
    };

    editorDom.addEventListener('mousemove', handleMouseMove);
    scrollParent.addEventListener('mouseleave', handleMouseLeave);
    scrollParent.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      editorDom.removeEventListener('mousemove', handleMouseMove);
      scrollParent.removeEventListener('mouseleave', handleMouseLeave);
      scrollParent.removeEventListener('scroll', handleScroll);
      clearHideTimer();
    };
  }, [clearHideTimer, editor]);

  // 窗口失焦、按 Esc 或组件卸载时必须取消拖动，避免残留抓取光标和半透明源块。
  useEffect(() => {
    const handleWindowBlur = () => cleanupDrag();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dragSessionRef.current) return;
      event.preventDefault();
      cleanupDrag();
      setState((current) => ({ ...current, visible: false }));
    };

    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('keydown', handleKeyDown);
      cleanupDrag(false);
    };
  }, [cleanupDrag]);

  /** 根据最新指针坐标自动滚动、解析合法落点并同步视觉反馈。 */
  const updateDragFeedback = useCallback((clientX: number, clientY: number) => {
    const session = dragSessionRef.current;
    if (!editor || !session?.dragging) return;

    const { scrollParent } = session;
    let scrollRect = scrollParent.getBoundingClientRect();

    // 长文档边缘自动滚动；滚动后重新读取布局，保证指示线紧贴真实文档边界。
    if (clientY < scrollRect.top + AUTO_SCROLL_EDGE) {
      const ratio = Math.min(1, (scrollRect.top + AUTO_SCROLL_EDGE - clientY) / AUTO_SCROLL_EDGE);
      scrollParent.scrollTop -= Math.ceil(AUTO_SCROLL_MAX_STEP * ratio);
    } else if (clientY > scrollRect.bottom - AUTO_SCROLL_EDGE) {
      const ratio = Math.min(1, (clientY - scrollRect.bottom + AUTO_SCROLL_EDGE) / AUTO_SCROLL_EDGE);
      scrollParent.scrollTop += Math.ceil(AUTO_SCROLL_MAX_STEP * ratio);
    }
    scrollRect = scrollParent.getBoundingClientRect();

    const isInsideViewport = clientX >= scrollRect.left
      && clientX <= scrollRect.right
      && clientY >= scrollRect.top
      && clientY <= scrollRect.bottom;

    if (!isInsideViewport) {
      dropTargetRef.current = null;
      session.sourceElement.classList.remove('nb-block-drag-source-invalid');
      setDragFeedback({
        clientX,
        clientY,
        valid: false,
        message: '移回编辑区后释放',
        indicatorTop: null,
        indicatorLeft: 0,
        indicatorWidth: 0,
      });
      return;
    }

    const target = resolveTopLevelDropTarget(editor.view, clientY);
    const valid = Boolean(
      target
      && isTopLevelBlockMoveAllowed(editor.state.doc, session.sourcePos, target.insertPos),
    );

    dropTargetRef.current = valid ? target : null;
    const isOverSource = target?.targetPos === session.sourcePos;
    session.sourceElement.classList.toggle('nb-block-drag-source-invalid', !valid && isOverSource);

    let message = '只能放在文档顶层块之间';
    if (valid) {
      message = '释放到指示线位置';
    } else if (isOverSource) {
      message = '不能放入自身内部';
    } else if (target) {
      message = '内容已在此位置';
    }

    const editorRect = editor.view.dom.getBoundingClientRect();
    setDragFeedback({
      clientX,
      clientY,
      valid,
      message,
      indicatorTop: valid && target
        ? target.indicatorClientY - scrollRect.top + scrollParent.scrollTop
        : null,
      indicatorLeft: editorRect.left - scrollRect.left + scrollParent.scrollLeft,
      indicatorWidth: editorRect.width,
    });
  }, [editor]);

  /** 指针按下只建立候选会话；超过阈值后才进入真正拖动。 */
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!editor || state.nodePos === null || event.button !== 0) return;

    const sourceNode = editor.state.doc.nodeAt(state.nodePos);
    const sourceDom = editor.view.nodeDOM(state.nodePos);
    const sourceElement = findTopLevelBlockElement(editor.view.dom, sourceDom);
    if (!sourceNode || !sourceElement) return;

    event.preventDefault();
    event.stopPropagation();
    clearHideTimer();
    event.currentTarget.setPointerCapture(event.pointerId);

    dragSessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      sourcePos: state.nodePos,
      sourceElement,
      scrollParent: findScrollParent(editor.view.dom),
      dragging: false,
      originalBodyCursor: document.body.style.cursor,
      originalBodyUserSelect: document.body.style.userSelect,
    };
  }, [clearHideTimer, editor, state.nodePos]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    if (!session.dragging) {
      const distance = Math.hypot(
        event.clientX - session.startX,
        event.clientY - session.startY,
      );
      if (distance < DRAG_START_DISTANCE) return;

      session.dragging = true;
      session.sourceElement.classList.add('nb-block-drag-source');
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      setIsDragging(true);
    }

    updateDragFeedback(event.clientX, event.clientY);
  }, [updateDragFeedback]);

  /** 指针释放时只使用最后一个通过校验的顶层边界，并由事务内核再次校验。 */
  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    const target = dropTargetRef.current;
    const result = session.dragging && target && editor
      ? moveTopLevelBlock(editor.view, session.sourcePos, target.insertPos)
      : null;

    cleanupDrag();
    setState((current) => ({ ...current, visible: false }));

    if (result && editor) {
      // DOM 事务落位后短暂强调目标块，让用户能快速确认移动结果。
      requestAnimationFrame(() => {
        const movedDom = editor.view.nodeDOM(result.insertedPos);
        const movedElement = findTopLevelBlockElement(editor.view.dom, movedDom);
        if (!movedElement) return;
        movedElement.classList.add('nb-block-drag-settle');
        window.setTimeout(() => {
          movedElement.classList.remove('nb-block-drag-settle');
        }, DROP_SETTLE_DURATION);
      });
    }
  }, [cleanupDrag, editor]);

  const handlePointerCancel = useCallback(() => {
    cleanupDrag();
    setState((current) => ({ ...current, visible: false }));
  }, [cleanupDrag]);

  if (!state.visible) return null;

  const blockLabel = getBlockTypeLabel(state.nodeType);
  const previewLeft = dragFeedback
    ? clampPreviewCoordinate(
        dragFeedback.clientX + DRAG_PREVIEW_OFFSET,
        window.innerWidth,
        DRAG_PREVIEW_SAFE_WIDTH,
      )
    : 0;
  const previewTop = dragFeedback
    ? clampPreviewCoordinate(
        dragFeedback.clientY + DRAG_PREVIEW_OFFSET,
        window.innerHeight,
        DRAG_PREVIEW_SAFE_HEIGHT,
      )
    : 0;

  return (
    <>
      <button
        ref={handleRef}
        type="button"
        contentEditable={false}
        className={`nb-block-drag-handle${isHoveringHandle ? ' is-hovered' : ''}${isDragging ? ' is-dragging' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={() => {
          if (dragSessionRef.current) cleanupDrag();
        }}
        onMouseEnter={() => {
          isHoveringHandleRef.current = true;
          setIsHoveringHandle(true);
          clearHideTimer();
        }}
        onMouseLeave={() => {
          isHoveringHandleRef.current = false;
          if (!dragSessionRef.current) setIsHoveringHandle(false);
        }}
        style={{
          top: state.top + 2,
          left: state.left,
        }}
        aria-label={`拖动${blockLabel}`}
        title={`按住并拖动以移动${blockLabel}`}
      >
        ⠿
      </button>

      {dragFeedback?.valid && dragFeedback.indicatorTop !== null && (
        <div
          className="nb-block-drop-indicator"
          style={{
            top: dragFeedback.indicatorTop,
            left: dragFeedback.indicatorLeft,
            width: dragFeedback.indicatorWidth,
          }}
          aria-hidden="true"
        />
      )}

      {dragFeedback && (
        <div
          className={`nb-block-drag-preview${dragFeedback.valid ? '' : ' is-invalid'}`}
          style={{
            left: previewLeft,
            top: previewTop,
          }}
          aria-hidden="true"
        >
          <span className="nb-block-drag-preview-icon">
            {dragFeedback.valid ? '↕' : '⊘'}
          </span>
          <span className="nb-block-drag-preview-copy">
            <strong>移动{blockLabel}</strong>
            <span>{dragFeedback.message}</span>
          </span>
        </div>
      )}
    </>
  );
}
