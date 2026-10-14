// NoteBoard Markdown 编辑器：把选区所在的块转换为代码块 / 容器块（提示块、高亮块、折叠块）
// 供右键菜单「转为 …」使用；与「转为标题 / 引用块」一样按整块转换，不拆分段落

import { getTextBetween, getTextSerializersFromSchema, type Editor } from '@tiptap/core';
import { NodeRange, type NodeType } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { findWrapping } from '@tiptap/pm/transform';

/**
 * 用容器块（content 为 block+）包裹选区覆盖的所有块
 * 选区所在层级不允许直接包裹时（如列表项首段必须是段落）逐级向外扩大范围，直至能包裹为止
 */
export function wrapSelectionInBlock(editor: Editor, typeName: string, attrs: Record<string, unknown>): boolean {
  const type = editor.schema.nodes[typeName];
  if (!type) return false;
  // 结果以文档修改是否成功为准（聚焦失败不影响操作本身）
  let applied = false;
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      const { $from, $to } = tr.selection;
      let range = $from.blockRange($to);
      while (range) {
        const wrapping = findWrapping(range, type, attrs);
        if (wrapping) {
          tr.wrap(range, wrapping).scrollIntoView();
          applied = true;
          return true;
        }
        range = range.depth > 0 ? new NodeRange($from, $to, range.depth - 1) : null;
      }
      return false;
    })
    .run();
  return applied;
}

/** 选区是否整体位于同一个代码块内 */
function isSelectionInCodeBlock(editor: Editor, codeBlock: NodeType): boolean {
  const { $from, $to } = editor.state.selection;
  return $from.parent.type === codeBlock && $from.sameParent($to);
}

/**
 * 把选区覆盖的所有块合并成一个代码块：每个块的纯文本占一行，公式等原子节点按其 renderText 保留源码
 * 选区已在代码块内时与工具栏一致，切换回普通段落
 */
export function convertSelectionToCodeBlock(editor: Editor): boolean {
  const codeBlock = editor.schema.nodes.codeBlock;
  if (!codeBlock) return false;
  // 结果以文档修改是否成功为准（聚焦失败不影响操作本身）
  let applied = false;
  if (isSelectionInCodeBlock(editor, codeBlock)) {
    editor
      .chain()
      .focus()
      .command(({ commands }) => (applied = commands.toggleCodeBlock()))
      .run();
    return applied;
  }
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      const { $from, $to } = tr.selection;
      let range = $from.blockRange($to);
      // 逐级向外寻找允许放入代码块的层级（列表项首段等位置不能直接替换为代码块）
      while (range && !range.parent.canReplaceWith(range.startIndex, range.endIndex, codeBlock)) {
        range = range.depth > 0 ? new NodeRange($from, $to, range.depth - 1) : null;
      }
      if (!range) return false;
      const textSerializers = getTextSerializersFromSchema(editor.schema);
      const lines: string[] = [];
      // 只按文本块逐行收集：列表等嵌套容器若按块分隔会在每层都插入换行，产生多余空行
      tr.doc.nodesBetween(range.start, range.end, (node, pos, parent, index) => {
        if (node.isTextblock) {
          lines.push(getTextBetween(node, { from: 0, to: node.content.size }, { textSerializers }));
          return false;
        }
        // 块级原子节点（如块级公式）按其 renderText 保留源码
        if (node.isBlock && node.isLeaf) {
          const serialize = textSerializers[node.type.name];
          if (serialize && parent) lines.push(serialize({ node, pos, parent, index, range: { from: pos, to: pos + node.nodeSize } }));
          return false;
        }
        return true;
      });
      const code = lines.join('\n');
      const node = codeBlock.create(null, code ? editor.schema.text(code) : null);
      tr.replaceWith(range.start, range.end, node);
      // 光标放到新代码块末尾，便于继续编辑
      tr.setSelection(TextSelection.create(tr.doc, range.start + 1 + code.length)).scrollIntoView();
      applied = true;
      return true;
    })
    .run();
  return applied;
}
