// 主线程与后台线程共用完整 Markdown 扩展，避免为了加速而使用语法不同的简化解析器。
import { Editor } from '@tiptap/core';
import { buildExtensions } from './extensions';
import { getMarkdownManager, isMarkdownSerializationStable, parseMarkdownToJson, serializeMarkdownFromDoc, withMarkdownSourceAttributes } from './serialize';
import { computeNormalizationDiff } from './markdownNormalization';
import type { Settings } from '../../core/ipc/types';
import type { PreparedVisualDocument, PreparationStage } from './visualPreparation.worker';
import { useSettingsStore } from '../../stores/settingsStore';

/** 只创建 schema 与 MarkdownManager，不创建 DOM；各阶段间交还事件循环。 */
export async function prepareVisualDocumentData(content: string, settings: Settings, onStage: (stage: PreparationStage) => Promise<void>): Promise<PreparedVisualDocument> {
  let editor: Editor | undefined;
  try {
    if (useSettingsStore.getState().settings !== settings) useSettingsStore.setState({ settings });
    await onStage('parsing');
    editor = new Editor({ element: null, extensions: buildExtensions(), content: { type: 'doc', content: [{ type: 'paragraph' }] } });
    const parsed = parseMarkdownToJson(editor, content);
    if (!parsed) throw new Error('Markdown 解析器不可用');
    const document = withMarkdownSourceAttributes(parsed, content);
    const doc = editor.schema.nodeFromJSON(document);
    const manager = getMarkdownManager(editor);
    if (!manager) throw new Error('Markdown 序列化器不可用');
    await onStage('checking');
    const serialized = serializeMarkdownFromDoc(manager, editor.schema, doc);
    // 稳定性比较读取同一 schema 的不可变文档，不把全文提前装载到可见编辑器。
    const same = serialized === content.replace(/\r\n/g, '\n');
    const stable = same || isMarkdownSerializationStable(editor, serialized, doc);
    await onStage('comparing');
    const diff = same ? null : await computeNormalizationDiff(content, serialized);
    return { document, serialized, stable, diff };
  } finally {
    editor?.destroy();
  }
}
