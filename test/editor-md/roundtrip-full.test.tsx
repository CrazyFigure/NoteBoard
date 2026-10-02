// NoteBoard Markdown 完整扩展集往返测试
//
// 使用真实 buildExtensions()（element: null 不挂载视图，避开 NodeView 渲染），
// 覆盖源码 ↔ 可视化切换中曾出现的格式问题：
// 1. 无损：常见写法"解析→序列化"后与原文逐字一致（只切换不编辑时不应触发规范化询问）；
// 2. 幂等：二次往返结果与一次往返一致；
// 3. 语义：必要转义保证再次解析后文档结构不变；
// 4. 不丢失：从菜单插入的 Mermaid / Infographic / PlantUML / 提示块能被序列化。

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';

const editor = new Editor({ element: null, extensions: buildExtensions('roundtrip-full'), content: '' });

afterAll(() => {
  editor.destroy();
});

/** 解析后序列化 */
function roundTrip(markdown: string): string {
  expect(parseMarkdown(editor, markdown)).toBe(true);
  return serializeMarkdown(editor);
}

/** 当前文档 JSON 快照 */
function docJson(): string {
  return JSON.stringify(editor.getJSON());
}

describe('Markdown 往返：原文逐字保留', () => {
  const lossless: Array<[string, string]> = [
    ['行首字面量转义', String.raw`\# not heading

\- not list

1\. not ol`],
    ['表格单元格内的竖线', String.raw`| a      | b   |
| ------ | --- |
| x \| y | z   |`],
    ['Windows 路径与行内星号', String.raw`path C:\Users\x and a*b*c`],
    ['C++ 与等号比较不被误识别', 'C++ and C++ rock\n\nif a == b and c == d'],
    ['中文语境高亮与下划线', '文字==高亮==文字 ++下划线++'],
    ['Mermaid 围栏', 'before\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nafter'],
    ['GitHub 提示块', '> [!NOTE]\n> hello\n>\n> world\n\nafter'],
    ['嵌套代码围栏', '````md\n```js\nx\n```\n````'],
    ['硬换行后的行首字面量', 'line one  \n\\- after break'],
    ['末尾单换行', 'a\n'],
    ['末尾空段落', 'a\n\n'],
    ['Front matter', '---\ntitle: x & y\ntags: [a]\n---\n\n# Hi\n'],
    ['脚注引用与连续定义', 'text[^1] and [^note]\n\n[^1]: note one\n    continued\n[^note]: second'],
    ['块级 HTML 与实体', '<details>\n<summary>S &amp; T</summary>\n\nbody\n\n</details>'],
    ['带属性的块级 HTML', '<div align="center">\n  <b>x</b>\n</div>\n\nafter'],
    ['字面量实体与 shell 重定向', 'literal &amp;gt; and &amp;amp; and shell &> out and a > b'],
    ['带尺寸的图片标签', '<img src="a b.png" alt="pic" width="50%" align="left">'],
    ['无尺寸的手写图片标签', '<img src="raw.png">'],
    ['以分隔线开头的普通文档', '---\n\n# Not front matter\n\n---'],
    ['行内 HTML 标签', '> quote with\n> <span>inline</span> and <kbd>Ctrl</kbd>'],
  ];

  it.each(lossless)('%s', (_name, markdown) => {
    const output = roundTrip(markdown);
    expect(output).toBe(markdown);
    const firstDoc = docJson();
    // 二次往返：文本与文档结构均保持不变
    expect(roundTrip(output)).toBe(output);
    expect(docJson()).toBe(firstDoc);
  });
});

describe('Markdown 往返：语义保持', () => {
  it('行首字面量在再次解析后仍是段落文本', () => {
    roundTrip(String.raw`\# a

\- b

1\. c`);
    const types = (editor.getJSON().content ?? []).map((node) => node.type);
    expect(types).toEqual(['paragraph', 'paragraph', 'paragraph']);
  });

  it('会构成行内公式的美元符号被转义', () => {
    const output = roundTrip(String.raw`price \$x\$`);
    parseMarkdown(editor, output);
    const json = docJson();
    expect(json).not.toContain('mathInline');
    expect(json).toContain('price $x$');
  });

  it('普通金额不额外转义', () => {
    expect(roundTrip('cost $5 and $6')).toBe('cost $5 and $6');
  });
});

describe('Markdown 往返：从菜单插入的块不丢失', () => {
  it('Mermaid / 提示块 / PlantUML / 信息图均能序列化', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
        { type: 'mermaidBlock', attrs: { code: 'graph TD\n A-->B' } },
        { type: 'githubAlert', attrs: { kind: 'tip' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
        { type: 'plantumlBlock', attrs: { code: '@startuml\nA->B\n@enduml' } },
        { type: 'infographicBlock', attrs: { code: 'infographic list' } },
      ],
    });
    const output = serializeMarkdown(editor);
    expect(output).toBe([
      'x',
      '```mermaid\ngraph TD\n A-->B\n```',
      '> [!TIP]\n> hi',
      '```plantuml\n@startuml\nA->B\n@enduml\n```',
      '```infographic\ninfographic list\n```',
    ].join('\n\n'));

    // 重新打开：Mermaid / 信息图 / 提示块还原为预览节点；PlantUML 不自动远程渲染，保持代码块
    parseMarkdown(editor, output);
    const types = (editor.getJSON().content ?? []).map((node) => node.type);
    expect(types).toEqual(['paragraph', 'mermaidBlock', 'githubAlert', 'codeBlock', 'infographicBlock']);
  });

  it('代码块内容含三反引号时自动加长围栏', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'md' }, content: [{ type: 'text', text: '```js\nx\n```' }] }],
    });
    expect(serializeMarkdown(editor)).toBe('````md\n```js\nx\n```\n````');
  });

  it('调整过尺寸的图片以 <img> 保存，默认图片保持标准语法', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'p (1).png', alt: 'a]b', width: '75%', align: 'center' } },
        { type: 'image', attrs: { src: 'p (1).png', alt: 'a]b', title: 'say "hi"', width: '100%', align: 'center' } },
      ],
    });
    expect(serializeMarkdown(editor)).toBe(
      '<img src="p (1).png" alt="a]b" width="75%">\n\n![a\\]b](<p (1).png> "say \\"hi\\"")',
    );
  });
});
