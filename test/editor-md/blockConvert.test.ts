// NoteBoard 选区转块测试：右键菜单「转为代码块 / 提示块 / 高亮块 / 折叠块」

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { convertSelectionToCodeBlock, wrapSelectionInBlock } from '../../src/features/editor-md/blockConvert';
import { renderCalloutOpenTag } from '../../src/features/editor-md/calloutExtension';

const editor = new Editor({ element: null, extensions: buildExtensions('block-convert-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

/** 返回文本在文档中的起始位置 */
function posOf(text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text) {
      const index = node.text.indexOf(text);
      if (index >= 0) found = pos + index;
    }
    return true;
  });
  if (found < 0) throw new Error(`未找到文本：${text}`);
  return found;
}

/** 载入 Markdown 并选中从 start 文本开头到 end 文本结尾的范围 */
function load(markdown: string, start: string, end = start): void {
  expect(parseMarkdown(editor, markdown)).toBe(true);
  editor.commands.setTextSelection({ from: posOf(start), to: posOf(end) + end.length });
}

describe('转为代码块', () => {
  it('单段落转为代码块', () => {
    load('前文\n\n选中段落\n\n后文', '选中');
    expect(convertSelectionToCodeBlock(editor)).toBe(true);
    expect(serializeMarkdown(editor)).toBe('前文\n\n```\n选中段落\n```\n\n后文');
  });

  it('多段落合并为一个代码块，每段一行', () => {
    load('第一行\n\n第二行\n\n第三行', '第一', '第三行');
    expect(convertSelectionToCodeBlock(editor)).toBe(true);
    expect(serializeMarkdown(editor)).toBe('```\n第一行\n第二行\n第三行\n```');
  });

  it('列表项首段无法直接放代码块时，整个列表转为代码块', () => {
    load('- 苹果\n- 香蕉', '苹果', '香蕉');
    expect(convertSelectionToCodeBlock(editor)).toBe(true);
    expect(serializeMarkdown(editor)).toBe('```\n苹果\n香蕉\n```');
  });

  it('段内换行与行内公式保留在代码中', () => {
    load('甲  \n乙 $x^2$', '甲', '乙');
    expect(convertSelectionToCodeBlock(editor)).toBe(true);
    expect(editor.state.doc.firstChild?.textContent).toBe('甲\n乙 $x^2$');
  });

  it('选区在代码块内时切换回段落', () => {
    load('```\n代码\n```', '代码');
    expect(convertSelectionToCodeBlock(editor)).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
  });
});

describe('转为容器块', () => {
  it('转为 GitHub 提示块', () => {
    load('前文\n\n甲\n\n乙\n\n后文', '甲', '乙');
    expect(wrapSelectionInBlock(editor, 'githubAlert', { kind: 'warning' })).toBe(true);
    expect(serializeMarkdown(editor)).toBe('前文\n\n> [!WARNING]\n> 甲\n>\n> 乙\n\n后文');
  });

  it('转为高亮块', () => {
    load('甲', '甲');
    expect(wrapSelectionInBlock(editor, 'calloutBlock', { color: 'green', icon: 'check' })).toBe(true);
    expect(serializeMarkdown(editor)).toBe(`${renderCalloutOpenTag('green', 'check')}\n\n甲\n\n</div>`);
  });

  it('转为折叠块', () => {
    load('甲\n\n乙', '甲', '乙');
    expect(wrapSelectionInBlock(editor, 'detailsBlock', { summary: '标题' })).toBe(true);
    expect(serializeMarkdown(editor)).toBe('<details>\n<summary>标题</summary>\n\n甲\n\n乙\n\n</details>');
  });

  it('列表项首段无法直接包裹时，向外包裹整个列表', () => {
    load('- 苹果\n- 香蕉', '苹果');
    expect(wrapSelectionInBlock(editor, 'githubAlert', { kind: 'note' })).toBe(true);
    const first = editor.state.doc.firstChild;
    expect(first?.type.name).toBe('githubAlert');
    expect(first?.firstChild?.type.name).toBe('bulletList');
  });
});
