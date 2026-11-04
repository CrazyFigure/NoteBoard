// 两端共用完整 Markdown 核心规则；后台准备不创建节点视图，也不读取或改写应用 store。
import { Editor } from '@tiptap/core';
import { buildCoreExtensions } from './extensions/core';
import { parseMarkdownToJson, withMarkdownSourceAttributes } from './serialize';
import type { PreparedVisualDocument, PreparationStage } from './visualPreparation.worker';

/**
 * 只创建 schema 与 MarkdownManager，不创建 DOM。
 * 解析时一并记录顶层块原文（doc 属性 sourceBlocks），挂载后未编辑的块按原文写回，无需再整篇回写比对。
 */
export async function prepareVisualDocumentData(content: string, onStage: (stage: PreparationStage) => Promise<void>): Promise<PreparedVisualDocument> {
  let editor: Editor | undefined;
  try {
    await onStage('parsing');
    editor = new Editor({ element: null, extensions: buildCoreExtensions(), content: { type: 'doc', content: [{ type: 'paragraph' }] } });
    const parsed = parseMarkdownToJson(editor, content, { recordSource: true });
    if (!parsed) throw new Error('Markdown 解析器不可用');
    return { document: withMarkdownSourceAttributes(parsed, content) };
  } finally {
    editor?.destroy();
  }
}
