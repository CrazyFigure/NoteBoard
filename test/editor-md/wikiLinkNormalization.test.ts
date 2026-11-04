// 双链与 Markdown 回写：双链原文在任何位置都逐字保留，不会被序列化规则改写
// 分两类验证：
// 1. 已是规范写法的文档：含双链也逐字往返；
// 2. 非规范写法的文档（`*` 列表、`_强调_`、紧凑表格等）：未编辑时按原文保留；
//    块被编辑而按规则重写时，周围写法变为规范形式，双链本身一字不变。

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { extractWikiLinks } from '../../src/features/wikilink/wikiLinkSyntax';

const editor = new Editor({ element: null, extensions: buildExtensions('wiki-link-normalization'), content: '' });

afterAll(() => {
  editor.destroy();
});

function normalize(markdown: string): string {
  expect(parseMarkdown(editor, markdown)).toBe(true);
  return serializeMarkdown(editor);
}

/** 文档中全部双链的原文写法（含嵌入的 `!`，表格中的 `\|` 统一为 `|` 后比较） */
function wikiLinksOf(markdown: string): string[] {
  return extractWikiLinks(markdown).map((link) => `${link.embed ? '!' : ''}[[${link.inner.replace(/\\\|/g, '|')}]]`);
}

/** 模拟所有块都被编辑：去掉原文记录后按规则整篇重写 */
function rewriteAll(markdown: string): string {
  expect(parseMarkdown(editor, markdown)).toBe(true);
  editor.view.dispatch(editor.state.tr.setDocAttribute('sourceBlocks', null));
  return serializeMarkdown(editor);
}

/** 可视化文档中的双链节点 */
function wikiNodes(): string[] {
  const result: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'wikiLink') result.push(`${node.attrs.embed ? '!' : ''}[[${node.attrs.inner}]]`);
  });
  return result;
}

/** 各种位置与内容的双链（均为规范写法） */
const CONTEXTS: Array<[string, string]> = [
  ['段落中与中文紧邻', '中文[[笔记]]中文，再见 [[另一篇|别名]]。'],
  ['标题', '## [[笔记]] 的说明'],
  ['无序列表与嵌套', '- 第一项 [[a]]\n  - 子项 [[b#标题]]'],
  ['有序列表', '1. 步骤 [[a]]\n2. 步骤 [[b]]'],
  ['任务列表', '- [ ] 待办 [[a]]\n- [x] 完成 [[b]]'],
  ['引用', '> 引用里的 [[a]]\n>\n> 第二段 ![[b]]'],
  ['GitHub 提示块', '> [!NOTE]\n> 提示里的 [[a]]'],
  ['粗体斜体删除线高亮包裹', '**[[粗]]** *[[斜]]* ~~[[删]]~~ ==[[亮]]=='],
  ['与粗体相邻', '**粗体**[[紧邻]]与*斜体*[[紧邻2]]'],
  ['表格单元格含显示名', '| 链接 | 说明 |\n| --- | --- |\n| [[笔记\\|别名]] | **[[粗体\\|名]]** |'],
  ['名称含 Markdown 特殊字符', '[[a_b_c]] [[a*b*c]] [[C++ 笔记]] [[a~b~]] [[x$y$]] [[1. 不是列表]]'],
  ['名称含 HTML 与实体字样', '[[a<b>c]] [[a &amp; b]]'],
  ['标题与显示名含空格和符号', '[[我的 笔记#第 1 节|看 *这里*]]'],
  ['路径写法', '[[../上级/笔记]] [[C:/笔记/外部]] [[./同级]]'],
  ['嵌入与尺寸', '![[图.png|300]]\n\n![[笔记#小节|400]]'],
  ['转义的方括号保持文字', '\\[\\[不是链接\\]\\] 与 [[是链接]]'],
  ['行内代码与代码块中不解析', '`[[代码]]` 与 [[链接]]\n\n```\n[[代码块]]\n```'],
  ['脚注定义中', '正文[^1]\n\n[^1]: 脚注里的 [[a]]'],
  ['折叠块中', '<details>\n<summary>标题</summary>\n\n折叠里的 [[a]]\n\n</details>'],
  ['硬换行前后', '第一行 [[a]]  \n第二行 [[b]]'],
];

describe('已是规范写法：含双链逐字往返', () => {
  it.each(CONTEXTS)('%s', (_name, markdown) => {
    expect(normalize(markdown)).toBe(markdown);
    // 即使整篇按规则重写也与原文一致
    expect(rewriteAll(markdown)).toBe(markdown);
  });

  it('整篇混合文档无差异', async () => {
    const markdown = CONTEXTS.map(([, text]) => text).join('\n\n');
    const normalized = normalize(markdown);
    expect(normalized).toBe(markdown);
  });
});

describe('非规范写法：未编辑时保留原文，按规则重写时双链一字不变', () => {
  const cases: Array<[string, string]> = [
    ['星号列表改为短横线', '* 第一项 [[a]]\n* 第二项 ![[b|300]]'],
    ['下划线强调改为星号', '正文 _强调 [[a]] 文字_ 与 __粗体[[b#节|名]]__'],
    ['紧凑表格补齐', '|链接|说明|\n|-|-|\n|[[笔记\\|别名]]|x|\n|![[图.png]]|y|'],
    ['分隔线与多余空行', '[[a]]\n\n\n\n***\n\n[[b]]'],
    ['有序列表重新编号', '1. [[a]]\n1. [[b]]\n1. [[c]]'],
    ['缩进代码块改为围栏（其中不是双链）', '[[a]]\n\n    [[代码中]]\n\n[[b]]'],
    ['行尾空格与实体', '[[a]] &copy; \n[[b]]'],
  ];

  it.each(cases)('%s', (_name, markdown) => {
    // 未编辑：逐字保留原文
    expect(normalize(markdown)).toBe(markdown);
    const normalized = rewriteAll(markdown);
    // 按规则重写确实改变了周围写法
    expect(normalized).not.toBe(markdown);
    // 双链顺序、写法完全一致
    expect(wikiLinksOf(normalized)).toEqual(wikiLinksOf(markdown));
    // 再次重写稳定，不会累积变化
    expect(rewriteAll(normalized)).toBe(normalized);
    expect(wikiLinksOf(normalized)).toEqual(wikiNodes());
  });
});
