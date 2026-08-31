// NoteBoard Markdown 编辑器表格剪贴板增强模块
// 1. 复制多选单元格时，按多维表格 / Excel 标准输出 TSV（同行不同列以 \t 分隔在同一行，不同行以单个 \n 换行，去除多余空行）
// 2. 粘贴时解析剪贴板二维数据矩阵并自动填入多选单元格或按尺寸扩展填充

import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Slice, Fragment, type Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  CellSelection,
  TableMap,
  isInTable,
  selectionCell,
  tableNodeTypes,
  __clipCells,
  __insertCells,
  __pastedCells,
} from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { parseClipboardMatrix } from '../bitable/bitableUtils';

export const tableClipboardPluginKey = new PluginKey('tableClipboard');

/**
 * 提取单元格节点的纯文本内容，将内部多余换行与制表符规整化
 */
function extractCellPlainText(cellNode: ProseMirrorNode): string {
  const parts: string[] = [];
  cellNode.forEach((child) => {
    parts.push(child.textContent || '');
  });
  // 单元格内多个段落以空格连接，去除制表符与回车换行，避免破坏 TSV 结构
  return parts.join(' ').replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * 将包含表格节点或单元格选区的 ProseMirror Slice 序列化为标准 TSV 纯文本
 * - 同一行中不同列的单元格用 Tab (\t) 分隔（仍在同一行）
 * - 不同行之间用单换行 (\n) 分隔（无多余空行）
 * - 如果不是表格切片，返回 null 以回退到默认序列化行为
 */
export function serializeTableSliceToTSV(slice: Slice): string | null {
  const content = slice.content;
  if (!content || content.childCount === 0) return null;

  const rows: string[][] = [];

  const processRowNode = (rowNode: ProseMirrorNode) => {
    const rowCells: string[] = [];
    rowNode.forEach((cellNode) => {
      const role = cellNode.type.spec.tableRole;
      if (
        role === 'cell' ||
        role === 'header_cell' ||
        cellNode.type.name === 'tableCell' ||
        cellNode.type.name === 'tableHeader'
      ) {
        rowCells.push(extractCellPlainText(cellNode));
      }
    });
    rows.push(rowCells);
  };

  let isTableSlice = false;

  // 情况 1：切片顶层是单个 table 节点
  if (
    content.childCount === 1 &&
    (content.child(0).type.name === 'table' || content.child(0).type.spec.tableRole === 'table')
  ) {
    isTableSlice = true;
    const tableNode = content.child(0);
    tableNode.forEach((rowNode) => {
      if (rowNode.type.name === 'tableRow' || rowNode.type.spec.tableRole === 'row') {
        processRowNode(rowNode);
      }
    });
  } else {
    // 情况 2：CellSelection 生成的切片，顶层是一组 tableRow 节点
    let allRows = true;
    content.forEach((node) => {
      if (node.type.name === 'tableRow' || node.type.spec.tableRole === 'row') {
        processRowNode(node);
      } else {
        allRows = false;
      }
    });

    if (rows.length > 0 && allRows) {
      isTableSlice = true;
    } else {
      // 情况 3：切片顶层是一组孤立的 tableCell 节点
      let allCells = true;
      const singleRowCells: string[] = [];
      content.forEach((node) => {
        const role = node.type.spec.tableRole;
        if (
          role === 'cell' ||
          role === 'header_cell' ||
          node.type.name === 'tableCell' ||
          node.type.name === 'tableHeader'
        ) {
          singleRowCells.push(extractCellPlainText(node));
        } else {
          allCells = false;
        }
      });
      if (singleRowCells.length > 0 && allCells) {
        rows.push(singleRowCells);
        isTableSlice = true;
      }
    }
  }

  if (!isTableSlice || rows.length === 0) {
    return null;
  }

  // 同一行不同列以 \t 分隔在同一行中，不同行之间以单换行 \n 隔开
  return rows.map((row) => row.join('\t')).join('\n');
}

/**
 * 自定义剪贴板文本序列化器
 * 当复制内容包含表格节点或单元格选区时，以多维表格 / TSV 格式序列化；其余文本保持默认逻辑
 */
export function customClipboardTextSerializer(slice: Slice, _view?: EditorView): string {
  const tableTSV = serializeTableSliceToTSV(slice);
  if (tableTSV !== null) {
    return tableTSV;
  }

  // 检查是否包含混合文档内容（段落 + 表格 + 段落等）
  let containsTable = false;
  slice.content.forEach((node) => {
    if (node.type.name === 'table' || node.type.spec.tableRole === 'table') {
      containsTable = true;
    }
  });

  if (containsTable) {
    const blocks: string[] = [];
    slice.content.forEach((node) => {
      if (node.type.name === 'table' || node.type.spec.tableRole === 'table') {
        const tsv = serializeTableSliceToTSV(new Slice(Fragment.from(node), 0, 0));
        if (tsv !== null) {
          blocks.push(tsv);
          return;
        }
      }
      blocks.push(node.textContent);
    });
    return blocks.join('\n\n');
  }

  // 普通选区回退至 ProseMirror 默认行为
  return slice.content.textBetween(0, slice.content.size, '\n\n');
}

/**
 * 将源二维矩阵平铺/扩展到目标尺寸
 */
export function tileMatrix(matrix: string[][], targetRows: number, targetCols: number): string[][] {
  const srcRows = matrix.length;
  const srcCols = matrix[0]?.length || 1;
  if (srcRows === 0 || srcCols === 0) return matrix;

  const result: string[][] = [];
  for (let r = 0; r < targetRows; r += 1) {
    const row: string[] = [];
    for (let c = 0; c < targetCols; c += 1) {
      const val = matrix[r % srcRows]?.[c % srcCols] ?? '';
      row.push(val);
    }
    result.push(row);
  }
  return result;
}

/**
 * 将二维字符串矩阵转换为 ProseMirror 的 tableRow / tableCell 切片结构
 */
export function matrixToPastedCells(
  schema: Schema,
  matrix: string[][]
): { width: number; height: number; rows: Fragment[] } {
  const types = tableNodeTypes(schema);
  const cellType = types.cell;
  const paragraphType = schema.nodes.paragraph;

  const height = matrix.length;
  let width = 0;
  for (let r = 0; r < height; r += 1) {
    width = Math.max(width, matrix[r]?.length ?? 0);
  }
  if (width === 0) width = 1;

  const rows: Fragment[] = [];
  for (let r = 0; r < height; r += 1) {
    const rowCells: ProseMirrorNode[] = [];
    for (let c = 0; c < width; c += 1) {
      const val = matrix[r]?.[c] ?? '';
      const textNode = val ? schema.text(val) : null;
      const paragraphNode = paragraphType.create(null, textNode);
      const cellNode =
        cellType.createAndFill(null, paragraphNode) || cellType.create(null, paragraphNode);
      rowCells.push(cellNode);
    }
    rows.push(Fragment.from(rowCells));
  }

  return {
    width,
    height,
    rows,
  };
}

/**
 * 执行表格区域内的二维矩阵粘贴插入
 */
export function executeTableMatrixPaste(
  view: EditorView,
  matrix: string[][],
  pmCells?: { width: number; height: number; rows: Fragment[] } | null
): boolean {
  const sel = view.state.selection;

  // 1. 如果已有 ProseMirror 原生解析好的表格切片（例如包含完整 PM 元数据的内部复制）
  if (pmCells) {
    if (sel instanceof CellSelection) {
      const table = sel.$anchorCell.node(-1);
      const start = sel.$anchorCell.start(-1);
      const map = TableMap.get(table);
      const rect = map.rectBetween(sel.$anchorCell.pos - start, sel.$headCell.pos - start);
      const isSingleCell = sel.$anchorCell.pos === sel.$headCell.pos;

      const cellsToInsert = isSingleCell
        ? pmCells
        : __clipCells(pmCells, rect.right - rect.left, rect.bottom - rect.top);

      __insertCells(view.state, view.dispatch, start, rect, cellsToInsert);
      return true;
    }

    const $cell = selectionCell(view.state);
    const start = $cell.start(-1);
    const map = TableMap.get($cell.node(-1));
    __insertCells(view.state, view.dispatch, start, map.findCell($cell.pos - start), pmCells);
    return true;
  }

  // 2. 二维纯文本矩阵粘贴
  if (!matrix || matrix.length === 0) return false;

  const mRows = matrix.length;
  const mCols = matrix[0]?.length || 1;

  if (sel instanceof CellSelection) {
    const table = sel.$anchorCell.node(-1);
    const start = sel.$anchorCell.start(-1);
    const map = TableMap.get(table);
    const rect = map.rectBetween(sel.$anchorCell.pos - start, sel.$headCell.pos - start);

    const selRows = rect.bottom - rect.top;
    const selCols = rect.right - rect.left;
    const isSingleCell = sel.$anchorCell.pos === sel.$headCell.pos;

    // 单格选区直接按矩阵尺寸填入，多选区域按选区尺寸平铺
    const targetRows = isSingleCell ? mRows : selRows;
    const targetCols = isSingleCell ? mCols : selCols;

    const finalMatrix = isSingleCell ? matrix : tileMatrix(matrix, targetRows, targetCols);
    const cells = matrixToPastedCells(view.state.schema, finalMatrix);

    __insertCells(view.state, view.dispatch, start, rect, cells);
    return true;
  }

  // 光标在普通单元格内（TextSelection）
  if (mRows > 1 || mCols > 1) {
    const $cell = selectionCell(view.state);
    const start = $cell.start(-1);
    const map = TableMap.get($cell.node(-1));
    const cellRect = map.findCell($cell.pos - start);
    const cells = matrixToPastedCells(view.state.schema, matrix);

    __insertCells(view.state, view.dispatch, start, cellRect, cells);
    return true;
  }

  // 单行单列普通文本：回退至默认行内光标插入
  return false;
}

/**
 * 拦截粘贴事件并增强表格粘贴
 */
export function handleTablePaste(view: EditorView, event: ClipboardEvent, slice: Slice): boolean {
  if (!isInTable(view.state)) return false;

  // 优先检查是否带有 ProseMirror 原生结构
  const pmCells = __pastedCells(slice);
  const text = event.clipboardData?.getData('text/plain') ?? '';

  if (pmCells) {
    return executeTableMatrixPaste(view, [], pmCells);
  }

  if (!text) return false;

  const matrix = parseClipboardMatrix(text);
  if (!matrix || matrix.length === 0) return false;

  return executeTableMatrixPaste(view, matrix, null);
}

/**
 * 供右键菜单或外部命令调用的表格粘贴方法
 */
export function applyTablePaste(editor: Editor, text: string): boolean {
  if (!isInTable(editor.state) || !text) return false;

  const matrix = parseClipboardMatrix(text);
  if (!matrix || matrix.length === 0) return false;

  return executeTableMatrixPaste(editor.view, matrix, null);
}

/**
 * TipTap 表格剪贴板增强扩展
 * 高优先级拦截复制序列化与表格粘贴
 */
export const TableClipboard = Extension.create({
  name: 'tableClipboard',
  priority: 100,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: tableClipboardPluginKey,
        props: {
          clipboardTextSerializer: (slice, view) => {
            return customClipboardTextSerializer(slice, view);
          },
          handlePaste: (view, event, slice) => {
            return handleTablePaste(view, event, slice);
          },
        },
      }),
    ];
  },
});
