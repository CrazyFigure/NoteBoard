// NoteBoard 多维表格多行文本富文本编辑器测试
// 直接驱动 TipTap 编辑器实例验证「扩展装配 + Markdown 往返」，不依赖 DOM 渲染库：
// 真实风险在于扩展冲突或 Markdown 扩展未生效，这类问题只有跑起来才暴露

import { describe, test, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildLongTextExtensions } from '@/features/bitable/BitableRichTextEditor';

/** 用与线上一致的扩展集创建一个挂载到 jsdom 的编辑器 */
function createTestEditor(content = '') {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: buildLongTextExtensions(),
    content,
    contentType: 'markdown',
  });
  return editor;
}

describe('多行文本富文本编辑器扩展集', () => {
  test('编辑器可用 Markdown 初始化并原样序列化回 Markdown', () => {
    const md = '# 标题\n\n正文 **加粗** 与 `行内代码`。';
    const editor = createTestEditor(md);
    const output = editor.getMarkdown();
    expect(output).toContain('# 标题');
    expect(output).toContain('**加粗**');
    expect(output).toContain('`行内代码`');
    editor.destroy();
  });

  test('代码块被识别为 codeBlock 节点而非普通段落', () => {
    const md = '说明：\n\n```ts\nconst a = 1;\n```\n';
    const editor = createTestEditor(md);
    let codeBlockCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'codeBlock') codeBlockCount += 1;
    });
    expect(codeBlockCount).toBe(1);
    editor.destroy();
  });

  test('代码块内容不丢字符：序列化后仍包含原始代码', () => {
    const md = '```ts\nconst answer = 42;\n```';
    const editor = createTestEditor(md);
    expect(editor.getMarkdown()).toContain('const answer = 42;');
    editor.destroy();
  });

  test('列表与引用被解析为对应节点', () => {
    const md = '- 第一项\n- 第二项\n\n> 引用内容';
    const editor = createTestEditor(md);
    const types = new Set<string>();
    editor.state.doc.descendants((node) => {
      types.add(node.type.name);
    });
    expect(types.has('bulletList')).toBe(true);
    expect(types.has('listItem')).toBe(true);
    expect(types.has('blockquote')).toBe(true);
    editor.destroy();
  });

  test('行内代码可与加粗嵌套共存（Markdown 兼容的 Code 扩展生效）', () => {
    // 默认 Code 的 excludes 会让这种合法 Markdown 解析出非法 marks 并降级为纯文本
    const md = '**加粗的 `代码`**';
    const editor = createTestEditor(md);
    const output = editor.getMarkdown();
    expect(output).toContain('`代码`');
    expect(output).toContain('**');
    editor.destroy();
  });

  test('setContent 以 markdown 为内容类型可重复覆盖文档', () => {
    const editor = createTestEditor('第一段');
    expect(editor.getMarkdown()).toContain('第一段');
    editor.commands.setContent('第二段', { contentType: 'markdown' });
    expect(editor.getMarkdown()).toContain('第二段');
    editor.destroy();
  });

  test('空内容初始化不抛错', () => {
    const editor = createTestEditor('');
    expect(editor.getMarkdown()).toBeDefined();
    editor.destroy();
  });
});
