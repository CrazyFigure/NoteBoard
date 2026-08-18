// NoteBoard Markdown 编辑器扩展装配点
// 唯一装配处：所有 TipTap 扩展在此注册
// 详见 docs/09-开发路线图.md 7.1
//
// 移植自 note-gen，但只取最小扩展集，不整文件搬。
// 主动剔除：AI 补全/建议/diff 预览、sync/、SQLite 层、全局单例 tab 状态。

import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import Typography from '@tiptap/extension-typography';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table';
import { TableHeader } from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';
import { Markdown } from '@tiptap/markdown';

import { CodeBlockView } from '../codeBlockView';
import { lowlight } from '../lowlight';
import { searchReplaceExtension } from '../searchReplace';
import { MathInline, MathBlock } from '../katexExtensions';
import { MermaidBlock } from '../mermaidExtension';
import { GitHubAlert } from '../alertExtension';
import { slashSuggestion } from '../slashCommand';

import Suggestion from '@tiptap/suggestion';
import { Extension, type Extensions } from '@tiptap/core';
import { Plugin, NodeSelection } from '@tiptap/pm/state';

/**
 * 顶层块拖拽安全重排序扩展
 * 拦截来自 BlockDragHandle 的拖拽 drop 事件
 * 确保永远只在顶层块之间进行重排序，坚决杜绝任何内容掉入表格单元格（td）或破坏列表结构
 */
const BlockReorder = Extension.create({
  name: 'blockReorder',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDrop(view, event) {
            const dragData = event.dataTransfer?.getData('application/x-noteboard-block-drag');
            if (!dragData) {
              return false;
            }

            event.preventDefault();
            event.stopPropagation();

            const { state, dispatch } = view;
            const { doc, selection } = state;

            // 1. 获取被拖拽的源节点与范围
            let fromPos: number | null = null;
            try {
              const parsed = JSON.parse(dragData);
              fromPos = typeof parsed.pos === 'number' ? parsed.pos : null;
            } catch {
              // ignore
            }

            if (fromPos === null && selection instanceof NodeSelection) {
              fromPos = selection.from;
            }

            if (fromPos === null || fromPos < 0) return false;
            const sourceNode = doc.nodeAt(fromPos);
            if (!sourceNode) return false;
            const sourceSize = sourceNode.nodeSize;
            const toPos = fromPos + sourceSize;

            // 2. 解析 drop 屏幕坐标对应的顶层块元素
            const clientX = event.clientX;
            const clientY = event.clientY;
            const editorDom = view.dom;

            let targetEl = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
            if (!targetEl || !editorDom.contains(targetEl)) return false;

            // 向上追溯到 ProseMirror 的直接顶层子节点
            while (targetEl && targetEl.parentElement && targetEl.parentElement !== editorDom) {
              targetEl = targetEl.parentElement;
            }
            if (!targetEl || targetEl === editorDom) return false;

            let targetTopPos: number;
            try {
              const domPos = view.posAtDOM(targetEl, 0);
              const $p = doc.resolve(domPos);
              targetTopPos = $p.depth === 0 ? domPos : $p.before(1);
            } catch {
              return false;
            }

            const targetNode = doc.nodeAt(targetTopPos);
            if (!targetNode) return false;

            // 3. 计算在目标顶层块上方还是下方插入
            const targetRect = targetEl.getBoundingClientRect();
            const isAfter = clientY > targetRect.top + targetRect.height / 2;
            const insertPos = isAfter ? targetTopPos + targetNode.nodeSize : targetTopPos;

            // 如果 drop 的位置就是原节点内部或原位置，无需移动
            if (insertPos >= fromPos && insertPos <= toPos) {
              (view as unknown as { dragging: unknown }).dragging = null;
              return true;
            }

            // 4. 构建原子事务安全移动（统一先物理删除旧节点，再在目标位置精确插入）
            const tr = state.tr;
            if (insertPos < fromPos) {
              // 向上移动：先删除原位置节点，再在新位置插入
              tr.delete(fromPos, toPos);
              tr.insert(insertPos, sourceNode);
              tr.setSelection(NodeSelection.create(tr.doc, insertPos));
            } else {
              // 向下移动：先物理删除原位置节点，由于原节点已被移除，目标插入点前移 sourceSize
              tr.delete(fromPos, toPos);
              const mappedInsertPos = insertPos - sourceSize;
              tr.insert(mappedInsertPos, sourceNode);
              tr.setSelection(NodeSelection.create(tr.doc, mappedInsertPos));
            }

            dispatch(tr);
            (view as unknown as { dragging: unknown }).dragging = null;
            view.focus();
            return true;
          },
        },
      }),
    ];
  },
});

/**
 * 构建 TipTap 扩展列表
 * 这是唯一的扩展装配点，不分散到各组件
 */
export function buildExtensions(): Extensions {
  return [
    // StarterKit 包含：bold, italic, strike, code, heading, bulletList, orderedList,
    // listItem, blockquote, horizontalRule, history, paragraph, text, document,
    // 但不含 codeBlock（我们用自定义的）
    StarterKit.configure({
      codeBlock: false, // 用自定义的 CodeBlockView
      link: {
        openOnClick: false,
        HTMLAttributes: {
          rel: 'noopener noreferrer',
          target: '_blank',
        },
      },
      dropcursor: {
        width: 2,
        color: 'var(--editor-accent)',
        class: 'nb-dropcursor',
      },
    }),

    // 基础标记（StarterKit 不含的）
    Image.configure({
      inline: true,
      allowBase64: false,
    }),
    // 文本高亮扩展（支持多色配置）
    Highlight.configure({
      multicolor: true,
    }),

    // 占位符
    Placeholder.configure({
      placeholder: '开始输入，或键入 / 插入内容…',
      emptyEditorClass: 'is-empty',
    }),

    // 字数统计
    CharacterCount,

    // 任务列表
    TaskList,
    TaskItem.configure({
      nested: true,
      HTMLAttributes: {
        'data-type': 'taskItem',
      },
    }),

    // 表格
    Table.configure({
      resizable: true,
      HTMLAttributes: {
        class: 'nb-table',
      },
    }),
    TableRow,
    TableCell,
    TableHeader,

    // 顶层块拖拽安全重排序扩展
    BlockReorder,

    // 代码块（自定义 NodeView，带语言选择和复制按钮）
    CodeBlockView.configure({
      lowlight,
    } as Record<string, unknown>),

    // 查找/替换
    searchReplaceExtension(),

    // KaTeX 数学公式
    MathInline,
    MathBlock,

    // Mermaid 图表
    MermaidBlock,

    // GitHub Alerts
    GitHubAlert,

    // 斜杠命令
    Extension.create({
      name: 'slashCommand',
      addOptions() {
        return {
          suggestion: slashSuggestion,
        };
      },
      addProseMirrorPlugins() {
        return [
          Suggestion({
            editor: this.editor,
            ...this.options.suggestion,
          }),
        ];
      },
    }),

    // Markdown 序列化/解析扩展
    Markdown,
  ];
}
