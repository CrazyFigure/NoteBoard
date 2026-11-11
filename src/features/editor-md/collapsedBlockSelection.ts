// NoteBoard 拖选经过已收起的块 / 不可编辑区域时的选区修正
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
//
// 同类问题（可视化模式）：拖选时指针落在任何不可编辑区域（contentEditable=false）上，
// 浏览器都不会更新选区焦点，焦点停在指针最后经过的可选位置，结果取决于拖动轨迹：
//   - 任务列表复选框：沿复选框一列自下而上拖，上方的任务项选不中；
//   - 公式块、Mermaid、信息图、图片、分割线等原子节点：拖到其上选区不动，节点选不进来；
//   - 提示块、展开的折叠块、代码块的标题栏：拖到标题栏上选区停在别处。
// 方案：指针位于这些区域时同样主动修正选区头——
//   原子节点：按锚点方向越过整个节点（锚点在上 → 节点之后首个光标位置；锚点在下 → 节点之前）；
//   含正文的节点：装饰区在正文前（复选框、标题栏）→ 正文第一个光标位置，在正文后 → 最后一个光标位置，
//   相当于把指针视为落在装饰区旁边那一行的行首 / 行尾。
//
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

/** 指针下方不可编辑区域所属的节点：from / to 为节点外沿，at 为该区域在文档中的换算位置 */
export interface NonEditableTarget {
  from: number;
  to: number;
  at: number;
}

/**
 * 拖选到不可编辑区域上时选区头应落的位置。
 * 原子节点（无可放光标的内部位置）：按锚点方向越过整个节点，使其被完整选中；
 * 含正文的节点：区域在正文前取正文第一个光标位置，在正文后取最后一个光标位置。
 * 找不到合适位置时返回 null，不做修正。
 */
export function alignHeadToNonEditable(doc: ProseMirrorNode, target: NonEditableTarget, anchor: number): number | null {
  const { from, to, at } = target;
  const node = doc.nodeAt(from);
  if (!node) return null;

  const first = Selection.findFrom(doc.resolve(from), 1, true);
  const hasInner = !node.isLeaf && !!first && first.from > from && first.from < to;
  if (!hasInner) {
    // 原子节点：锚点在前 → 节点之后首个光标位置；锚点在后 → 节点之前最后一个光标位置
    if (anchor <= from) {
      const after = Selection.findFrom(doc.resolve(to), 1, true);
      return after ? after.head : null;
    }
    if (anchor >= to) {
      const before = Selection.findFrom(doc.resolve(from), -1, true);
      return before ? before.head : null;
    }
    return null;
  }

  // 含正文的节点：区域位于正文之后（换算位置在节点末尾）时向前找，其余向后找；
  // 找不到时换方向兜底，结果必须仍在节点内部
  const inside = (sel: Selection | null) => (sel && sel.head > from && sel.head < to ? sel.head : null);
  const $at = doc.resolve(Math.min(Math.max(at, from + 1), to - 1));
  const backward = at >= to - 1;
  return inside(Selection.findFrom($at, backward ? -1 : 1, true))
    ?? inside(Selection.findFrom($at, backward ? 1 : -1, true));
}

/** 留白探测：自指针处向右每隔多少像素命中一次、最远探测多远（覆盖左侧留白与嵌套任务列表缩进） */
const GUTTER_PROBE_STEP_PX = 6;
const GUTTER_PROBE_RANGE_PX = 96;

/** 是否为编辑器根或列表容器（指针落在其留白而非任何文本上） */
function isGutterContainer(view: EditorView, element: Element): boolean {
  return element === view.dom || element.matches('ul, ol, li');
}

/**
 * 拖选指针下方的元素。
 * 任务项一行的开头是不可编辑的复选框，指针在其左侧留白时浏览器同样无法把焦点放进该行；
 * 此时向右探测同一行，若先遇到不可编辑装饰则视为指针落在该装饰上，其余情况保持原生命中结果。
 * 指针在复选框与正文之间的间隙（命中任务项 li 本身）时，浏览器会把焦点放到该行末尾，同样按落在复选框上处理。
 */
function pointerTargetAt(view: EditorView, x: number, y: number): Element | null {
  const element = view.root.elementFromPoint(x, y);
  if (!element || !view.dom.contains(element) || !isGutterContainer(view, element)) return element;
  if (element.matches('li')) {
    // 只认与指针同一行的装饰：li 纵向还覆盖其嵌套子列表的各行
    const decoration = Array.from(element.children).find((child) => child.getAttribute('contenteditable') === 'false');
    const rect = decoration?.getBoundingClientRect();
    if (decoration && rect && y >= rect.top && y <= rect.bottom) return decoration;
  }
  const right = view.dom.getBoundingClientRect().right;
  for (let probe = x + GUTTER_PROBE_STEP_PX; probe <= Math.min(x + GUTTER_PROBE_RANGE_PX, right); probe += GUTTER_PROBE_STEP_PX) {
    const next = view.root.elementFromPoint(probe, y);
    if (!next || next === element || !view.dom.contains(next) || isGutterContainer(view, next)) continue;
    const region = next.closest('[contenteditable]');
    // 先遇到不可编辑装饰：按落在装饰上处理；先遇到可编辑内容：浏览器原生选区即可正确处理
    return region && region !== view.dom && region.getAttribute('contenteditable') === 'false' ? next : element;
  }
  return element;
}

/** 指针下方元素所在的不可编辑区域及其所属节点；指针在可编辑内容上或不在本编辑器内时返回 null */
function nonEditableTargetAt(view: EditorView, element: Element | null): NonEditableTarget | null {
  if (!element || element === view.dom || !view.dom.contains(element)) return null;
  // 最近的 contenteditable 声明决定可否编辑：可编辑内容交给浏览器原生选区
  const region = element.closest('[contenteditable]');
  if (!region || region === view.dom || region.getAttribute('contenteditable') !== 'false' || !view.dom.contains(region)) return null;
  let at: number;
  try {
    at = view.posAtDOM(region, 0);
  } catch {
    return null;
  }
  const { doc } = view.state;
  const $at = doc.resolve(at);
  // 原子节点：换算位置在节点之前
  const after = $at.nodeAfter;
  if (after && view.nodeDOM(at)?.contains(region)) return { from: at, to: at + after.nodeSize, at };
  // 含正文的节点：由内向外找到包含该区域的节点
  for (let depth = $at.depth; depth > 0; depth--) {
    const dom = view.nodeDOM($at.before(depth));
    if (dom instanceof Element && dom.contains(region)) return { from: $at.before(depth), to: $at.after(depth), at };
  }
  return null;
}

/** 指针下方元素所在的收起块范围；不在本编辑器的收起块上时返回 null */
function collapsedBlockAt(view: EditorView, element: Element | null): CollapsedBlockRange | null {
  const wrapper = element?.closest(`[${COLLAPSED_BLOCK_ATTR}]`);
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

/** 拖选经过收起块 / 不可编辑区域时的选区修正扩展 */
export const CollapsedBlockSelection = Extension.create({
  name: 'nbCollapsedBlockSelection',
  addProseMirrorPlugins() {
    // 进行中的拖选指针下方的元素；未拖选或尚未越过拖动阈值时为 null。
    // 在指针事件发生时命中测试并记下：延后到修正时再测，松开后弹出的气泡菜单等浮层会挡住指针位置
    let pointer: { target: Element | null } | null = null;
    // 编辑器选区当前是否为修正值（与浏览器原生选区不一致）
    let corrected = false;

    /** 按当前指针位置修正后的选区；指针不在收起块 / 不可编辑区域上或无需修正时返回 null */
    const correctedSelection = (view: EditorView, anchor: number): Selection | null => {
      if (!pointer) return null;
      const { doc } = view.state;
      // 收起块优先：其标题栏同样不可编辑，但应按整块对齐
      const block = collapsedBlockAt(view, pointer.target);
      let head: number | null;
      if (block) {
        head = alignHeadToCollapsedBlock(doc, block, anchor);
      } else {
        const target = nonEditableTargetAt(view, pointer.target);
        head = target ? alignHeadToNonEditable(doc, target, anchor) : null;
      }
      return head === null ? null : TextSelection.create(doc, anchor, head);
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
          // 读取 DOM 选区时：把浏览器吸附 / 停滞的焦点换成收起块或不可编辑区域对应的位置
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
          //   - 指针在收起块 / 不可编辑区域上：主动套用修正；
          //   - 指针回到可编辑内容：原生选区才是指针真实位置，撤回此前的修正
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
            pointer = { target: pointerTargetAt(view, event.clientX, event.clientY) };
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
            pointer = { target: pointerTargetAt(view, event.clientX, event.clientY) };
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
