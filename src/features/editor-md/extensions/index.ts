// NoteBoard Markdown 编辑器扩展装配点
// 唯一装配处：所有 TipTap 扩展在此注册
// 详见 docs/09-开发路线图.md 7.1
//
// 采用最小扩展集装配。
// 不包含：AI 补全/建议/diff 预览、sync/、SQLite 层、全局单例 tab 状态。

import StarterKit from '@tiptap/starter-kit';
import { Code } from '@tiptap/extension-code';
// 引入图片扩展的类型增强，使自定义图片节点的 setImage 命令在全局链式 API 中可见。
import '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
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
import { PlantUmlBlock } from '../../plantuml/plantumlExtension';
import { InfographicBlock } from '../infographicExtension';
import { GitHubAlert } from '../alertExtension';
import { slashSuggestion } from '../slashCommand';

import { handleLinkClick } from '../linkHandler';
import { TableClipboard } from '../tableClipboard';
import { useWindowStore } from '../../../stores/windowStore';

import Suggestion from '@tiptap/suggestion';
import { Extension, type Extensions } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import {
  redoDocumentHistory,
  undoDocumentHistory,
} from '../../history/documentHistory';

export interface LinkClickHandlerOptions {
  onOpenLinkModal?: () => void;
}

/**
 * 链接点击分发扩展
 * 统一拦截编辑区 a 标签的点击事件：
 * 1. Ctrl / Cmd + 左键单击：外部链接调用系统默认浏览器，本地文件链接在 NoteBoard 内打开
 * 2. 普通左键单击：唤起超链接编辑/插入模态弹窗
 */
const LinkClickHandler = Extension.create<LinkClickHandlerOptions>({
  name: 'linkClickHandler',
  addOptions() {
    return {
      onOpenLinkModal: undefined,
    };
  },
  addProseMirrorPlugins() {
    const extensionOptions = this.options;
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            click(view, event) {
              const target = event.target as HTMLElement | null;
              const anchor = target?.closest('a');
              if (anchor) {
                const href = anchor.getAttribute('href');
                event.preventDefault();
                event.stopPropagation();

                if (event.button === 0) {
                  // 1. Ctrl / Cmd + 单击：触发链接跳转
                  if (event.ctrlKey || event.metaKey) {
                    if (href) {
                      const activeKey = useWindowStore.getState().activeKey;
                      if (activeKey) {
                        handleLinkClick(href, activeKey);
                      }
                    }
                  } else {
                    // 2. 普通左键单击：定位光标并唤起超链接编辑弹窗
                    const posAtCoord = view.posAtCoords({ left: event.clientX, top: event.clientY });
                    if (posAtCoord) {
                      view.dispatch(
                        view.state.tr.setSelection(
                          TextSelection.create(view.state.doc, posAtCoord.pos)
                        )
                      );
                    }
                    if (extensionOptions.onOpenLinkModal) {
                      extensionOptions.onOpenLinkModal();
                    }
                  }
                }
                return true;
              }
              return false;
            },
            auxclick(_view, event) {
              // 拦截鼠标中键等辅助按键，防止触发原生导航
              const target = event.target as HTMLElement | null;
              const anchor = target?.closest('a');
              if (anchor) {
                event.preventDefault();
                event.stopPropagation();
                return true;
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

/**
 * 文档级统一撤销/重做快捷键。
 * 高优先级拦截 TipTap 自带快捷键，让可视化与源码模式始终沿同一条文件历史移动。
 */
const UnifiedDocumentHistoryKeys = Extension.create<{ docKey: string }>({
  name: 'unifiedDocumentHistoryKeys',
  priority: 1000,
  addOptions() {
    return { docKey: '' };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-z': () => {
        undoDocumentHistory(this.options.docKey);
        return true;
      },
      'Mod-y': () => {
        redoDocumentHistory(this.options.docKey);
        return true;
      },
      'Shift-Mod-z': () => {
        redoDocumentHistory(this.options.docKey);
        return true;
      },
    };
  },
});

import { EnhancedImageBlock } from '../imageNodeView';

export interface BuildExtensionsOptions {
  onOpenLinkModal?: () => void;
}

// Markdown 允许粗体、斜体等标记包裹行内代码；默认 Code 的 excludes: '_'
// 会让合法的 **文字 `code`** 在解析时生成非法 marks，并触发整篇纯文本降级。
const MarkdownCompatibleCode = Code.extend({
  excludes: '',
});

/**
 * 构建 TipTap 扩展列表
 * 这是唯一的扩展装配点，不分散到各组件
 */
export function buildExtensions(docKey = '', options?: BuildExtensionsOptions): Extensions {
  return [
    // StarterKit 包含：bold, italic, strike, code, heading, bulletList, orderedList,
    // listItem, blockquote, horizontalRule, history, paragraph, text, document,
    // 但不含 codeBlock（我们用自定义的）
    StarterKit.configure({
      // 改由允许 Markdown 标记嵌套的 Code 扩展注册，避免同名扩展和 schema 冲突
      code: false,
      codeBlock: false, // 用自定义的 CodeBlockView
      // 缩短连续输入的合并窗口，并保留更多编辑步骤；保存操作不会重建该历史栈
      undoRedo: {
        depth: 200,
        newGroupDelay: 300,
      },
      link: {
        openOnClick: false,
        HTMLAttributes: {
          rel: 'noopener noreferrer',
          target: null, // 🔴 必须为 null，绝不能设置 _blank，避免 WebView2 底层触发系统新窗口
          title: 'Ctrl + 单击以访问链接',
        },
      },
      dropcursor: {
        width: 2,
        color: 'var(--editor-accent)',
        class: 'nb-dropcursor',
      },
    }),

    // 行内代码需允许与粗体/斜体共存，才能无损承载合法 Markdown 的嵌套结构
    MarkdownCompatibleCode,

    // 撤销/重做由文件级时间线统一接管，原生历史仅用于判断输入分组边界
    UnifiedDocumentHistoryKeys.configure({ docKey }),
    LinkClickHandler.configure({
      onOpenLinkModal: options?.onOpenLinkModal,
    }),

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

    // 表格及表格剪贴板增强（支持标准 TSV 复制与二维矩阵粘贴）
    TableClipboard,
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

    // PlantUML / UML 图表
    PlantUmlBlock,

    // Infographic 现代化信息图
    InfographicBlock,

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
