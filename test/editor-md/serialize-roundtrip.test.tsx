// NoteBoard Markdown 序列化真实往返集成测试
//
// 目的：堵住"扩展装配漏挂"这类 bug 的回归口子。
// 之前的 serialize.test.ts 只测 BaselineManager 纯逻辑，把 serialize 结果
// 用 mock 直接当成原样，导致 @tiptap/markdown 未注册时仍能通过。
//
// 这里创建真实的 TipTap Editor 实例（jsdom 环境），用最小扩展集
// （StarterKit + Markdown，不引入 React NodeView），验证：
// 1. editor.storage.markdown 真的存在（@tiptap/markdown 扩展已注册）
// 2. parseMarkdown → serializeMarkdown 往返不丢 #、-、``` 等关键 markdown 语法
//
// 注：不通过 buildExtensions() 是为了绕开 codeBlockView.tsx 的 React 依赖，
//     它的 vite-plugin-react preamble 在 vitest 下不稳定。
//     buildExtensions() 的 E2E 覆盖留给 WebdriverIO。
//
// 关联：docs/09-开发路线图.md 7.5, gate:7

import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { serializeMarkdown, parseMarkdown } from '../../src/features/editor-md/serialize';

// 创建一个真实 TipTap editor 实例用于往返测试
// 用最小扩展集，专注验证 Markdown 扩展注册与序列化往返
function createEditor(): Editor {
  return new Editor({
    extensions: [StarterKit, Markdown],
    content: '',
  });
}

describe('serialize 真实往返集成（真实 TipTap Editor）', () => {
  it('editor.getMarkdown 存在（@tiptap/markdown 扩展已注册）', () => {
    const editor = createEditor();
    // @tiptap/markdown 把 getMarkdown 注入到 Editor 实例上
    // （不是 editor.storage.markdown.getMarkdown，那是 { manager } 结构）
    const getMarkdown = (editor as unknown as { getMarkdown?: () => string }).getMarkdown;
    expect(typeof getMarkdown).toBe('function');
    editor.destroy();
  });

  it('空内容解析不抛错（新建文档路径，曾致整窗白屏）', () => {
    const editor = createEditor();
    // 回归：@tiptap/markdown 的 parse('') 返回 {type:'doc',content:[]}，
    // 违反 doc 的 block+ 约束，setContent 直接抛 RangeError。
    // parseMarkdown 必须对空白内容走 clearContent 守卫。
    expect(() => parseMarkdown(editor, '')).not.toThrow();
    expect(() => parseMarkdown(editor, '   \n  ')).not.toThrow();
    const out = serializeMarkdown(editor);
    expect(out).toBe('');
    editor.destroy();
  });

  it('H1 标题往返不丢 # 前缀', () => {
    const editor = createEditor();
    const md = '# 一级标题\n';
    parseMarkdown(editor, md);
    const out = serializeMarkdown(editor);
    expect(out.trim()).toBe('# 一级标题');
    editor.destroy();
  });

  it('多级标题往返', () => {
    const editor = createEditor();
    const md = '# H1\n\n## H2\n\n### H3\n';
    parseMarkdown(editor, md);
    const out = serializeMarkdown(editor);
    expect(out).toContain('# H1');
    expect(out).toContain('## H2');
    expect(out).toContain('### H3');
    editor.destroy();
  });

  it('有序/无序列表往返不丢列表标记', () => {
    const editor = createEditor();
    const md = '- Item 1\n- Item 2\n\n1. First\n2. Second\n';
    parseMarkdown(editor, md);
    const out = serializeMarkdown(editor);
    expect(out).toMatch(/-\s+Item 1/);
    expect(out).toMatch(/-\s+Item 2/);
    expect(out).toMatch(/\d+\.\s+First/);
    expect(out).toMatch(/\d+\.\s+Second/);
    editor.destroy();
  });

  it('代码围栏往返不丢 ``` 标记', () => {
    const editor = createEditor();
    const md = '```js\nconst x = 1;\n```\n';
    parseMarkdown(editor, md);
    const out = serializeMarkdown(editor);
    expect(out).toContain('```');
    expect(out).toContain('const x = 1');
    editor.destroy();
  });

  it('粗体/斜体往返不丢标记', () => {
    const editor = createEditor();
    const md = '**bold** *italic*\n';
    parseMarkdown(editor, md);
    const out = serializeMarkdown(editor);
    expect(out).toContain('**bold**');
    expect(out).toContain('*italic*');
    editor.destroy();
  });

  it('setext 标题往返（=== 下划线形式 → ATX 形式）', () => {
    const editor = createEditor();
    const md = 'Title\n=====\n';
    parseMarkdown(editor, md);
    const out = serializeMarkdown(editor);
    // setext 标题解析为 heading，序列化为 ATX 形式 # Title
    expect(out).toMatch(/^#\s+Title/m);
    editor.destroy();
  });

  it('引用块往返', () => {
    const editor = createEditor();
    const md = '> This is a quote\n';
    parseMarkdown(editor, md);
    const out = serializeMarkdown(editor);
    expect(out).toMatch(/^>\s+This is a quote/m);
    editor.destroy();
  });

  it('分割线往返', () => {
    const editor = createEditor();
    const md = 'Before\n\n---\n\nAfter\n';
    parseMarkdown(editor, md);
    const out = serializeMarkdown(editor);
    expect(out).toMatch(/^---$/m);
    editor.destroy();
  });
});
