// NoteBoard 🔴 J2 visual 快照与纯适配器测试
// 覆盖：纯适配器与旧实现输出逐字等价（roundtrip fixture）、快照独立于后续编辑
//       （不读"此刻的 editor.state.doc"）、输入热路径零全文工作、组内合并、
//       跨组保留（undo 回到中间组末端）、undo 前物化钩子。

import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Code } from '@tiptap/extension-code';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import {
  serializeMarkdown,
  serializeMarkdownFromDoc,
  parseMarkdown,
  getMarkdownManager,
} from '../../src/features/editor-md/serialize';

/** 创建真实 TipTap editor（最小扩展集——绕开 React NodeView，见 serialize-roundtrip.test.tsx 说明） */
function createEditor(): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({ code: false }),
      Code.extend({ excludes: '' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown,
    ],
    content: '',
  });
}

// ── 纯适配器等价与快照独立性（真实 TipTap 内核） ──

describe('🔴 J2 纯适配器 serializeMarkdownFromDoc', () => {
  const fixtures = [
    '# 标题\n\n段落 **加粗**、*斜体*、`行内代码`',
    '- 列表项一\n- 列表项二\n  - 嵌套项\n',
    '```ts\nconst a = 1;\nconsole.log(a);\n```\n',
    '路径 C:\\Users\\test 与转义 \\*星号\\*、[链接](https://example.com)',
    '| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n',
  ];

  it.each(fixtures)('与 serializeMarkdown(editor) 输出逐字等价：%s', (markdown) => {
    const editor = createEditor();
    try {
      parseMarkdown(editor, markdown);
      const manager = getMarkdownManager(editor);
      expect(manager).not.toBeNull();
      const viaEditor = serializeMarkdown(editor);
      // 纯适配器读捕获的不可变 doc 快照
      const viaSnapshot = serializeMarkdownFromDoc(manager!, editor.schema, editor.state.doc);
      expect(viaSnapshot).toBe(viaEditor);
    } finally {
      editor.destroy();
    }
  });

  it('快照独立于后续编辑：捕获后继续输入，序列化仍返回捕获时刻内容', () => {
    const editor = createEditor();
    try {
      parseMarkdown(editor, '第一版内容');
      const manager = getMarkdownManager(editor)!;
      const schema = editor.schema;
      // 捕获快照（J2 热路径的 O(1) 引用）
      const snapshot = editor.state.doc;
      // 捕获后继续编辑（旧实现的错误来源：物化时读"此刻"的 editor.state.doc）
      parseMarkdown(editor, '完全不同的第二版内容\n\n# 新标题');
      expect(serializeMarkdownFromDoc(manager, schema, snapshot)).toBe('第一版内容');
      expect(serializeMarkdown(editor)).not.toBe('第一版内容');
    } finally {
      editor.destroy();
    }
  });

  it('转义策略临时替换同步独占并在 finally 恢复（不跨快照泄漏）', () => {
    const editor = createEditor();
    try {
      parseMarkdown(editor, '含 \\*转义\\* 的正文');
      const manager = getMarkdownManager(editor)!;
      const original = manager.escapeMarkdownSyntax;
      serializeMarkdownFromDoc(manager, editor.schema, editor.state.doc);
      expect(manager.escapeMarkdownSyntax).toBe(original);
    } finally {
      editor.destroy();
    }
  });
});

// ── 快照暂存与组语义（mock 内核执行真实 VisualKernel onUpdate）──
//    热路径断言（零全文工作/组内合并/跨组保留/undo 前物化）在 visualHotPath.test.tsx
//    （mock 必须在模块加载前声明，与真实 TipTap import 无法共存于同一文件）。
