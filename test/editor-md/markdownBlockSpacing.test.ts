// Markdown 块间距回归：省略的分隔空行往返保留，必要分段与额外空白段不能被压缩。
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { getMarkdownManager, parseMarkdown, serializeMarkdown, serializeMarkdownFromDoc } from '../../src/features/editor-md/serialize';
import { createIsolatedMarkdownParser, captureMarkdownBlockTokens } from '../../src/features/editor-md/markdownBlockStart';

const editor = new Editor({ element: null, extensions: buildExtensions('block-spacing'), content: '' });
afterAll(() => editor.destroy());

/** 在完整扩展集上往返，覆盖实际打开文档与切换可视化的入口。 */
function roundTrip(source: string): string {
  expect(parseMarkdown(editor, source)).toBe(true);
  return serializeMarkdown(editor);
}

describe('原文中的块间空行', () => {
  it.each([
    ['图中的引用段落接列表', '> 💡 **推荐答案**：\n> - **说明**：内容\n> - 第二项'],
    ['标题后直接接引用', '#### 面试题\n> 推荐答案'],
    ['正文后直接接列表', '推荐答案：\n- 第一项\n- 第二项'],
    ['正文后直接接从 1 开始的列表', '步骤：\n1. 第一项\n2. 第二项'],
    ['正文后直接接任务列表', '任务：\n- [ ] 第一项\n- [x] 第二项'],
    ['正文后直接接标题', '前文\n## 标题'],
    ['标题后直接接正文', '## 标题\n正文'],
    ['正文后直接接围栏', '示例：\n```js\nconst x = 1;\n```'],
    ['围栏后直接接正文', '```js\nconst x = 1;\n```\n正文'],
    ['引用后接标题', '> 引用\n## 标题'],
    ['引用内子列表与原缩进', '#### 问题\n> 答案：\n> - 第一项\n>     - 子项\n> - 第二项'],
    ['列表内的引用', '- 项目\n  > 答案：\n  > - 说明'],
    ['嵌套引用中的段落接列表', '> > 答案：\n> > - 说明'],
    ['原本有分隔空行', '#### 问题\n\n> 答案：\n>\n> - 说明'],
    ['普通段落的必要空行', '第一段\n\n第二段'],
    ['引用内两个段落的必要空行', '> 第一段\n>\n> 第二段'],
    ['引用内的单次换行', '> 第一行\n> 第二行'],
    ['额外空白段', '第一段\n\n\n\n第二段'],
    ['引用结束后接普通正文', '> 引用\n\n正文'],
    ['列表结束后接普通正文', '- 项目\n\n正文'],
  ])('%s 保持原样且二次往返稳定', (_name, source) => {
    expect(roundTrip(source)).toBe(source);
    expect(roundTrip(source)).toBe(source);
  });

  it('修改答案文字继续沿用原来的紧凑块边界', () => {
    roundTrip('#### 问题\n> 答案：\n> - 原内容');
    let position = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === '原内容') position = pos;
    });
    editor.commands.insertContentAt({ from: position, to: position + 3 }, '新内容');
    expect(serializeMarkdown(editor)).toBe('#### 问题\n> 答案：\n> - 新内容');
  });

  it('用户新插入的空段落不会因原来的紧凑边界而被删除', () => {
    roundTrip('## 标题\n> 答案');
    editor.commands.insertContentAt(editor.state.doc.child(0).nodeSize, { type: 'paragraph' });
    expect(serializeMarkdown(editor)).toBe('## 标题\n\n\n\n> 答案');
  });

  it('多个空白段的空段落标记不会让其他块在下一次打开时重新补空行', () => {
    roundTrip('#### 问题\n> 答案：\n> - 内容\n\n第一段\n\n后文');
    const lastParagraphPosition = editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize;
    editor.commands.insertContentAt(lastParagraphPosition, [{ type: 'paragraph' }, { type: 'paragraph' }]);
    const normalized = serializeMarkdown(editor);
    expect(normalized.startsWith('#### 问题\n> 答案：\n> - 内容')).toBe(true);
    expect(roundTrip(normalized)).toBe(normalized);
    // 段落扩展可能使用 NBSP 占位，按显示为空白的段落计数，不把既有占位写法误判为丢失留白。
    const emptyParagraphs = editor.state.doc.content.content.filter((node) => node.type.name === 'paragraph' && /^[\u00a0]*$/.test(node.textContent));
    expect(emptyParagraphs).toHaveLength(2);
  });

  it('回车分裂出的新段落不继承前一段的紧凑边界', () => {
    roundTrip('## 标题\n第一段第二段');
    const paragraphPosition = editor.state.doc.child(0).nodeSize;
    editor.commands.setTextSelection(paragraphPosition + 1 + '第一段'.length);
    editor.commands.splitBlock();
    expect(serializeMarkdown(editor)).toBe('## 标题\n第一段\n\n第二段');
  });

  it('有序列表改为从 2 开始后恢复必要分隔，不能并入前面的段落', () => {
    roundTrip('步骤：\n1. 第一项');
    const listPosition = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(editor.state.tr.setNodeAttribute(listPosition, 'start', 2));
    expect(serializeMarkdown(editor)).toBe('步骤：\n\n2. 第一项');
  });

  it('段落启用 HTML 排版包裹后不省略标签所需的分隔', () => {
    roundTrip('## 标题\n正文');
    const paragraphPosition = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(editor.state.tr.setNodeAttribute(paragraphPosition, 'textAlign', 'center'));
    expect(serializeMarkdown(editor)).toBe('## 标题\n\n<div align="center">\n\n正文\n\n</div>');
  });

  it('星号分隔线改成横线时保留必要空行，不能误写成 Setext 标题', () => {
    expect(roundTrip('正文\n***\n后文')).toBe('正文\n\n---\n\n后文');
  });

  it('没有原文格式记录的新内容沿用原来的默认块间距', () => {
    editor.commands.setContent({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '标题' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '正文' }] },
    ] });
    expect(serializeMarkdown(editor)).toBe('## 标题\n\n正文');
  });

  it('不可变快照与活编辑器使用同一间距规则，后续编辑不改变已捕获的内容', () => {
    const source = '#### 问题\n> 答案：\n> - 内容';
    roundTrip(source);
    const doc = editor.state.doc;
    const manager = getMarkdownManager(editor)!;
    roundTrip('另一份内容');
    expect(serializeMarkdownFromDoc(manager, editor.schema, doc)).toBe(source);
  });
});

describe('块间距词法捕获的生命周期', () => {
  it('正常解析只执行一次根词法分析', () => {
    const parser = createIsolatedMarkdownParser();
    const lex = vi.spyOn(parser.Lexer.prototype, 'lex');
    const captured = captureMarkdownBlockTokens(parser, () => parser.lexer('## 标题\n> 答案'));
    expect(lex).toHaveBeenCalledTimes(1);
    expect(captured.tokens).toBe(captured.parsed);
    lex.mockRestore();
  });

  it('嵌套捕获失败后恢复外层会话，外层仍能取得自己的根 token', () => {
    const parser = createIsolatedMarkdownParser();
    const outer = captureMarkdownBlockTokens(parser, () => {
      expect(() => captureMarkdownBlockTokens(parser, () => { throw new Error('测试解析失败'); })).toThrow('测试解析失败');
      return parser.lexer('## 外层标题\n正文');
    });
    expect(outer.tokens).toBe(outer.parsed);
    expect(outer.tokens?.[0].type).toBe('heading');
  });
});
