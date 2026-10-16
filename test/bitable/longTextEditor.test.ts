// NoteBoard 多维表格多行文本富文本编辑器测试
// 直接驱动 TipTap 编辑器实例验证「扩展装配 + Markdown 往返」，不依赖 DOM 渲染库：
// 真实风险在于扩展冲突或 Markdown 扩展未生效，这类问题只有跑起来才暴露

import { describe, test, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildLongTextExtensions } from '@/features/bitable/BitableRichTextEditor';
import { parseMarkdown, serializeMarkdown } from '@/features/editor-md/serialize';
import { buildExtensions } from '@/features/editor-md/extensions';

/**
 * 用与线上一致的扩展集创建编辑器
 * 与笔记本编辑器测试一致不挂载视图（jsdom 缺少部分装饰所需的布局能力）；
 * 与组件相同：先以空文档创建，再经笔记本的 parseMarkdown 管线写入（空串直接用 Markdown 解析会得到非法的空 doc）
 */
function createTestEditor(content = '') {
  const editor = new Editor({
    element: null,
    extensions: buildLongTextExtensions(),
    content: '',
  });
  parseMarkdown(editor, content);
  return editor;
}

/** 收集文档中出现的节点类型 */
function nodeTypesOf(editor: Editor): Set<string> {
  const types = new Set<string>();
  editor.state.doc.descendants((node) => {
    types.add(node.type.name);
  });
  return types;
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

  test('与笔记本共用扩展：公式、图表、提示块、任务列表、表格被识别为对应节点', () => {
    const md = [
      '行内公式 $E=mc^2$',
      '',
      '$$\n\\sum_{i=1}^n i\n$$',
      '',
      '```mermaid\ngraph TD\n  A --> B\n```',
      '',
      '> [!TIP]\n> 小技巧',
      '',
      '- [ ] 待办\n- [x] 已完成',
      '',
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
    ].join('\n');
    const editor = createTestEditor(md);
    const types = nodeTypesOf(editor);
    expect(types.has('mathInline')).toBe(true);
    expect(types.has('mathBlock')).toBe(true);
    expect(types.has('mermaidBlock')).toBe(true);
    expect(types.has('githubAlert')).toBe(true);
    expect(types.has('taskList')).toBe(true);
    expect(types.has('table')).toBe(true);
    editor.destroy();
  });

  test('扩展语法经笔记本序列化管线往返不丢失', () => {
    const md = '==高亮== 与 $x^2$\n\n> [!NOTE]\n> 说明\n\n- [x] 完成';
    const editor = createTestEditor(md);
    const output = serializeMarkdown(editor);
    expect(output).toContain('==高亮==');
    expect(output).toContain('$x^2$');
    expect(output).toContain('[!NOTE]');
    expect(output).toContain('- [x] 完成');
    editor.destroy();
  });

  test('撤销不由文件级时间线接管：Mod-z 回落到编辑器自带历史', () => {
    const names = (extensions: { name: string }[]) => extensions.map((extension) => extension.name);
    // 笔记本编辑器由文件级时间线接管撤销，单元格编辑器没有独立文档历史，必须关闭接管
    expect(names(buildExtensions('doc-key'))).toContain('unifiedDocumentHistoryKeys');
    expect(names(buildLongTextExtensions())).not.toContain('unifiedDocumentHistoryKeys');
    // 斜杠菜单与笔记本同源
    expect(names(buildLongTextExtensions())).toContain('slashCommand');
  });

  test('粘贴格式检测与笔记本一致启用', () => {
    const names = (extensions: { name: string }[]) => extensions.map((extension) => extension.name);
    expect(names(buildLongTextExtensions())).toContain('pasteFormatDetect');
    // 未显式开启的编辑器不跟踪粘贴
    expect(names(buildExtensions('doc-key'))).not.toContain('pasteFormatDetect');
  });
});
