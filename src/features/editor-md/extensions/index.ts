// NoteBoard Markdown 编辑器扩展装配点
// 唯一装配处：所有 TipTap 扩展在此注册
// 详见 docs/09-开发路线图.md 7.1
//
// 采用最小扩展集装配。
// 不包含：AI 补全/建议/diff 预览、sync/、SQLite 层、全局单例 tab 状态。

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
import { handleLinkClick, resolveRelativeDocPath } from '../linkHandler';
import { useDocumentStore } from '../../../stores/documentStore';
import { useWindowStore } from '../../../stores/windowStore';
import { useExplorerStore } from '../../explorer/explorerStore';
import { convertFileSrc } from '@tauri-apps/api/core';

import Suggestion from '@tiptap/suggestion';
import { Extension, type Extensions } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

/**
 * 链接点击分发扩展
 * 统一拦截编辑区 a 标签的点击事件，外部链接调用系统默认浏览器，本地文件链接在 NoteBoard 内部打开
 */
const LinkClickHandler = Extension.create({
  name: 'linkClickHandler',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleClick(_view, _pos, event) {
            const target = event.target as HTMLElement | null;
            const anchor = target?.closest('a');
            if (anchor) {
              const href = anchor.getAttribute('href');
              if (href) {
                event.preventDefault();
                event.stopPropagation();
                const activeKey = useWindowStore.getState().activeKey;
                if (activeKey) {
                  handleLinkClick(href, activeKey);
                }
                return true;
              }
            }
            return false;
          },
        },
      }),
    ];
  },
});

import { EnhancedImageBlock } from '../imageNodeView';

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

    // 链接点击分发处理器（阻止原生页面跳失与错误，支持外部与本地文件无缝打开）
    LinkClickHandler,

    // 本地图片增强扩展（支持 Base64、本地相对路径 Asset 解析、大图预览与排版调节）
    EnhancedImageBlock,
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
