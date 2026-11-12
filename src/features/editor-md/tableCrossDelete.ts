// 跨表格边界的文本选区删除
//
// 问题：从表格首个单元格拖选到表格下方段落（或反向）后按 Backspace，
// ProseMirror 的 deleteSelection 无法把单元格与表格外的段落合并，只能保留起点一侧的开放结构，
// 结果残留一个只有一格的空表格；选区从表格中间开始时还会删掉部分单元格，表格结构被打乱。
// 选区高亮（selectionHighlight.ts）把完整覆盖的表格画成整块底板，语义是「删除时整块消失」，删除结果与之不符。
//
// 方案：选区一端在表格内、另一端在表格外时接管删除——
// · 表格被完整覆盖（端点落在首格开头 / 末格结尾）：整张表格删除；
// · 表格只被部分覆盖：只清空被覆盖单元格的内容，表格结构保持不变；
// · 表格外的部分按普通删除处理；删除后没有可放光标的文本块时补一个空段落。

import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';
import { Plugin, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

/** 待执行的删除 / 清空操作；按位置从后往前执行，互不影响位置 */
interface DeleteOp {
  from: number;
  to: number;
  /** 清空单元格：用空段落替换其全部内容 */
  clearCell?: boolean;
}

/** 选区端点所在、且不包含另一端点的最外层表格深度 */
function crossingTableDepth($pos: ResolvedPos, sharedDepth: number): number | null {
  for (let depth = sharedDepth + 1; depth <= $pos.depth; depth++) {
    if ($pos.node(depth).type.spec.tableRole === 'table') return depth;
  }
  return null;
}

/** 表格内所有单元格（文档顺序）的起始位置与节点 */
function tableCells(table: ProseMirrorNode, tablePos: number): { pos: number; node: ProseMirrorNode }[] {
  const cells: { pos: number; node: ProseMirrorNode }[] = [];
  table.descendants((node, pos) => {
    const role = node.type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') {
      cells.push({ pos: tablePos + 1 + pos, node });
      return false;
    }
    return true;
  });
  return cells;
}

/** 单元格内容是否已为空（仅含一个空段落），空单元格无需再清空 */
function isEmptyCell(cell: ProseMirrorNode): boolean {
  return cell.childCount === 1 && cell.firstChild!.isTextblock && cell.firstChild!.content.size === 0;
}

/**
 * 选区起点所在表格：完整覆盖时返回删除边界（表格起点），部分覆盖时清空起点之后的单元格并返回表格终点
 */
function planFromSide(doc: ProseMirrorNode, $from: ResolvedPos, depth: number, ops: DeleteOp[]): number {
  const tablePos = $from.before(depth);
  const table = $from.node(depth);
  const first = Selection.findFrom(doc.resolve(tablePos), 1, true);
  // 起点位于首格开头：表格被完整选中
  if (first && $from.pos <= first.from) return tablePos;

  for (const cell of tableCells(table, tablePos)) {
    const cellEnd = cell.pos + cell.node.nodeSize;
    if (cellEnd <= $from.pos) continue;
    if (cell.pos < $from.pos) {
      // 起点所在单元格：删除起点到单元格内容末尾
      ops.push({ from: $from.pos, to: cellEnd - 1 });
    } else if (!isEmptyCell(cell.node)) {
      ops.push({ from: cell.pos + 1, to: cellEnd - 1, clearCell: true });
    }
  }
  return $from.after(depth);
}

/**
 * 选区终点所在表格：完整覆盖时返回删除边界（表格终点），部分覆盖时清空终点之前的单元格并返回表格起点
 */
function planToSide(doc: ProseMirrorNode, $to: ResolvedPos, depth: number, ops: DeleteOp[]): number {
  const tableEnd = $to.after(depth);
  const table = $to.node(depth);
  const last = Selection.findFrom(doc.resolve(tableEnd), -1, true);
  // 终点位于末格结尾：表格被完整选中
  if (last && $to.pos >= last.to) return tableEnd;

  const tablePos = $to.before(depth);
  for (const cell of tableCells(table, tablePos)) {
    if (cell.pos >= $to.pos) break;
    const cellEnd = cell.pos + cell.node.nodeSize;
    if (cellEnd > $to.pos) {
      // 终点所在单元格：删除单元格内容开头到终点
      ops.push({ from: cell.pos + 1, to: $to.pos });
    } else if (!isEmptyCell(cell.node)) {
      ops.push({ from: cell.pos + 1, to: cellEnd - 1, clearCell: true });
    }
  }
  return tablePos;
}

/**
 * 删除跨越表格边界的文本选区；选区不涉及表格边界时返回 null，交由默认删除处理
 */
export function deleteSelectionAcrossTables(state: EditorState): Transaction | null {
  const { selection, doc, schema } = state;
  if (!(selection instanceof TextSelection) || selection.empty) return null;

  const { $from, $to } = selection;
  const sharedDepth = $from.sharedDepth($to.pos);
  const fromDepth = crossingTableDepth($from, sharedDepth);
  const toDepth = crossingTableDepth($to, sharedDepth);
  if (fromDepth === null && toDepth === null) return null;

  const ops: DeleteOp[] = [];
  const cutFrom = fromDepth === null ? $from.pos : planFromSide(doc, $from, fromDepth, ops);
  const cutTo = toDepth === null ? $to.pos : planToSide(doc, $to, toDepth, ops);
  if (cutFrom < cutTo) ops.push({ from: cutFrom, to: cutTo });

  const tr = state.tr;
  const paragraph = schema.nodes.paragraph;
  // 从后往前执行，前面操作的位置不受影响
  ops.sort((a, b) => b.from - a.from);
  for (const op of ops) {
    if (op.from >= op.to) continue;
    if (op.clearCell) {
      tr.replaceWith(op.from, op.to, paragraph.create());
      continue;
    }
    let $start = tr.doc.resolve(op.from);
    let $end = tr.doc.resolve(op.to);
    // 一端是表格边界、另一端恰在文本块首 / 尾：该文本块被完整选中，扩展为整块，统一走下方「整块删除」
    if (!$start.parent.isTextblock && $end.parent.isTextblock && $end.depth - 1 === $start.depth
      && $end.parentOffset === $end.parent.content.size) {
      $end = tr.doc.resolve($end.after());
    } else if (!$end.parent.isTextblock && $start.parent.isTextblock && $start.depth - 1 === $end.depth
      && $start.parentOffset === 0) {
      $start = tr.doc.resolve($start.before());
    }
    const index = $start.index();
    const endIndex = $end.index();
    // 删除的是同一父节点下的若干完整块：原处补一个空段落，光标有处可放（与删除文字后留下空行一致）
    if (
      $start.depth === $end.depth
      && $start.sameParent($end)
      && $start.pos === $start.posAtIndex(index)
      && $end.pos === $end.posAtIndex(endIndex)
      && $start.parent.canReplaceWith(index, endIndex, paragraph)
    ) {
      tr.replaceWith($start.pos, $end.pos, paragraph.create());
    } else {
      tr.delete($start.pos, $end.pos);
    }
  }

  // 光标停在选区起点（经映射）附近最近的文本位置
  const anchor = tr.mapping.map(selection.from, -1);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(anchor, tr.doc.content.size)), 1));
  return tr.scrollIntoView();
}

/** 跨表格选区的删除、剪切与输入替换 */
export const TableCrossDelete = Extension.create({
  name: 'tableCrossDelete',
  // 高于默认键位（含表格单元格选区删除），只接管跨表格边界的文本选区，其余情况原样放行
  priority: 1001,

  addKeyboardShortcuts() {
    const run = () => {
      const tr = deleteSelectionAcrossTables(this.editor.state);
      if (!tr) return false;
      this.editor.view.dispatch(tr);
      return true;
    };
    return {
      Backspace: run,
      Delete: run,
      'Mod-Backspace': run,
      'Mod-Delete': run,
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          // 直接输入替换选区：先按跨表格规则删除，再在光标处插入文字
          handleTextInput(view, _from, _to, text) {
            const tr = deleteSelectionAcrossTables(view.state);
            if (!tr) return false;
            view.dispatch(tr.insertText(text, tr.selection.from));
            return true;
          },
          handleKeyDown(view, event) {
            // 输入法开始组合前（keyCode 229）先删除选区，避免浏览器原生删除留下残缺表格；不拦截按键，组合照常进行
            if (event.keyCode !== 229 || event.isComposing) return false;
            const tr = deleteSelectionAcrossTables(view.state);
            if (tr) view.dispatch(tr);
            return false;
          },
        },
      }),
    ];
  },
});
