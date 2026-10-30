// @vitest-environment node
// 无 window/document 的环境必须能完整解析；禁止仅靠 jsdom 掩盖界面依赖。
import { expect, it } from 'vitest';
import { prepareVisualDocumentData } from '../../src/features/editor-md/visualPreparationData';

it('无 DOM、store 和原生桥接也能准备含图表与非标准缩进的文档', async () => {
  expect(typeof window).toBe('undefined');
  const content = '# 标题\n\n- 一\n  - 子项\n\n```mermaid\ngraph TD; A-->B\n```\n\n$x$ 与 [[笔记]]\n';
  const prepared = await prepareVisualDocumentData(content, async () => {});
  expect(prepared.stable).toBe(true);
  expect(prepared.serialized).toContain('```mermaid\ngraph TD; A-->B\n```');
  expect(prepared.document.content?.some((node) => node.type === 'mermaidBlock')).toBe(true);
});
