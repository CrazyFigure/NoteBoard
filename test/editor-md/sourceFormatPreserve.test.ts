// NoteBoard 源码写法保留测试：代码围栏与表格风格在"解析→序列化"后保持原文写法

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { detectTableMarkdownStyle, displayWidth } from '../../src/features/editor-md/markdownTable';

const editor = new Editor({ element: null, extensions: buildExtensions('source-format-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

/** 解析后立即序列化 */
function roundTrip(markdown: string): string {
  expect(parseMarkdown(editor, markdown)).toBe(true);
  return serializeMarkdown(editor);
}

describe('代码围栏', () => {
  it.each([
    ['行中间的 ``` 不加长围栏', '```js\nvar a = "```".split("```");\n```'],
    ['原文多写的反引号围栏保留', '````js\nconst a = 1;\n````'],
    ['波浪线围栏保留', '~~~js\nconst a = 1;\n~~~'],
    ['行首 ``` 的内容沿用原文四反引号围栏', '````md\n```js\nx\n```\n````'],
    ['波浪线围栏包裹反引号行', '~~~md\n```js\nx\n```\n~~~'],
  ])('%s', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('编辑后内容会提前闭合原文围栏时自动加长', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'md', sourceFence: '```' }, content: [{ type: 'text', text: '```js\nx\n```' }] }],
    });
    expect(serializeMarkdown(editor)).toBe('````md\n```js\nx\n```\n````');
  });

  it('新建代码块（无原文围栏）不影响正文冗余转义的清理', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x * y' }] },
        { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'z' }] },
      ],
    });
    expect(serializeMarkdown(editor)).toBe('x * y\n\n```\nz\n```');
  });
});

describe('表格风格', () => {
  it.each([
    ['紧凑写法', '| 参数 | 说明 |\n| --- | --- |\n| 中转入口 | `18388/TCP` |'],
    ['分隔行无空格的紧凑写法', '| 平台 | 说明 |\n|---|---|\n| **Windows** | `setup.exe` |'],
    ['紧凑写法带对齐标记','| a | b | c |\n| :--- | ---: | :---: |\n| 1 | 2 | 3 |'],
    ['按显示宽度对齐的中文表格', '| 参数     | 说明 |\n| -------- | ---- |\n| 中转入口 | 端口 |'],
    ['旧版按字符数对齐的中文表格', '| 参数    | 本文约定     |\n| ----- | -------- |\n| 中转服务器 | 有公网 IPv4 |'],
    ['旧版带对齐标记的英文表格', '| a   | b   |\n| :--- | ---: |\n| 1   | 2   |'],
    ['英文对齐表格', '| a   | b   |\n| --- | --- |\n| 1   | 2   |'],
  ])('%s 原样保留', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('紧凑表格编辑单元格后仍输出紧凑写法', () => {
    expect(parseMarkdown(editor, '| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(true);
    let cellPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === '1') cellPos = pos;
    });
    editor.commands.insertContentAt({ from: cellPos, to: cellPos + 1 }, '一二三');
    expect(serializeMarkdown(editor)).toBe('| a | b |\n| --- | --- |\n| 一二三 | 2 |');
  });

  it('新建表格按显示宽度对齐（中文计 2 宽）', () => {
    const cell = (type: string, text: string) => ({ type, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader', '参数'), cell('tableHeader', 'b')] },
          { type: 'tableRow', content: [cell('tableCell', '中转入口'), cell('tableCell', 'x')] },
        ],
      }],
    });
    expect(serializeMarkdown(editor)).toBe('| 参数     | b   |\n| -------- | --- |\n| 中转入口 | x   |');
  });

  it('风格识别', () => {
    expect(displayWidth('中a')).toBe(3);
    expect(detectTableMarkdownStyle('| a | b |\n| --- | --- |\n| 中文 | x |')).toBe('compact');
    expect(detectTableMarkdownStyle('| 中文 | x   |\n| ---- | --- |\n| a    | b   |')).toBe('aligned');
    expect(detectTableMarkdownStyle('| 中文  | x   |\n| ---- | --- |\n| ab  | b   |')).toBe('aligned-chars');
  });
});

describe('HTML 实体', () => {
  it.each([
    ['命名与数字实体解码为字符', 'a &copy; b &#169; c &#xA9; &mdash;', 'a © b © c © —'],
    ['粗体与表格中的实体', '**粗&copy;体**\n\n| a&copy; | b |\n| --- | --- |\n| 1 | 2 |', '**粗©体**\n\n| a© | b |\n| --- | --- |\n| 1 | 2 |'],
    ['解码为 Markdown 符号时转义保持字面', '&#42;不是强调&#42;', '\\*不是强调\\*'],
  ])('%s', (_name, markdown, expected) => {
    expect(roundTrip(markdown)).toBe(expected);
  });

  it.each([
    ['不间断空格写回 &nbsp;', 'a&nbsp;&nbsp;b'],
    ['表格中的 &nbsp;', '| a | b |\n| --- | --- |\n| &nbsp; | x |'],
    ['字面的 &copy; 文本保持编码', '&amp;copy; 与 &foo;'],
    ['行内代码中的实体不解码', '`code &copy;`'],
    ['普通 & 符号', 'AT&T R&D'],
  ])('%s 原样保留', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('原文直接使用的不间断空格字符保持字符原样', () => {
    expect(roundTrip('a b')).toBe('a b');
  });

  it('原文使用 &nbsp; 实体时，同文档中的不间断空格字符统一写为实体', () => {
    expect(roundTrip('a&nbsp;b 与 c d')).toBe('a&nbsp;b 与 c&nbsp;d');
  });

  it('可视化中新建的文档保持不间断空格字符原样', () => {
    // setContent 不重置文档属性：先解析空文档，模拟新建文档的初始状态
    expect(parseMarkdown(editor, '')).toBe(true);
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a b' }] }] });
    expect(serializeMarkdown(editor)).toBe('a b');
  });

  it('实体解码为文本节点', () => {
    expect(parseMarkdown(editor, 'a &copy; b')).toBe(true);
    expect(editor.state.doc.textContent).toBe('a © b');
  });
});

describe('有序列表续行缩进', () => {
  it.each([
    ['续段缩进 3 格', '1. a\n\n   b'],
    ['子列表缩进 3 格', '1. a\n   - b\n   - c\n2. d'],
    ['两位数编号缩进 4 格', '10. a\n\n    b'],
    ['嵌套有序列表', '1. a\n   1. b'],
    ['无序列表仍为 2 格', '- a\n\n  b\n  - c'],
  ])('%s', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('已有的 2 格续段缩进保持原样', () => {
    expect(roundTrip('1. a\n\n  b')).toBe('1. a\n\n  b');
  });

  it.each([
    ['图中的两格子列表', '1. 给角色：\n  - `SERVER`\n  - `CALCULATE`\n2. 配置'],
    ['两格有序子列表与三级列表', '1. a\n  1. b\n    1. c\n2. d'],
    ['四格无序子列表', '- a\n    - b\n        - c'],
    ['软换行续行', '1. a\n  b\n   c\n2. d'],
    ['软续行与不同缩进的子列表', '1. a\n  b\n    - c\n    - d\n2. e'],
    ['硬换行续行', '1. a  \n  b\n2. c'],
    ['无序列表续行', '- a\n  b\n- c'],
    ['制表符子列表', '1. a\n\t- b\n\t- c'],
    ['无序列表的制表符子列表', '- a\n\t- b'],
    ['整个列表的已有缩进', '  - a\n    - b'],
    ['正文换行后的缩进', '首行\n  续行'],
    ['列表内引用', '1. a\n   > b\n   > c\n2. d'],
    ['任务列表内四格子列表', '- [ ] a\n    - b\n    - c'],
    ['任务列表内四格子任务', '- [ ] a\n    - [x] b\n        - [ ] c'],
    ['列表内围栏', '1. a\n   ```js\n   x\n   ```\n2. b'],
    ['围栏内的编号属于代码', '1. a\n   ```text\n   1. code\n   2. code\n   ```\n2. b'],
    ['代码内部与行尾空格', '1. a\n   ```py\n     x  \n   ```\n2. b'],
  ])('%s 保留原文且多次往返稳定', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
    expect(roundTrip(roundTrip(markdown))).toBe(markdown);
  });

  it('围栏代码中的编号不生成额外列表节点', () => {
    roundTrip('1. a\n   ```text\n   1. code\n   2. code\n   ```\n2. b');
    const firstItem = (editor.getJSON() as JSONContent).content?.[0].content?.[0];
    expect(firstItem?.content?.map((node) => node.type)).toEqual(['paragraph', 'codeBlock']);
    expect(firstItem?.content?.[1].content?.[0].text).toBe('1. code\n2. code');
  });

  it('编辑已有列表正文仍保留子列表缩进及层级', () => {
    roundTrip('1. a\n  - b\n    - c\n2. d');
    let textPos = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'b') textPos = pos;
    });
    editor.commands.insertContentAt({ from: textPos, to: textPos + 1 }, '修改后');
    const markdown = '1. a\n  - 修改后\n    - c\n2. d';
    expect(serializeMarkdown(editor)).toBe(markdown);
    expect(roundTrip(markdown)).toBe(markdown);
  });
});

describe('跨平台链接与图片地址', () => {
  it.each([
    String.raw`[backend](C:\Users\21573\.codex\guidelines\backend.md)`,
    String.raw`[UNC](\\server\share\_notes\a.md)`,
    String.raw`[相对](..\_notes\a.md)`,
    String.raw`[当前目录](.\_notes\a.md)`,
    '[POSIX](/home/user/.config/说明.md)',
    '[Android](/storage/emulated/0/笔记/说明.md)',
    '[iOS](/var/mobile/Documents/说明.md)',
    '[相对](../笔记/说明.md)',
    '[文件](file:///C:/Users/.config/a.md)',
    '[空格](<../my notes/a.md>)',
    '[括号](<../notes/a(b).md>)',
    '[URL](https://example.com/?value=&amp;copy;)',
    String.raw`[标题](https://example.com "say \"Hi\"")`,
    String.raw`![图](C:\Users\.assets\_logo.png)`,
    '![图](/storage/emulated/0/笔记/图片.png)',
    String.raw`[![图](C:\Users\.assets\logo.png)](C:\notes\_readme.md)`,
    String.raw`[普通转义](../some\(file\).md)`,
  ])('%s 不丢失地址或改变含义', (markdown) => {
    // 普通 Markdown 括号转义可改为尖括号包裹，但实际地址必须保持，二次往返需稳定。
    const expected = markdown === String.raw`[普通转义](../some\(file\).md)`
      ? '[普通转义](<../some(file).md>)' : markdown;
    expect(roundTrip(markdown)).toBe(expected);
    expect(roundTrip(expected)).toBe(expected);
  });

  it('引用式链接的 Windows 路径不丢字符', () => {
    expect(roundTrip(String.raw`[ref][id]

[id]: C:\Users\.codex\a.md`)).toBe(String.raw`[ref](C:\Users\.codex\a.md)`);
  });

  it.each([
    [String.raw`[模糊相对](notes\_todo.md)`, '[模糊相对](notes_todo.md)'],
    [String.raw`[POSIX 转义](../some\_file.md)`, '[POSIX 转义](../some_file.md)'],
    [String.raw`[普通 URL](https://example.com/some\_file)`, '[普通 URL](https://example.com/some_file)'],
  ])('按用户决定保留标准 Markdown 转义语义：%s', (markdown, expected) => {
    expect(roundTrip(markdown)).toBe(expected);
    expect(roundTrip(expected)).toBe(expected);
  });

  it('Windows 盘符链接在可视化 DOM 中保留实际 href', () => {
    const href = String.raw`C:\Users\.codex\a.md`;
    roundTrip(`[文件](${href})`);
    const host = document.createElement('div');
    host.innerHTML = editor.getHTML();
    expect(host.querySelector('a')?.getAttribute('href')).toBe(href);
  });
});

describe('解析器会丢弃的行尾空格', () => {
  /** 构造列表节点 */
  const list = (type: string, ...texts: string[]) => ({
    type,
    content: texts.map((text) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })),
  });

  it.each([
    ['列表最后一项', list('bulletList', 'a ', 'b '), '- a \n- b'],
    ['有序列表各项', list('orderedList', 'a ', 'b '), '1. a\n2. b'],
    ['标题', { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '标题 ' }] }, '# 标题'],
  ])('可视化模式中键入的%s行尾空格不写入文件', (_name, node, expected) => {
    editor.commands.setContent({ type: 'doc', content: [node] });
    const serialized = serializeMarkdown(editor);
    expect(serialized).toBe(expected);
    // 再次解析序列化结果应完全稳定，不会触发规范化提示
    expect(roundTrip(serialized)).toBe(serialized);
  });

  it.each([
    ['普通段落', '段落 \n\nnext'],
    ['列表中间项', '- a \n- b'],
    ['任务列表最后一项', '- [ ] a\n- [ ] b '],
  ])('%s 的行尾空格保留', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('列表末项含行尾空格时不影响正文冗余转义的清理', () => {
    editor.commands.setContent({ type: 'doc', content: [list('bulletList', 'b '), { type: 'paragraph', content: [{ type: 'text', text: 'x * y' }] }] });
    expect(serializeMarkdown(editor)).toBe('- b\n\nx * y');
  });
});

describe('带链接的图片', () => {
  it.each([
    ['README 徽章', '[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)'],
    ['带链接标题', '[![L](x.svg)](https://a.com "主页")'],
    ['居中容器中的多个徽章', '<div align="center">\n\n[![L](x.svg)](L)\n[![R](y.svg)](R)\n\n</div>'],
    ['普通链接不受影响', '[文字](https://a.com) 与 **[GPL](LICENSE)**'],
  ])('%s 原样保留', (_name, markdown) => {
    const expected = markdown.replace('**[GPL](LICENSE)**', '[**GPL**](LICENSE)');
    expect(roundTrip(markdown)).toBe(expected);
  });

  it('解析为带 href 的图片节点', () => {
    expect(parseMarkdown(editor, '[![L](x.svg)](https://a.com)')).toBe(true);
    let attrs: Record<string, unknown> | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') attrs = node.attrs;
    });
    expect(attrs).toMatchObject({ src: 'x.svg', alt: 'L', href: 'https://a.com' });
  });

  it('调整过尺寸的带链接图片以 <img> 包裹在链接中', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'x.svg', alt: 'L', width: '50%', align: 'center', href: 'L' } }],
    });
    expect(serializeMarkdown(editor)).toBe('[<img src="x.svg" alt="L" width="50%">](L)');
  });
});

describe('列表项间距', () => {
  it.each([
    ['宽松无序列表', '- a\n\n- b\n\n- c'],
    ['宽松有序列表', '1. a\n\n2. b'],
    ['紧凑列表', '- a\n- b'],
    ['项内多段落但项间无空行仍为紧凑', '- a\n\n  段二\n- b'],
    ['宽松列表中的紧凑子列表', '- a\n\n- b\n  - x\n  - y\n\n- c'],
    ['宽松有序列表项内多段落', '1. a\n\n   段二\n\n2. b'],
  ])('%s 原样保留', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('部分项间有空行时统一为宽松（标准渲染器中整个列表本就按宽松显示）', () => {
    expect(roundTrip('- a\n- b\n\n- c')).toBe('- a\n\n- b\n\n- c');
  });

  it('宽松列表在可视化中带 data-spacing 标记', () => {
    expect(parseMarkdown(editor, '- a\n\n- b')).toBe(true);
    expect(editor.getHTML()).toContain('data-spacing="loose"');
  });

  it('切换项间距属性后按新间距写回', () => {
    expect(parseMarkdown(editor, '- a\n- b')).toBe(true);
    editor.chain().command(({ tr }) => {
      tr.setNodeAttribute(0, 'spacing', 'loose');
      return true;
    }).run();
    expect(serializeMarkdown(editor)).toBe('- a\n\n- b');
  });

  it('切换表格排版属性后按新风格写回', () => {
    expect(parseMarkdown(editor, '| 参数 | b |\n| --- | --- |\n| 中转入口 | x |')).toBe(true);
    editor.chain().command(({ tr }) => {
      tr.setNodeAttribute(0, 'markdownStyle', 'aligned');
      return true;
    }).run();
    expect(serializeMarkdown(editor)).toBe('| 参数     | b   |\n| -------- | --- |\n| 中转入口 | x   |');
  });
});

describe('任务列表项间距', () => {
  it.each([
    ['宽松任务列表', '- [ ] a\n\n- [x] b\n\n- [ ] c'],
    ['紧凑任务列表', '- [ ] a\n- [x] b'],
    ['段落之后的宽松任务列表', '前文\n\n- [ ] a\n\n- [ ] b\n\n后文'],
    ['含子任务的宽松任务列表', '- [ ] a\n  - [ ] x\n  - [ ] y\n\n- [ ] b'],
  ])('%s 原样保留', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('项间空行的任务项合并为同一个宽松列表', () => {
    expect(parseMarkdown(editor, '前文\n\n- [ ] a\n\n- [ ] b')).toBe(true);
    const lists = (editor.getJSON().content ?? []).filter((node) => node.type === 'taskList');
    expect(lists).toHaveLength(1);
    expect(lists[0].attrs?.spacing).toBe('loose');
    expect(lists[0].content).toHaveLength(2);
  });

  it('紧凑任务列表后接普通段落不受影响', () => {
    expect(roundTrip('- [ ] a\n\n段落')).toBe('- [ ] a\n\n段落');
  });
});
