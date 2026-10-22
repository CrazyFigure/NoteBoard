// 验证真实 VisualKernel 与表格插件的粘贴顺序，防止 Excel 的预览图片抢占单元格数据。
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import { CellSelection } from '@tiptap/pm/tables';
import { VisualKernel } from '@/features/editor-md/VisualKernel';
import { TableClipboard } from '@/features/editor-md/tableClipboard';
import { handlePastedImageFile } from '@/features/editor-md/imagePaste';

// 只裁掉无关浮层与扩展，保留真实 React 内核、ProseMirror 粘贴链路和表格插件。
vi.mock('@/features/editor-md/extensions', () => ({
  buildExtensions: () => [StarterKit, TableClipboard, Table, TableRow, TableCell, TableHeader, Markdown],
}));
vi.mock('@/features/editor-md/bubbleMenu', () => ({ EditorBubbleMenu: () => null, TableToolbar: () => null }));
vi.mock('@/features/editor-md/blockDragHandle', () => ({ BlockDragHandle: () => null }));
vi.mock('@/features/editor-md/PasteFormatPrompt', () => ({ PasteFormatPrompt: () => null }));
vi.mock('@/features/editor-md/EditorContextMenu', () => ({ EditorContextMenu: () => null }));
vi.mock('@/features/editor-md/LinkModal', () => ({ LinkModal: () => null }));
vi.mock('@/features/editor-md/imagePaste', () => ({ handlePastedImageFile: vi.fn() }));

const cleanups: Array<() => Promise<void>> = [];
const initialContent = '<table><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></table><p>正文</p>';

/** 挂载真实可视化内核；锁定自动保存，避免测试粘贴时写入文档历史和磁盘。 */
async function createKernel(): Promise<Editor> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ready: { editor: Editor | null } = { editor: null };
  cleanups.push(async () => {
    await act(async () => {
      root.unmount();
      ready.editor?.destroy();
    });
    host.remove();
  });
  await act(async () => root.render(
    <VisualKernel
      docKey="untitled:excel-paste"
      visible
      onReady={(editor) => { if (editor) ready.editor = editor; }}
      isInitializingRef={{ current: true }}
      visualUndoDepthRef={{ current: 0 }}
      storeTimerRef={{ current: null }}
      diskTimerRef={{ current: null }}
    />,
  ));
  const editor = ready.editor!;
  expect(editor).toBeTruthy();
  editor.commands.setContent(initialContent);
  selectCell(editor, 'A1');
  return editor;
}

/** 根据单元格文本定位光标或矩形选区，避免依赖文档内容长度计算固定位置。 */
function selectCell(editor: Editor, anchorText: string, headText?: string): void {
  const positions = new Map<string, number>();
  editor.state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === 'cell') positions.set(node.textContent, pos);
  });
  const anchor = positions.get(anchorText)!;
  if (headText) {
    const head = positions.get(headText)!;
    editor.view.dispatch(editor.state.tr.setSelection(new CellSelection(
      editor.state.doc.resolve(anchor), editor.state.doc.resolve(head),
    )));
  } else {
    // 单元格起点之后依次是段落与文字，偏移 2 将光标放到文字开头。
    editor.commands.setTextSelection(anchor + 2);
  }
}

/** 模拟 Excel 同时提供预览图片和单元格数据；getAsFile 用于确认图片分支确实可触发。 */
function clipboardEvent(text = '', html = ''): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  const file = new File(['preview'], 'excel.png', { type: 'image/png' });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => type === 'text/plain' ? text : type === 'text/html' ? html : '',
      items: [{ type: 'image/png', getAsFile: () => file }],
    },
  });
  return event as ClipboardEvent;
}

/** 按行读取实际文档中的单元格，校验填充、扩展以及未选中区域是否保持正确。 */
function cellTexts(editor: Editor): string[][] {
  const rows: string[][] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.spec.tableRole === 'row') {
      const cells: string[] = [];
      node.forEach((cell) => cells.push(cell.textContent));
      rows.push(cells);
    }
  });
  return rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('Markdown 表格内 Excel 多格式剪贴板粘贴', () => {
  it('HTML 表格与图片同时存在时优先按单元格填入，并保留空格、空单元格和前导零', async () => {
    const editor = await createKernel();
    const html = '<table><tr><td>00123</td><td></td></tr><tr><td>产品 A</td><td>1,234</td></tr></table>';
    await act(async () => { editor.view.pasteHTML(html, clipboardEvent('00123\t\r\n产品 A\t1,234', html)); });
    expect(cellTexts(editor)).toEqual([['00123', ''], ['产品 A', '1,234']]);
    expect(handlePastedImageFile).not.toHaveBeenCalled();
    expect(editor.getMarkdown()).toContain('00123');
    expect(editor.getMarkdown()).not.toContain('![');
  });

  it('只有 HTML 单元格和预览图片时也能粘贴单个单元格', async () => {
    const editor = await createKernel();
    const html = '<table><tr><td>单元格内容</td></tr></table>';
    await act(async () => { editor.view.pasteHTML(html, clipboardEvent('', html)); });
    expect(cellTexts(editor)).toEqual([['单元格内容', 'B1'], ['A2', 'B2']]);
    expect(handlePastedImageFile).not.toHaveBeenCalled();
  });

  it('TSV 和图片同时存在时按行列填入，数据超出当前表格时自动扩展', async () => {
    const editor = await createKernel();
    const text = '甲\t乙\t丙\r\n丁\t戊\t己\r\n';
    await act(async () => { editor.view.pasteText(text, clipboardEvent(text)); });
    expect(cellTexts(editor)).toEqual([['甲', '乙', '丙'], ['丁', '戊', '己']]);
    expect(handlePastedImageFile).not.toHaveBeenCalled();
  });

  it('单个文本和图片同时存在时在光标处插入文本', async () => {
    const editor = await createKernel();
    await act(async () => { editor.view.pasteText('文本', clipboardEvent('文本')); });
    expect(cellTexts(editor)).toEqual([['文本A1', 'B1'], ['A2', 'B2']]);
    expect(handlePastedImageFile).not.toHaveBeenCalled();
  });

  it('多选区域粘贴单个文本时仍按原规则平铺填充', async () => {
    const editor = await createKernel();
    selectCell(editor, 'A1', 'B2');
    await act(async () => { editor.view.pasteText('填充', clipboardEvent('填充')); });
    expect(cellTexts(editor)).toEqual([['填充', '填充'], ['填充', '填充']]);
    expect(handlePastedImageFile).not.toHaveBeenCalled();
  });

  it('表格内纯图片粘贴仍调用原有图片处理流程', async () => {
    const editor = await createKernel();
    const before = editor.getJSON();
    await act(async () => { editor.view.pasteText('', clipboardEvent()); });
    expect(handlePastedImageFile).toHaveBeenCalledWith(editor, expect.any(File), 'untitled:excel-paste');
    expect(editor.getJSON()).toEqual(before);
  });

  it('表格外混合格式仍沿用原有图片处理流程', async () => {
    const editor = await createKernel();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const before = editor.getJSON();
    await act(async () => { editor.view.pasteText('文本', clipboardEvent('文本')); });
    expect(handlePastedImageFile).toHaveBeenCalledTimes(1);
    expect(editor.getJSON()).toEqual(before);
  });
});
