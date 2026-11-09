// @vitest-environment node
// 无 window/document 的环境必须能完整解析；禁止仅靠 jsdom 掩盖界面依赖。
import { expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildCoreExtensions } from '../../src/features/editor-md/extensions/core';
import { getMarkdownManager, serializeMarkdownFromDoc } from '../../src/features/editor-md/serialize';
import { prepareVisualDocumentData } from '../../src/features/editor-md/visualPreparationData';

it('无 DOM、store 和原生桥接也能准备含图表与非标准缩进的文档', async () => {
  expect(typeof window).toBe('undefined');
  const content = '# 标题\n\n- 一\n  - 子项\n\n```mermaid\ngraph TD; A-->B\n```\n\n$x$ 与 [[笔记]] 和 \\(\\frac{a}{b}\\)\n\n\\[\nx^2 + y^2\n\\]\n';
  const prepared = await prepareVisualDocumentData(content, async () => {});
  expect(prepared.document.content?.some((node) => node.type === 'mermaidBlock')).toBe(true);
  // 后台解析与主线程共用公式规则，LaTeX 定界符不能提前作为 Markdown 转义丢失。
  expect(prepared.document.content?.some((node) => node.content?.some((child) => child.type === 'mathInline' && child.attrs?.latex === '\\frac{a}{b}'))).toBe(true);
  expect(prepared.document.content?.some((node) => node.type === 'mathBlock' && node.attrs?.latex === 'x^2 + y^2')).toBe(true);
  expect(prepared.document.attrs?.sourceBlocks).not.toBeNull();
  // 同一后台内核按原文记录序列化，未编辑时逐字一致
  const editor = new Editor({ element: null, extensions: buildCoreExtensions(), content: { type: 'doc', content: [{ type: 'paragraph' }] } });
  try {
    const doc = editor.schema.nodeFromJSON(prepared.document);
    expect(serializeMarkdownFromDoc(getMarkdownManager(editor)!, editor.schema, doc)).toBe(content);
  } finally {
    editor.destroy();
  }
});
