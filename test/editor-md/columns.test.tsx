// NoteBoard 分栏卡片往返测试
// 规范化约束：标准写法逐字往返并解析为可编辑的分栏块；非标准写法继续按块级 HTML 原样保留。

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import {
  addColumn,
  columnsSourceSnippet,
  createColumnsContent,
  equalizeColumns,
  exitColumnsFromEmptyParagraph,
  insertColumnsBlock,
  matchColumnsBlock,
  removeLastColumn,
  unwrapColumns,
} from '../../src/features/editor-md/columnsExtension';
import { splitSections } from '../../src/features/editor-md/sectionDocument';

const editor = new Editor({ element: null, extensions: buildExtensions('columns-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

const OPEN = '<div class="nb-columns" style="display: flex; gap: 16px;">';
/** 生成单栏标准写法 */
const col = (width: string, body: string) =>
  body === ''
    ? `<div class="nb-column" style="flex: ${width}; min-width: 0;">\n\n</div>`
    : `<div class="nb-column" style="flex: ${width}; min-width: 0;">\n\n${body}\n\n</div>`;
/** 生成分栏块标准写法 */
const columns = (...items: string[]) => `${OPEN}\n${items.join('\n')}\n</div>`;

/** 解析后序列化 */
function roundTrip(markdown: string): string {
  expect(parseMarkdown(editor, markdown)).toBe(true);
  return serializeMarkdown(editor);
}

/** 当前文档所有节点类型（深度优先） */
function nodeTypes(): string[] {
  const types: string[] = [];
  editor.state.doc.descendants((node) => {
    types.push(node.type.name);
  });
  return types;
}

describe('分栏：标准写法逐字往返', () => {
  const lossless: Array<[string, string]> = [
    ['两栏', columns(col('50', '左'), col('50', '右'))],
    ['三栏小数宽度', columns(col('33.3', 'a'), col('33.3', 'b'), col('33.3', 'c'))],
    ['不等宽', columns(col('62.5', 'a'), col('37.5', 'b'))],
    ['空栏', columns(col('50', ''), col('50', 'x'))],
    ['多块正文', columns(col('50', '# 标题\n\n- a\n- b\n\n```js\nconst a = 1;\n```\n\n> 引用'), col('50', '| a   | b   |\n| --- | --- |\n| 1   | 2   |'))],
    ['栏内 HTML', columns(col('50', '<p align="center">居中</p>'), col('50', '**粗体** 与 `code`'))],
    ['栏内折叠块', columns(col('50', '<details>\n<summary>x</summary>\n\nbody\n\n</details>'), col('50', 'y'))],
    ['嵌套分栏', columns(col('50', columns(col('50', 'a'), col('50', 'b'))), col('50', 'c'))],
    ['代码围栏中的结束标签', columns(col('50', '```html\n</div>\n```'), col('50', 'y'))],
    ['前后有其他块', `before\n\n${columns(col('50', 'a'), col('50', 'b'))}\n\nafter\n`],
    ['引用中的分栏', '> <div class="nb-columns" style="display: flex; gap: 16px;">\n> <div class="nb-column" style="flex: 50; min-width: 0;">\n>\n> a\n>\n> </div>\n> </div>'],
  ];

  it.each(lossless)('%s', (_name, markdown) => {
    const output = roundTrip(markdown);
    expect(output).toBe(markdown);
    const firstDoc = JSON.stringify(editor.getJSON());
    expect(roundTrip(output)).toBe(output);
    expect(JSON.stringify(editor.getJSON())).toBe(firstDoc);
  });

  it('标准写法解析为分栏块，栏宽正确', () => {
    roundTrip(columns(col('62.5', '**a**'), col('37.5', 'b')));
    const node = editor.state.doc.firstChild!;
    expect(node.type.name).toBe('columnsBlock');
    expect(node.childCount).toBe(2);
    expect(node.child(0).attrs.width).toBe(62.5);
    expect(node.child(1).attrs.width).toBe(37.5);
    expect(node.child(0).firstChild?.type.name).toBe('paragraph');
  });

  it('列表中的分栏正文仍是段落', () => {
    roundTrip(`- item\n\n  ${OPEN}\n  <div class="nb-column" style="flex: 50; min-width: 0;">\n\n  body\n\n  </div>\n  </div>`);
    const types = nodeTypes();
    expect(types).toContain('columnsBlock');
    expect(types[types.indexOf('columnBlock') + 1]).toBe('paragraph');
  });
});

describe('分栏：非标准写法保持原样 HTML', () => {
  const preserved: Array<[string, string]> = [
    ['无空行', `${OPEN}\n<div class="nb-column" style="flex: 50; min-width: 0;">\nbody\n</div>\n</div>`],
    ['非规范宽度', columns(col('50.0', 'a'), col('50', 'b'))],
    ['前导零', columns(col('050', 'a'), col('50', 'b'))],
    ['外层无样式', `<div class="nb-columns">\n${col('50', 'a')}\n</div>`],
    ['未闭合', `${OPEN}\n${col('50', 'a')}`],
    ['结束标签后紧跟文字', `${columns(col('50', 'a'))}\nafter`],
    ['没有栏', `${OPEN}\n</div>`],
  ];

  it.each(preserved)('%s', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
    expect(nodeTypes()).not.toContain('columnsBlock');
  });
});

describe('分栏：可视化插入与操作', () => {
  it('插入三栏后光标在第一栏，序列化为标准写法', () => {
    parseMarkdown(editor, 'before');
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent({ type: 'paragraph' });
    insertColumnsBlock(editor, 3);
    const { $from } = editor.state.selection;
    expect($from.node($from.depth - 1).type.name).toBe('columnBlock');
    expect($from.index($from.depth - 2)).toBe(0);
    const output = serializeMarkdown(editor);
    expect(output).toBe(`before\n\n${columns(col('33.3', ''), col('33.3', ''), col('33.3', ''))}`);
    expect(roundTrip(output)).toBe(output);
  });

  it('增加 / 减少一栏、均分、取消分栏', () => {
    editor.commands.setContent({ type: 'doc', content: [createColumnsContent(2)] });
    const at = () => 0;
    // 第二栏写入内容，用于验证减少一栏时内容并入前一栏
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'columnsBlock',
          content: [
            { type: 'columnBlock', attrs: { width: 70 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
            { type: 'columnBlock', attrs: { width: 30 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] },
          ],
        },
      ],
    });
    expect(addColumn(editor, at())).toBe(true);
    let node = editor.state.doc.firstChild!;
    expect(node.childCount).toBe(3);
    // 70 : 30 : 50 归一为总和 100
    expect(node.child(0).attrs.width).toBe(46.7);
    expect(node.child(2).attrs.width).toBe(33.3);

    expect(removeLastColumn(editor, at())).toBe(true);
    node = editor.state.doc.firstChild!;
    expect(node.childCount).toBe(2);
    // 空栏直接删除，宽度归前一栏
    expect(node.child(1).attrs.width).toBe(53.3);

    // 两栏时不能再减少
    expect(removeLastColumn(editor, at())).toBe(false);

    expect(equalizeColumns(editor, at())).toBe(true);
    node = editor.state.doc.firstChild!;
    expect(node.child(0).attrs.width).toBe(50);
    expect(node.child(1).attrs.width).toBe(50);

    expect(unwrapColumns(editor, at())).toBe(true);
    expect(serializeMarkdown(editor)).toBe('a\n\nb');
  });

  it('减少一栏时非空内容并入前一栏', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'columnsBlock',
          content: ['a', 'b', 'c'].map((text) => ({
            type: 'columnBlock',
            attrs: { width: 33.3 },
            content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
          })),
        },
      ],
    });
    expect(removeLastColumn(editor, 0)).toBe(true);
    expect(serializeMarkdown(editor)).toBe(columns(col('33.3', 'a'), col('66.6', 'b\n\nc')));
  });

  it('最后一栏末尾空段落按回车跳出到分栏块后方', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'columnsBlock',
          content: [
            { type: 'columnBlock', attrs: { width: 50 }, content: [{ type: 'paragraph' }] },
            {
              type: 'columnBlock',
              attrs: { width: 50 },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph' }],
            },
          ],
        },
      ],
    });
    const block = editor.state.doc.firstChild!;
    // 光标放到最后一栏的末尾空段落：分栏块结束(-1)、栏结束(-1)、段落内(-1)
    editor.commands.setTextSelection(block.nodeSize - 3);
    let next: EditorState | null = null;
    expect(exitColumnsFromEmptyParagraph(editor.state, (tr) => {
      next = editor.state.apply(tr);
    })).toBe(true);
    const result = next as unknown as EditorState;
    const types: string[] = [];
    result.doc.forEach((node) => types.push(node.type.name));
    expect(types).toEqual(['columnsBlock', 'paragraph']);
    expect(result.selection.$from.depth).toBe(1);
  });

  it('非最后一栏的空段落不拦截回车', () => {
    editor.commands.setContent({ type: 'doc', content: [createColumnsContent(2)] });
    editor.commands.setTextSelection(3);
    expect(exitColumnsFromEmptyParagraph(editor.state, () => undefined)).toBe(false);
  });

  it('源码模式插入片段本身是标准写法', () => {
    const match = matchColumnsBlock(columnsSourceSnippet(3).trimStart());
    expect(match?.columns.map((column) => column.body)).toEqual(['第 1 栏内容', '第 2 栏内容', '第 3 栏内容']);
  });
});

describe('大文档分段不切开分栏块', () => {
  it('切点落在分栏块之后', () => {
    const filler = Array.from({ length: 2400 }, (_, index) => `段落 ${index}`).join('\n\n');
    const inner = Array.from({ length: 800 }, (_, index) => `内部 ${index}`).join('\n\n');
    const block = columns(col('50', inner), col('50', inner));
    const content = `${filler.slice(0, 20_000)}\n\n${block}\n\ntail`;
    for (const section of splitSections(content)) {
      const opens = section.content.match(/<div[\s>]/g)?.length ?? 0;
      const closes = section.content.match(/<\/div>/g)?.length ?? 0;
      expect(opens).toBe(closes);
    }
  });
});
