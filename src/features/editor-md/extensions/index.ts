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
import TaskList from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-list';
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
    Highlight,

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
