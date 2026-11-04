// 分批装载与补尾段插件：批次之间插入的其它事务（如代码高亮异步回填）不能在半篇末尾补出空段落。
// 完整扩展集无法在 jsdom 中挂载视图（无界面编辑器不注册任何插件），这里用挂载到 DOM 的最小扩展集验证插件交互。
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, Node, type JSONContent } from '@tiptap/core';
import Paragraph from '@tiptap/extension-paragraph';
import Heading from '@tiptap/extension-heading';
import Text from '@tiptap/extension-text';
import { MarkdownTrailingNode } from '../../src/features/editor-md/markdownTrailingNode';
import { mountVisualDocument } from '../../src/features/editor-md/visualPreparation';

// 最小文档节点（项目未单独依赖 @tiptap/extension-document）
const Document = Node.create({ name: 'doc', topNode: true, content: 'block+' });

const editors: Editor[] = [];
afterEach(() => { editors.splice(0).forEach((editor) => editor.destroy()); });

function createEditor(): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Heading, Text, MarkdownTrailingNode],
    content: '',
  });
  editors.push(editor);
  return editor;
}

// 全部为标题：任一批次结束时文末都不是段落，补尾段插件若未暂停就会在此补出空段
const headings = (count: number): JSONContent => ({
  type: 'doc',
  content: Array.from({ length: count }, (_, index) => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `标题 ${index}` }] })),
});

/** 顶层节点类型序列，辅助段标记为 `paragraph*` */
function blockTypes(editor: Editor): string[] {
  const types: string[] = [];
  editor.state.doc.forEach((node) => types.push(node.type.name + (node.attrs.sourceTrailingPlaceholder ? '*' : '')));
  return types;
}

/** 与代码高亮异步回填相同：不改文档、不带 skipTrailingNode 的元数据事务 */
const dispatchUnrelated = (editor: Editor) => editor.view.dispatch(editor.state.tr.setMeta('nb-code-highlight$', { refresh: true }));

describe('分批装载期间暂停补尾段', () => {
  it('批次之间插入其它事务，只在文末补一个辅助段', async () => {
    const editor = createEditor();
    expect(editor.state.plugins.some((plugin) => (plugin as unknown as { key: string }).key.startsWith('markdownTrailingNode'))).toBe(true);
    let batches = 0;
    await mountVisualDocument(editor, headings(1000), new AbortController().signal, () => {
      batches += 1;
      dispatchUnrelated(editor);
    }, { current: false });
    expect(batches).toBeGreaterThan(2);
    expect(blockTypes(editor)).toEqual([...Array.from({ length: 1000 }, () => 'heading'), 'paragraph*']);
  });

  it('取消装载后恢复补尾段，编辑器继续使用时照常补出辅助段', async () => {
    const editor = createEditor();
    const controller = new AbortController();
    await expect(mountVisualDocument(editor, headings(1000), controller.signal, () => {
      dispatchUnrelated(editor);
      controller.abort();
    }, { current: false })).rejects.toMatchObject({ name: 'AbortError' });
    // 恢复事务按当时的半篇补出辅助段，此后不再暂停
    expect(blockTypes(editor).at(-1)).toBe('paragraph*');
    editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, editor.schema.nodes.heading.create({ level: 1 }, editor.schema.text('新'))));
    expect(blockTypes(editor).at(-1)).toBe('paragraph*');
  });
});
