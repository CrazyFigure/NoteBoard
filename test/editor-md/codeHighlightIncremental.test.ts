// 代码高亮增量更新：随机编辑后，增量维护的装饰与整篇重建的结果完全一致
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, Extension, Node } from '@tiptap/core';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import CodeBlock from '@tiptap/extension-code-block';
import { EditorState, TextSelection, type Plugin } from '@tiptap/pm/state';
import type { DecorationSet } from '@tiptap/pm/view';
import { codeHighlightPlugin } from '../../src/features/editor-md/codeHighlightPlugin';

// 最小文档节点（项目未单独依赖 @tiptap/extension-document）
const Document = Node.create({ name: 'doc', topNode: true, content: 'block+' });
const Highlight = Extension.create({ name: 'codeHighlightTest', addProseMirrorPlugins: () => [codeHighlightPlugin()] });

const editors: Editor[] = [];
afterEach(() => { editors.splice(0).forEach((editor) => editor.destroy()); });

const LANGUAGES = ['javascript', 'typescript', 'python', 'json', 'plaintext', null];
const SNIPPETS = ['const a = 1;', 'function f(x) { return x * 2 }', 'def g(y):\n    return "s"', '{"k": [1, true, null]}', 'let s = `t ${a}`', ''];

function createRandom(seed: number) {
  let state = seed;
  return () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function highlightPlugin(state: EditorState): Plugin<DecorationSet> {
  return state.plugins.find((plugin) => (plugin as unknown as { key: string }).key.startsWith('nb-code-highlight')) as Plugin<DecorationSet>;
}

/** 装饰的可比较形式：按位置排序的 [from, to, class] */
function describeSet(state: EditorState): string[] {
  const set = highlightPlugin(state).getState(state)!;
  return set.find().map((deco) => `${deco.from}-${deco.to}:${(deco as unknown as { type: { attrs: { class: string } } }).type.attrs.class}`).sort();
}

/** 整篇重建的参照结果：同一文档新建状态，插件 init 时整篇着色 */
function rebuiltSet(state: EditorState): string[] {
  return describeSet(EditorState.create({ doc: state.doc, plugins: state.plugins }));
}

async function createEditor(): Promise<Editor> {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, CodeBlock, Highlight],
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '开头' }] },
        { type: 'codeBlock', attrs: { language: 'javascript' }, content: [{ type: 'text', text: SNIPPETS[0] }] },
        { type: 'paragraph', content: [{ type: 'text', text: '中间' }] },
        { type: 'codeBlock', attrs: { language: 'python' }, content: [{ type: 'text', text: SNIPPETS[2] }] },
      ],
    },
  });
  editors.push(editor);
  // 等待 lowlight 动态加载完成并整篇着色
  for (let attempt = 0; attempt < 200 && describeSet(editor.state).length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(describeSet(editor.state).length).toBeGreaterThan(0);
  return editor;
}

/** 随机选一个代码块（及其位置） */
function pickCodeBlock(editor: Editor, random: () => number): { pos: number; size: number } | null {
  const blocks: Array<{ pos: number; size: number }> = [];
  editor.state.doc.forEach((node, pos) => { if (node.type.name === 'codeBlock') blocks.push({ pos, size: node.nodeSize }); });
  return blocks.length ? blocks[Math.floor(random() * blocks.length)] : null;
}

describe('代码高亮增量更新', () => {
  it('随机编辑后与整篇重建结果一致', async () => {
    const editor = await createEditor();
    const random = createRandom(20261104);
    const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
    const schema = editor.schema;
    const operations: Array<() => void> = [
      // 在代码块内输入
      () => {
        const block = pickCodeBlock(editor, random);
        if (!block) return;
        const at = block.pos + 1 + Math.floor(random() * (block.size - 1));
        editor.view.dispatch(editor.state.tr.insertText(pick([' x', '(', '"', '1', '\n', '//c']), at));
      },
      // 删除一段（可能跨块）
      () => {
        const size = editor.state.doc.content.size;
        const from = 1 + Math.floor(random() * Math.max(1, size - 2));
        const to = Math.min(size - 1, from + 1 + Math.floor(random() * 12));
        try { editor.view.dispatch(editor.state.tr.delete(from, to)); } catch { /* 非法范围跳过 */ }
      },
      // 插入新代码块
      () => {
        const pos = pick([0, editor.state.doc.content.size]);
        const text = pick(SNIPPETS);
        editor.view.dispatch(editor.state.tr.insert(pos, schema.nodes.codeBlock.create({ language: pick(LANGUAGES) }, text ? schema.text(text) : undefined)));
      },
      // 通过 setNodeMarkup 修改语言（与代码块语言选择一致）
      () => {
        const block = pickCodeBlock(editor, random);
        if (block) editor.view.dispatch(editor.state.tr.setNodeMarkup(block.pos, undefined, { language: pick(LANGUAGES) }));
      },
      // 通过 setNodeAttribute 修改语言（属性步骤的映射为空）
      () => {
        const block = pickCodeBlock(editor, random);
        if (block) editor.view.dispatch(editor.state.tr.setNodeAttribute(block.pos, 'language', pick(LANGUAGES)));
      },
      // 代码块转为段落
      () => {
        const block = pickCodeBlock(editor, random);
        if (block) editor.view.dispatch(editor.state.tr.setBlockType(block.pos + 1, block.pos + 1, schema.nodes.paragraph));
      },
      // 段落转为代码块
      () => {
        const paragraphs: number[] = [];
        editor.state.doc.forEach((node, pos) => { if (node.type.name === 'paragraph') paragraphs.push(pos); });
        if (paragraphs.length) {
          const pos = pick(paragraphs);
          editor.view.dispatch(editor.state.tr.setBlockType(pos + 1, pos + 1, schema.nodes.codeBlock, { language: pick(LANGUAGES) }));
        }
      },
      // 回车拆分代码块所在位置的段落 / 代码块
      () => {
        const size = editor.state.doc.content.size;
        const at = 1 + Math.floor(random() * Math.max(1, size - 2));
        try {
          const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at));
          editor.view.dispatch(tr.split(at));
        } catch { /* 无法拆分的位置跳过 */ }
      },
      // 同一事务多处修改
      () => {
        const tr = editor.state.tr;
        const blocks: number[] = [];
        tr.doc.forEach((node, pos) => { if (node.type.name === 'codeBlock') blocks.push(pos); });
        for (const pos of blocks.reverse().slice(0, 3)) tr.insertText('y', tr.mapping.map(pos + 1));
        editor.view.dispatch(tr);
      },
    ];
    for (let step = 0; step < 600; step += 1) {
      pick(operations)();
      // 文档不能为空：被删光时补一个段落
      if (editor.state.doc.childCount === 0) editor.view.dispatch(editor.state.tr.insert(0, schema.nodes.paragraph.create()));
      expect(describeSet(editor.state), `第 ${step} 步`).toEqual(rebuiltSet(editor.state));
    }
  });
});
