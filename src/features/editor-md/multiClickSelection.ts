// NoteBoard 双击 / 三击选区修正：选区不跨越段落边界
//
// 问题（可视化模式，Chromium 原生选词）：
//   1. 行尾右侧空白处双击：原生选词取「光标后面的那个词」，而行尾光标后面紧跟的是段落分界，
//      于是选中一个看不见的换行，选区从本段末尾一直跨到下一段 / 下一个高亮块的开头，
//      行尾还会画出一块空白高亮。空段落里双击、三击同理。
//   2. 段落之间的空白（.ProseMirror p 的 margin-bottom 16px、列表外边距等）不属于任何块，
//      命中测试会把这片空白一律判给「下一个块」，鼠标稍微落在上一段文字下方时，
//      双击 / 三击选中的却是下一段（三击还会越界带上再下一段的开头）。
//
// 方案：
//   - 行尾右侧双击：选中行尾最后一个词；行尾是空格、硬换行或空段落时只放置光标，不选中任何东西。
//   - 块间空隙双击 / 三击：按垂直距离判给更近的文本块，再按上面的规则选词 / 选整段。
//   - 三击：只选中所在文本块的文字，不含段落分界。
//   - 离分割线 / 图片 / 图表等非文本块更近的空隙：不选任何文字，保留第一次单击的光标。
//   选词用 Intl.Segmenter（与浏览器原生分词同样基于 ICU）；点在文字上的双击、单击、拖选、
//   代码块内的三击，以及点在非文本块本身上的点击（如图片双击预览），仍走原有逻辑。

import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';
import { Plugin, Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** 叶子内联节点（图片、硬换行、公式等）的占位字符：每个占 1 个文档位置，保证字符偏移与位置一一对应 */
const LEAF_PLACEHOLDER = '￼';

/** 点击位置超出行尾光标多少像素才算点在「行尾右侧空白」，避免把点在末字右半边误判为行尾 */
const LINE_END_SLOP_PX = 2;

let wordSegmenter: Intl.Segmenter | null = null;

/** 取文本块 DOM 的矩形；节点不可见（如折叠内容）时返回 null */
function blockRect(view: EditorView, blockPos: number): DOMRect | null {
  const dom = view.nodeDOM(blockPos);
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
}

/** 两个文本块之间夹着的其它块（图片、图表、分割线等）的位置列表 */
function blocksBetween(doc: ProseMirrorNode, from: number, to: number): number[] {
  const found: number[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    // 完整落在两块之间的节点就是夹在中间的块；只跨过边界的是外层容器（列表、引用等），继续向下看
    if (pos >= from && pos + node.nodeSize <= to) {
      found.push(pos);
      return false;
    }
    return true;
  });
  return found;
}

/** 空隙点击既不该判给任何文本块、也不该交给原生选词时的结果：保持第一次单击放下的光标 */
const KEEP_SELECTION = 'keep' as const;

/** 取文本块某一行里与点击同一水平位置的文档位置；行由该块内的一个位置及其所在侧指定 */
function posInBlockLine(view: EditorView, $anchor: ResolvedPos, side: -1 | 1, x: number): number {
  const lineCoords = view.coordsAtPos($anchor.pos, side);
  const hit = view.posAtCoords({ left: x, top: (lineCoords.top + lineCoords.bottom) / 2 });
  if (hit && view.state.doc.resolve(hit.pos).start() === $anchor.start()) return hit.pos;
  return $anchor.pos;
}

/**
 * 判断点击是否落在块间空隙里。
 * 是则按垂直距离选定上一 / 下一文本块，返回其中与点击同一水平位置的文档位置；
 * 点在文本块内或无法判定时返回 null。
 */
function resolveGapClick(view: EditorView, x: number, y: number): number | typeof KEEP_SELECTION | null {
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const { doc } = view.state;
  const $hit = doc.resolve(hit.pos);
  // 空隙里的命中位置通常落在两个块之间（不属于任何文本块），此时取其后的第一个文本块
  let $current = $hit.parent.isTextblock ? $hit : Selection.findFrom($hit, 1, true)?.$head;
  if (!$current || $current.depth === 0) return null;
  let currentRect = blockRect(view, $current.before());
  if (!currentRect) return null;
  // 命中位置也可能回落到空隙上方那一块，此时空隙下方的文本块才是浏览器原生会选中的块
  if (y > currentRect.bottom) {
    const $next = Selection.findFrom(doc.resolve($current.after()), 1, true)?.$head;
    if (!$next || $next.depth === 0) return null;
    $current = $next;
    currentRect = blockRect(view, $current.before());
    if (!currentRect) return null;
  }
  // 只处理落在当前文本块上沿之上的空隙点击，块内点击属于正常情况
  if (y >= currentRect.top) return null;

  // 文档顺序上紧邻的上一个文本块（以其末尾位置表示）
  const $prev = Selection.findFrom(doc.resolve($current.before()), -1, true)?.$head;
  if (!$prev || $prev.depth === 0) {
    // 上方没有文本块：落到当前块的第一行
    return posInBlockLine(view, doc.resolve($current.start()), 1, x);
  }
  const prevRect = blockRect(view, $prev.before());
  // 分栏等并排布局里，上一文本块可能在另一列，要求水平方向重叠
  const prevUsable = !!prevRect && x >= prevRect.left && x <= prevRect.right;
  const distToPrev = prevRect ? Math.max(0, y - prevRect.bottom) : Infinity;

  const between = blocksBetween(doc, $prev.after(), $current.before())
    .map((pos) => blockRect(view, pos))
    .filter((rect): rect is DOMRect => rect !== null);
  if (between.length > 0) {
    // 中间夹着分割线、图片、图表等块：点在这些块上交给原有逻辑（如图片双击预览）
    if (between.some((rect) => y >= rect.top && y <= rect.bottom)) return null;
    const firstTop = Math.min(...between.map((rect) => rect.top));
    const lastBottom = Math.max(...between.map((rect) => rect.bottom));
    // 上一文本块与首个非文本块之间、且离上一文本块更近：落到上一块的最后一行
    if (y < firstTop && prevUsable && distToPrev < firstTop - y) return posInBlockLine(view, $prev, -1, x);
    // 末个非文本块与当前文本块之间、且离当前块更近：落到当前块的第一行
    if (y > lastBottom && currentRect.top - y < y - lastBottom) {
      return posInBlockLine(view, doc.resolve($current.start()), 1, x);
    }
    // 其余空隙离非文本块更近：不选任何文字，避免原生选词选中段落分界
    return KEEP_SELECTION;
  }

  // 离上一块更近：落到上一块的最后一行；否则落到当前块的第一行
  if (prevUsable && distToPrev < currentRect.top - y) return posInBlockLine(view, $prev, -1, x);
  return posInBlockLine(view, doc.resolve($current.start()), 1, x);
}

/**
 * 点击是否落在某一视觉行的行尾右侧空白处。
 * 位置须处在视觉行末尾（文本块末尾、硬换行之前或软换行折行处），且点击横坐标越过了行尾光标。
 */
function isPastLineEnd(view: EditorView, $pos: ResolvedPos, x: number): boolean {
  const before = view.coordsAtPos($pos.pos, -1);
  if (x <= before.right + LINE_END_SLOP_PX) return false;
  if ($pos.pos === $pos.end() || $pos.nodeAfter?.type.name === 'hardBreak') return true;
  // 软换行折行处：同一位置向后取的光标落在下一行
  const after = view.coordsAtPos($pos.pos, 1);
  return after.top >= before.bottom - 1;
}

/** 位置是否处在某一视觉行的行首（文本块开头、硬换行之后或软换行折行处） */
function isAtLineStart(view: EditorView, $pos: ResolvedPos, afterCoords: { top: number }): boolean {
  if ($pos.pos === $pos.start() || $pos.nodeBefore?.type.name === 'hardBreak') return true;
  const before = view.coordsAtPos($pos.pos, -1);
  return afterCoords.top >= before.bottom - 1;
}

/** 文本块的纯文本（叶子内联节点用占位符代替）；与文档位置无法一一对应时返回 null */
function blockText(block: ProseMirrorNode): string | null {
  const text = block.textBetween(0, block.content.size, undefined, LEAF_PLACEHOLDER);
  return text.length === block.content.size ? text : null;
}

/**
 * 计算双击应选中的范围。
 * pastLineEnd 为真时取行尾前的最后一个词，否则取点击处字符所在的词；
 * 目标是空白、硬换行 / 图片等占位符，或文本块为空时返回折叠的光标位置。
 */
function wordRangeForClick(
  view: EditorView,
  $pos: ResolvedPos,
  x: number,
  pastLineEnd: boolean,
): { from: number; to: number } | null {
  const text = blockText($pos.parent);
  if (text === null) return null;
  const blockStart = $pos.start();
  const offset = $pos.pos - blockStart;
  const caret = { from: $pos.pos, to: $pos.pos };

  let charOffset: number;
  if (pastLineEnd) {
    charOffset = offset - 1;
  } else {
    // posAtCoords 返回最近的字符边界：点击在边界左侧说明点中的是边界前的字符，否则是边界后的字符
    const afterCoords = view.coordsAtPos($pos.pos, 1);
    charOffset = x < afterCoords.left ? offset - 1 : offset;
    // 点在视觉行行首左侧（缩进、列表符号一侧）时，边界前的字符在上一行，改取本行第一个字符
    if (charOffset < offset && isAtLineStart(view, $pos, afterCoords)) charOffset = offset;
  }
  if (charOffset < 0 || charOffset >= text.length) return caret;

  wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  const segment = wordSegmenter.segment(text).containing(charOffset);
  if (!segment) return caret;
  // 行尾的空格、硬换行、图片等不是可见文字，双击不选中它们
  if (segment.segment.includes(LEAF_PLACEHOLDER) || (pastLineEnd && !segment.segment.trim())) return caret;
  return { from: blockStart + segment.index, to: blockStart + segment.index + segment.segment.length };
}

/**
 * 处理一次双击 / 三击，已接管（并阻止了原生选词）时返回 true。
 * 三击的结果与 ProseMirror 默认三击一致（整段文字），这里接管是为了覆盖空隙点击与下文所述的事件截断。
 */
function handleMultiClick(view: EditorView, event: MouseEvent): boolean {
  // 只处理不带修饰键的左键双击 / 三击，扩选、多选等仍走原生逻辑
  if (event.button !== 0 || (event.detail !== 2 && event.detail !== 3)) return false;
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
  // 节点内的输入框（图表源码、公式等）由多行文本框的全局修正处理；按钮、图标等控件保留自身的双击行为
  if (event.target instanceof Element && event.target.closest('input, textarea, select, button, [role="button"]')) {
    return false;
  }

  const x = event.clientX;
  const gapPos = resolveGapClick(view, x, event.clientY);
  if (gapPos === KEEP_SELECTION) {
    // 阻止原生选词，保留第一次单击的光标
    event.preventDefault();
    return true;
  }
  let $pos: ResolvedPos;
  if (gapPos !== null) {
    $pos = view.state.doc.resolve(gapPos);
  } else {
    const hit = view.posAtCoords({ left: x, top: event.clientY });
    if (!hit) return false;
    $pos = view.state.doc.resolve(hit.pos);
    if (!$pos.parent.isTextblock) return false;
  }

  let range: { from: number; to: number } | null;
  if (event.detail === 3) {
    // 三击：只选中整段文字，不含段落分界
    range = { from: $pos.start(), to: $pos.end() };
  } else {
    const pastLineEnd = isPastLineEnd(view, $pos, x);
    // 点在文字上的双击交给原生选词
    if (gapPos === null && !pastLineEnd) return false;
    range = wordRangeForClick(view, $pos, x, pastLineEnd);
  }
  if (!range) return false;

  // 阻止浏览器原生选区越过段落边界
  event.preventDefault();
  const { tr } = view.state;
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, range.from, range.to)).setMeta('pointer', true));
  if (!view.hasFocus()) view.focus();
  return true;
}

/** 已在捕获阶段接管的事件：冒泡到 ProseMirror 时跳过其默认处理，避免默认三击按原生命中结果覆盖选区 */
const handledEvents = new WeakSet<Event>();

export const MultiClickSelectionFix = Extension.create({
  name: 'multiClickSelectionFix',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        // 在编辑器根节点的捕获阶段处理：高亮块、折叠块等 React 节点视图渲染在 portal 中，
        // 外层 React 组件阻止冒泡（如多维表格长文本弹层的 onMouseDown stopPropagation）时，
        // 原生事件会在 portal 容器处被截断，ProseMirror 在冒泡阶段收不到 mousedown
        view(view) {
          const onMouseDown = (event: MouseEvent) => {
            if (handleMultiClick(view, event)) handledEvents.add(event);
          };
          view.dom.addEventListener('mousedown', onMouseDown, true);
          return {
            destroy() {
              view.dom.removeEventListener('mousedown', onMouseDown, true);
            },
          };
        },
        props: {
          handleDOMEvents: {
            mousedown: (_view, event) => handledEvents.has(event),
          },
        },
      }),
    ];
  },
});
