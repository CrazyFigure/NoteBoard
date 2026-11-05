// NoteBoard 拖选经过已收起的块时的选区修正
//
// 问题（可视化模式）：代码块、折叠块收起后，可见部分只剩不可编辑（contentEditable=false、
// user-select: none）的标题栏，正文为 display: none。鼠标拖选时指针落在标题栏上，
// 浏览器命中测试会把选区焦点吸附到该块之后的下一个可编辑位置：
//   - 自下而上拖到收起块上：焦点停在块下方，收起块本身选不中；
//     连续两个收起块时停在两块之后，两个都选不中；
//   - 自上而下拖到收起块上：焦点越过它，落进后面的块。
// 方案：拖选期间指针位于收起块上时，按锚点方向把选区头对齐到该块内容的边界——
//   锚点在块上方 → 块内最后一个光标位置；锚点在块下方 → 块内第一个光标位置。
//   收起块因此被完整选中（与选区增强的整块底板一致），也不会越界选到相邻块。
// 只处理鼠标 / 手写笔拖选（各桌面端、网页版与平板外接鼠标）；触屏拖动是滚动或系统选区手柄，
// 拿不到指针位置，且不能在滚动时改动选区。

import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** 收起状态的可折叠块外壳标记：代码块、折叠块收起时设置在 NodeViewWrapper 上 */
export const COLLAPSED_BLOCK_ATTR = 'data-nb-collapsed';

/** 指针移动超过多少像素才算拖选（与 ProseMirror 区分单击与拖动的阈值一致），避免点击折叠按钮后误改选区 */
const DRAG_THRESHOLD_PX = 4;

const collapsedBlockSelectionKey = new PluginKey('nbCollapsedBlockSelection');

/** 收起块在文档中的范围（节点外沿） */
export interface CollapsedBlockRange {
  from: number;
  to: number;
}

/**
 * 拖选到收起块上时选区头应落的位置：锚点在块前取块内末尾，锚点在块后取块内开头。
 * 锚点在块内（拖选从块内开始）或块内没有可放光标的位置时返回 null，不做修正。
 */
export function alignHeadToCollapsedBlock(doc: ProseMirrorNode, block: CollapsedBlockRange, anchor: number): number | null {
  if (anchor <= block.from) {
    const last = Selection.findFrom(doc.resolve(block.to), -1, true);
    return last && last.to > block.from ? last.to : null;
  }
  if (anchor >= block.to) {
    const first = Selection.findFrom(doc.resolve(block.from), 1, true);
    return first && first.from < block.to ? first.from : null;
  }
  return null;
}

/** 屏幕坐标下方的收起块范围；不在本编辑器的收起块上时返回 null */
function collapsedBlockAt(view: EditorView, x: number, y: number): CollapsedBlockRange | null {
  const wrapper = view.root.elementFromPoint(x, y)?.closest(`[${COLLAPSED_BLOCK_ATTR}]`);
  if (!wrapper || !view.dom.contains(wrapper)) return null;
  // 内容区虽然隐藏但仍在 DOM 中，借它换算出文档位置
  const content = wrapper.querySelector('[data-node-view-content]');
  if (!content) return null;
  let inner: number;
  try {
    inner = view.posAtDOM(content, 0);
  } catch {
    return null;
  }
  const $inner = view.state.doc.resolve(inner);
  // 由内向外找到外壳所属的节点
  for (let depth = $inner.depth; depth > 0; depth--) {
    const dom = view.nodeDOM($inner.before(depth));
    if (dom instanceof Element && dom.contains(wrapper)) return { from: $inner.before(depth), to: $inner.after(depth) };
  }
  return null;
}

/** 拖选经过收起块时的选区修正扩展 */
export const CollapsedBlockSelection = Extension.create({
  name: 'nbCollapsedBlockSelection',
  addProseMirrorPlugins() {
    // 进行中的拖选指针位置；未拖选或尚未越过拖动阈值时为 null
    let pointer: { x: number; y: number } | null = null;
    // 编辑器选区当前是否为修正值（与浏览器原生选区不一致）
    let corrected = false;

    /** 按当前指针位置修正后的选区；指针不在收起块上或无需修正时返回 null */
    const correctedSelection = (view: EditorView, anchor: number): Selection | null => {
      if (!pointer) return null;
      const block = collapsedBlockAt(view, pointer.x, pointer.y);
      if (!block) return null;
      const head = alignHeadToCollapsedBlock(view.state.doc, block, anchor);
      return head === null ? null : TextSelection.create(view.state.doc, anchor, head);
    };

    /** 按浏览器原生选区重新取得编辑器选区；原生选区不在本编辑器内时返回 null */
    const selectionFromNative = (view: EditorView): Selection | null => {
      const native = view.dom.ownerDocument.getSelection();
      if (!native?.anchorNode || !native.focusNode) return null;
      if (!view.dom.contains(native.anchorNode) || !view.dom.contains(native.focusNode)) return null;
      try {
        const { doc } = view.state;
        const anchor = view.posAtDOM(native.anchorNode, native.anchorOffset);
        const head = view.posAtDOM(native.focusNode, native.focusOffset);
        return TextSelection.between(doc.resolve(anchor), doc.resolve(head));
      } catch {
        return null;
      }
    };

    return [
      new Plugin({
        key: collapsedBlockSelectionKey,
        props: {
          // 读取 DOM 选区时：把浏览器吸附后的焦点换成收起块的内容边界
          createSelectionBetween: (view, $anchor) => {
            const next = correctedSelection(view, $anchor.pos);
            corrected = next !== null;
            return next;
          },
        },
        view(view) {
          let start: { x: number; y: number } | null = null;
          let timer = 0;

          // 原生选区在指针事件的默认处理中才更新，下一轮任务再按最新状态修正。
          // 浏览器吸附后原生选区常常不再变化（不会触发 ProseMirror 重新读取），因此：
          //   - 指针在收起块上：主动套用修正；
          //   - 指针离开收起块：原生选区才是指针真实位置，撤回此前的修正
          const applyCorrection = () => {
            timer = 0;
            if (view.isDestroyed) return;
            const { selection } = view.state;
            if (!(selection instanceof TextSelection)) return;
            let next = correctedSelection(view, selection.anchor);
            if (next) {
              corrected = true;
            } else if (corrected) {
              corrected = false;
              next = selectionFromNative(view);
            }
            if (next && !next.eq(selection)) view.dispatch(view.state.tr.setSelection(next));
          };

          const onMove = (event: PointerEvent) => {
            if (!start) return;
            if (!pointer && Math.max(Math.abs(event.clientX - start.x), Math.abs(event.clientY - start.y)) <= DRAG_THRESHOLD_PX) return;
            pointer = { x: event.clientX, y: event.clientY };
            if (!timer) timer = window.setTimeout(applyCorrection, 0);
          };

          const stopTracking = () => {
            start = null;
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onCancel, true);
          };

          // 松开时以落点做最后一次修正（排在 ProseMirror 的 mouseup 处理之后），随后结束拖选
          const onUp = (event: PointerEvent) => {
            const dragging = pointer !== null;
            stopTracking();
            window.clearTimeout(timer);
            timer = 0;
            if (!dragging) return;
            pointer = { x: event.clientX, y: event.clientY };
            window.setTimeout(() => {
              applyCorrection();
              pointer = null;
              corrected = false;
            }, 0);
          };

          const onCancel = () => {
            stopTracking();
            window.clearTimeout(timer);
            timer = 0;
            pointer = null;
            corrected = false;
          };

          const onDown = (event: PointerEvent) => {
            if (event.button !== 0 || event.pointerType === 'touch') return;
            // 从不可编辑区域（收起块标题栏、按钮、图片等）按下不会开始原生拖选，不跟踪
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('[contenteditable]')?.getAttribute('contenteditable') === 'false') return;
            onCancel();
            start = { x: event.clientX, y: event.clientY };
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
            window.addEventListener('pointercancel', onCancel, true);
          };

          view.dom.addEventListener('pointerdown', onDown);
          return {
            destroy() {
              view.dom.removeEventListener('pointerdown', onDown);
              onCancel();
            },
          };
        },
      }),
    ];
  },
});
