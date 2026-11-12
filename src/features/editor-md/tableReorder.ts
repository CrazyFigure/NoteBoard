// 表格行 / 列重排内核
// 拖动把手松手后执行：只替换表格内部的行节点（表格节点与其视图保持不变），
// Markdown 表格首行固定为表头，行移动后自动修正表头 / 正文单元格类型；
// 光标或单元格选区跟随原单元格移动到新位置。

import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';

export type TableAxis = 'row' | 'column';

/** 表格是否可按行列整体重排：存在合并单元格时行列边界不成矩形，不支持拖动 */
export function isTableReorderable(table: ProseMirrorNode): boolean {
  if (table.type.spec.tableRole !== 'table' || table.childCount === 0) return false;
  let width = -1;
  let ok = true;
  table.forEach((row) => {
    if (!ok) return;
    row.forEach((cell) => {
      if ((cell.attrs.colspan ?? 1) !== 1 || (cell.attrs.rowspan ?? 1) !== 1) ok = false;
    });
    // 行宽不一致（结构待修复）时同样不处理
    if (width >= 0 && row.childCount !== width) ok = false;
    width = row.childCount;
  });
  return ok && width > 0;
}

/** 将 from 处的元素移到 to 处后的新顺序（返回原下标序列） */
export function reorderIndexes(length: number, from: number, to: number): number[] {
  const order = Array.from({ length }, (_, index) => index);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return order;
}

/** 单元格是否为表头单元格 */
function isHeaderCell(cell: ProseMirrorNode): boolean {
  return cell.type.spec.tableRole === 'header_cell';
}

/** 以指定类型重建单元格（内容与属性不变） */
function withCellType(cell: ProseMirrorNode, header: boolean): ProseMirrorNode {
  if (isHeaderCell(cell) === header) return cell;
  const nodes = cell.type.schema.nodes;
  const type = header ? nodes.tableHeader : nodes.tableCell;
  return type ? type.create(cell.attrs, cell.content, cell.marks) : cell;
}

/** 选区端点在表格中的逻辑位置：单元格行列号与单元格内偏移 */
interface CellPoint {
  row: number;
  col: number;
  offset: number;
}

function locate(map: TableMap, tableStart: number, table: ProseMirrorNode, pos: number): CellPoint | null {
  if (pos < tableStart || pos > tableStart + table.content.size) return null;
  for (let index = 0; index < map.map.length; index++) {
    const cellPos = tableStart + map.map[index];
    const cell = table.nodeAt(map.map[index]);
    if (!cell) continue;
    if (pos > cellPos && pos < cellPos + cell.nodeSize) {
      return { row: Math.floor(index / map.width), col: index % map.width, offset: pos - cellPos };
    }
  }
  return null;
}

/**
 * 生成移动表格行或列的事务
 * @param tablePos 表格节点的起始位置
 * @param from 原行 / 列下标
 * @param to 目标下标（移除原元素后的插入位置，即移动完成后它所在的下标）
 */
export function moveTableAxisTr(
  state: EditorState,
  tablePos: number,
  axis: TableAxis,
  from: number,
  to: number,
): Transaction | null {
  const table = state.doc.nodeAt(tablePos);
  if (!table || !isTableReorderable(table) || from === to) return null;
  const rowCount = table.childCount;
  const colCount = table.firstChild!.childCount;
  const length = axis === 'row' ? rowCount : colCount;
  if (from < 0 || to < 0 || from >= length || to >= length) return null;

  const order = reorderIndexes(length, from, to);
  const rows: ProseMirrorNode[] = [];
  table.forEach((row) => rows.push(row));
  // Markdown 表格首行即表头：首行全是表头单元格时，移动后保持「首行表头、其余正文」
  const headerRow = rows[0].childCount > 0 && rows[0].content.content.every(isHeaderCell);

  let nextRows: ProseMirrorNode[];
  if (axis === 'row') {
    nextRows = order.map((source, index) => {
      const row = rows[source];
      if (!headerRow || (source === 0) === (index === 0)) return row;
      const cells: ProseMirrorNode[] = [];
      row.forEach((cell) => cells.push(withCellType(cell, index === 0)));
      return row.type.create(row.attrs, Fragment.from(cells), row.marks);
    });
  } else {
    nextRows = rows.map((row) => {
      const cells: ProseMirrorNode[] = [];
      row.forEach((cell) => cells.push(cell));
      return row.type.create(row.attrs, Fragment.from(order.map((source) => cells[source])), row.marks);
    });
  }

  // 记录选区端点所在的逻辑单元格，移动后按新下标还原
  const oldMap = TableMap.get(table);
  const tableStart = tablePos + 1;
  const inverse = new Map(order.map((source, index) => [source, index]));
  const mapPoint = (point: CellPoint | null): CellPoint | null => {
    if (!point) return null;
    return axis === 'row'
      ? { ...point, row: inverse.get(point.row)! }
      : { ...point, col: inverse.get(point.col)! };
  };
  const { selection } = state;
  const anchorPoint = mapPoint(locate(oldMap, tableStart, table, selection instanceof CellSelection ? selection.$anchorCell.pos + 1 : selection.anchor));
  const headPoint = mapPoint(locate(oldMap, tableStart, table, selection instanceof CellSelection ? selection.$headCell.pos + 1 : selection.head));

  const tr = state.tr.replaceWith(tableStart, tableStart + table.content.size, nextRows);
  const nextTable = tr.doc.nodeAt(tablePos)!;
  const nextMap = TableMap.get(nextTable);
  const cellPos = (point: CellPoint) => tableStart + nextMap.map[point.row * nextMap.width + point.col];

  if (selection instanceof CellSelection && anchorPoint && headPoint) {
    tr.setSelection(CellSelection.create(tr.doc, cellPos(anchorPoint), cellPos(headPoint)));
  } else if (anchorPoint && headPoint) {
    tr.setSelection(TextSelection.create(tr.doc, cellPos(anchorPoint) + anchorPoint.offset, cellPos(headPoint) + headPoint.offset));
  } else if (anchorPoint || headPoint) {
    // 选区只有一端在表格内：收拢到表格内那一端
    const point = (headPoint ?? anchorPoint)!;
    tr.setSelection(Selection.near(tr.doc.resolve(cellPos(point) + point.offset)));
  }
  return tr;
}

/** 选中整行 / 整列（单击把手） */
export function selectTableAxisTr(
  state: EditorState,
  tablePos: number,
  axis: TableAxis,
  index: number,
): Transaction | null {
  const table = state.doc.nodeAt(tablePos);
  if (!table || !isTableReorderable(table)) return null;
  const map = TableMap.get(table);
  const tableStart = tablePos + 1;
  const length = axis === 'row' ? map.height : map.width;
  if (index < 0 || index >= length) return null;
  const first = axis === 'row' ? index * map.width : index;
  const last = axis === 'row' ? index * map.width + map.width - 1 : (map.height - 1) * map.width + index;
  const $anchor = state.doc.resolve(tableStart + map.map[first]);
  const $head = state.doc.resolve(tableStart + map.map[last]);
  const selection = axis === 'row' ? CellSelection.rowSelection($anchor, $head) : CellSelection.colSelection($anchor, $head);
  return state.tr.setSelection(selection);
}
