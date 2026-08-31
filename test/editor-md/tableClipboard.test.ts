// NoteBoard Markdown 表格剪贴板增强单元测试
// 验证表格多选单元格复制输出 TSV（同行不同列以 \t 分隔在同一行，不同行以 \n 换行，无多余空行）
// 验证表格二维数据粘贴与平铺填充

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import { CellSelection } from '@tiptap/pm/tables';
import { Slice, Fragment } from '@tiptap/pm/model';
import {
  serializeTableSliceToTSV,
  customClipboardTextSerializer,
  tileMatrix,
  matrixToPastedCells,
  applyTablePaste,
  TableClipboard,
} from '../../src/features/editor-md/tableClipboard';

const activeEditors: Editor[] = [];

function createTableEditor(): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit,
      TableClipboard,
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      Markdown,
    ],
    content: `
      <table>
        <tr>
          <th>H1</th>
          <th>H2</th>
          <th>H3</th>
        </tr>
        <tr>
          <td>A1</td>
          <td>B1</td>
          <td>C1</td>
        </tr>
        <tr>
          <td>A2</td>
          <td>B2</td>
          <td>C2</td>
        </tr>
      </table>
    `,
  });
  activeEditors.push(editor);
  return editor;
}

afterEach(() => {
  while (activeEditors.length > 0) {
    const ed = activeEditors.pop();
    ed?.destroy();
  }
});

describe('Markdown 表格剪贴板复制序列化 (Table Clipboard Copy TSV)', () => {
  it('平铺矩阵工具函数 tileMatrix 应正确平铺矩阵', () => {
    const src = [
      ['A', 'B'],
      ['C', 'D'],
    ];
    // 2x2 -> 2x2
    expect(tileMatrix(src, 2, 2)).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    // 1x1 -> 2x3
    expect(tileMatrix([['X']], 2, 3)).toEqual([
      ['X', 'X', 'X'],
      ['X', 'X', 'X'],
    ]);
    // 1x2 -> 3x2
    expect(tileMatrix([['A', 'B']], 3, 2)).toEqual([
      ['A', 'B'],
      ['A', 'B'],
      ['A', 'B'],
    ]);
  });

  it('多选 2x2 单元格时，复制切片应序列化为单换行 \\n 与制表符 \\t 的 TSV 结构（无空行）', () => {
    const editor = createTableEditor();
    const doc = editor.state.doc;

    // 查找 A1(第二行第一列) 与 B2(第三行第二列) 单元格位置
    let anchorPos: number | null = null;
    let headPos: number | null = null;

    doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') {
        if (node.textContent === 'A1') anchorPos = pos;
        if (node.textContent === 'B2') headPos = pos;
      }
    });

    expect(anchorPos).not.toBeNull();
    expect(headPos).not.toBeNull();

    // 设置 2x2 的 CellSelection (覆盖 A1, B1, A2, B2)
    const sel = new CellSelection(doc.resolve(anchorPos!), doc.resolve(headPos!));
    editor.view.dispatch(editor.state.tr.setSelection(sel));

    // 获取 CellSelection 的切片内容
    const slice = sel.content();
    const tsv = serializeTableSliceToTSV(slice);

    // 期望输出：
    // 第一行: "A1\tB1"
    // 第二行: "A2\tB2"
    // 整体以 "\n" 连接，中间没有任何多余空行 "\n\n"
    expect(tsv).toBe('A1\tB1\nA2\tB2');

    // 通过 customClipboardTextSerializer 调用也应一致
    const serialized = customClipboardTextSerializer(slice, editor.view);
    expect(serialized).toBe('A1\tB1\nA2\tB2');
  });

  it('复制整表时，表头与数据行应输出规范的 TSV 文本', () => {
    const editor = createTableEditor();
    const doc = editor.state.doc;

    let tableNodePos: number | null = null;
    doc.descendants((node, pos) => {
      if (node.type.name === 'table') {
        tableNodePos = pos;
      }
    });

    expect(tableNodePos).not.toBeNull();
    const tableNode = doc.nodeAt(tableNodePos!)!;
    const tableSlice = new Slice(Fragment.from(tableNode), 0, 0);

    const tsv = serializeTableSliceToTSV(tableSlice);
    expect(tsv).toBe('H1\tH2\tH3\nA1\tB1\tC1\nA2\tB2\tC2');
  });

  it('普通段落文本不应被误转为表格 TSV，应保留默认序列化', () => {
    const editor = new Editor({
      extensions: [StarterKit, TableClipboard],
      content: '<p>Hello World</p><p>Line 2</p>',
    });
    activeEditors.push(editor);

    editor.commands.selectAll();
    const slice = editor.state.selection.content();
    const tsv = serializeTableSliceToTSV(slice);
    expect(tsv).toBeNull();

    const serialized = customClipboardTextSerializer(slice, editor.view);
    expect(serialized).toBe('Hello World\n\nLine 2');
  });
});

describe('Markdown 表格剪贴板粘贴与填充 (Table Clipboard Paste)', () => {
  it('matrixToPastedCells 应正确生成包含 tableRow 和 tableCell 的 ProseMirror 切片', () => {
    const editor = createTableEditor();
    const matrix = [
      ['X1', 'Y1'],
      ['X2', 'Y2'],
    ];
    const cells = matrixToPastedCells(editor.schema, matrix);

    expect(cells.width).toBe(2);
    expect(cells.height).toBe(2);
    expect(cells.rows.length).toBe(2);
    expect(cells.rows[0].childCount).toBe(2);
    expect(cells.rows[0].child(0).textContent).toBe('X1');
    expect(cells.rows[0].child(1).textContent).toBe('Y1');
    expect(cells.rows[1].child(0).textContent).toBe('X2');
    expect(cells.rows[1].child(1).textContent).toBe('Y2');
  });

  it('向表格多选 2x2 区域粘贴 2x2 TSV 数据时，应准确填入各个单元格', () => {
    const editor = createTableEditor();
    const doc = editor.state.doc;

    let anchorPos: number | null = null;
    let headPos: number | null = null;

    doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') {
        if (node.textContent === 'A1') anchorPos = pos;
        if (node.textContent === 'B2') headPos = pos;
      }
    });

    const sel = new CellSelection(doc.resolve(anchorPos!), doc.resolve(headPos!));
    editor.view.dispatch(editor.state.tr.setSelection(sel));

    // 执行表格粘贴
    const pasteText = 'NewA1\tNewB1\nNewA2\tNewB2';
    const success = applyTablePaste(editor, pasteText);
    expect(success).toBe(true);

    // 验证粘贴后对应单元格的内容
    const updatedDoc = editor.state.doc;
    const cellTexts: string[] = [];
    updatedDoc.descendants((node) => {
      if (node.type.name === 'tableCell') {
        cellTexts.push(node.textContent);
      }
    });

    // 原表格共有 6 个 tableCell: [A1, B1, C1, A2, B2, C2]
    // 替换 A1, B1, A2, B2 后应为 [NewA1, NewB1, C1, NewA2, NewB2, C2]
    expect(cellTexts).toEqual(['NewA1', 'NewB1', 'C1', 'NewA2', 'NewB2', 'C2']);
  });

  it('向表格多选 2x2 区域粘贴 1x1 文本时，应自动平铺填满 2x2 区域', () => {
    const editor = createTableEditor();
    const doc = editor.state.doc;

    let anchorPos: number | null = null;
    let headPos: number | null = null;

    doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') {
        if (node.textContent === 'A1') anchorPos = pos;
        if (node.textContent === 'B2') headPos = pos;
      }
    });

    const sel = new CellSelection(doc.resolve(anchorPos!), doc.resolve(headPos!));
    editor.view.dispatch(editor.state.tr.setSelection(sel));

    // 粘贴单个值 "Filled"
    const success = applyTablePaste(editor, 'Filled');
    expect(success).toBe(true);

    const updatedDoc = editor.state.doc;
    const cellTexts: string[] = [];
    updatedDoc.descendants((node) => {
      if (node.type.name === 'tableCell') {
        cellTexts.push(node.textContent);
      }
    });

    expect(cellTexts).toEqual(['Filled', 'Filled', 'C1', 'Filled', 'Filled', 'C2']);
  });

  it('在单元格内粘贴多行纯文本 (换行分隔) 时，应纵向填入多行单元格而不是在单格内堆叠空行', () => {
    const editor = createTableEditor();
    const doc = editor.state.doc;

    let cellPos: number | null = null;
    doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell' && node.textContent === 'A1') {
        // 定位在 A1 单元格内部
        cellPos = pos + 2;
      }
    });

    expect(cellPos).not.toBeNull();
    editor.commands.setTextSelection(cellPos!);

    // 粘贴两行文本 "Row1\nRow2"
    const success = applyTablePaste(editor, 'Row1\nRow2');
    expect(success).toBe(true);

    const updatedDoc = editor.state.doc;
    const cellTexts: string[] = [];
    updatedDoc.descendants((node) => {
      if (node.type.name === 'tableCell') {
        cellTexts.push(node.textContent);
      }
    });

    // A1 变为 Row1，下一行的 A2 变为 Row2
    expect(cellTexts).toEqual(['Row1', 'B1', 'C1', 'Row2', 'B2', 'C2']);
  });
});
