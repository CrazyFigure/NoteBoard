// 可视化模式选区增强：让「哪些块被完整选中」一目了然
//
// 浏览器原生 ::selection 只给文字字符上色，代码块外框、折叠块标题、列表符号、图片、
// 公式、图表、分割线、空行等都看不出是否被选中，删除前只能靠猜。
// 本插件在选区跨越多个文本块（或全选 / 选中整个块节点）时，给被完整覆盖的块
// 加上 nb-sel-block 节点装饰，由 CSS 绘制统一的底板；部分覆盖的块仍保留文字高亮。
// 视觉语义：整块底板 = 删除时整块消失；文字高亮 = 只删除高亮部分。

import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, Plugin, PluginKey, Selection, type EditorState } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const selectionHighlightKey = new PluginKey<DecorationSet>('nbSelectionHighlight');

const BLOCK_CLASS = 'nb-sel-block';
const INLINE_CLASS = 'nb-sel-inline';

/**
 * 块节点是否被选区完整覆盖。
 * 文本选区的端点只能落在文本块内部，因此以节点内首个 / 末个可放置光标的位置为边界判断，
 * 而非节点的外沿位置；不含任何文本块的节点（图片、图表、分割线等）要求选区跨过整个节点。
 */
function isBlockFullyCovered(doc: ProseMirrorNode, node: ProseMirrorNode, pos: number, from: number, to: number): boolean {
  const end = pos + node.nodeSize;
  if (from <= pos && to >= end) return true;
  if (node.isAtom) return false;

  const first = Selection.findFrom(doc.resolve(pos), 1, true);
  const last = Selection.findFrom(doc.resolve(end), -1, true);
  // 节点内部没有可放光标的文本位置：只能按外沿判断（上面已判定未覆盖）
  if (!first || !last || first.from >= end || last.to <= pos) return false;
  return from <= first.from && to >= last.to;
}

function buildDecorations(state: EditorState): DecorationSet {
  const { selection, doc } = state;
  if (selection.empty || selection instanceof CellSelection) return DecorationSet.empty;

  // 选中整个块节点（拖拽排序后、点击图表等）：直接给该节点加底板；行内节点保留各自的选中样式
  if (selection instanceof NodeSelection) {
    if (!selection.node.isBlock) return DecorationSet.empty;
    return DecorationSet.create(doc, [
      Decoration.node(selection.from, selection.to, { class: BLOCK_CLASS }),
    ]);
  }

  // 选区只在单个文本块内：原生文字高亮已足够清晰，不切换为块底板，避免选中一整行时视觉突变
  if (!(selection instanceof AllSelection) && selection.$from.sameParent(selection.$to)) {
    return DecorationSet.empty;
  }

  const { from, to } = selection;
  const decorations: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isBlock) {
      // 只装饰最外层的完整覆盖块，内部子块随之一并呈现，避免底板层层叠加变深
      if (isBlockFullyCovered(doc, node, pos, from, to)) {
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: BLOCK_CLASS }));
        return false;
      }
      return true;
    }
    // 部分覆盖的文本块内：行内原子节点（公式、脚注引用、行内 HTML 图片）没有文字可高亮，单独标记
    if (node.isAtom && !node.isText && from <= pos && to >= pos + node.nodeSize) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: INLINE_CLASS }));
    }
    return false;
  });

  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/** 选区可视化增强扩展 */
export const SelectionHighlight = Extension.create({
  name: 'nbSelectionHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: selectionHighlightKey,
        state: {
          init: (_config, state) => buildDecorations(state),
          // 仅在选区或文档变化时重算，其余事务（如元数据同步）沿用上一次结果
          apply(tr, decorations, oldState, newState) {
            if (!tr.docChanged && oldState.selection.eq(newState.selection)) return decorations;
            return buildDecorations(newState);
          },
        },
        props: {
          decorations: (state) => selectionHighlightKey.getState(state),
        },
      }),
    ];
  },
});
