// NoteBoard Markdown 编辑器扩展装配点
// 唯一装配处：所有 TipTap 扩展在此注册
// 详见 docs/09-开发路线图.md 7.1
//
// 采用最小扩展集装配。
// 不包含：AI 补全/建议/diff 预览、sync/、SQLite 层、全局单例 tab 状态。

import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import { CodeBlockView } from '../codeBlockView';
import { searchReplaceExtension } from '../searchReplace';
import { MathInline, MathBlock } from '../katexExtensions';
import { MermaidBlock } from '../mermaidExtension';
import { PlantUmlBlock } from '../../plantuml/plantumlExtension';
import { InfographicBlock } from '../infographicExtension';
import { GitHubAlert } from '../alertExtension';
import { DetailsBlock } from '../detailsExtension';
import { ColumnBlock, ColumnsBlock } from '../columnsExtension';
import { CalloutBlock } from '../calloutExtension';
import { RawHtmlBlock, RawHtmlInline } from '../markdownPreserveExtensions';
import { slashSuggestion } from '../slashCommand';
import { WikiLink } from '../wikiLinkNode';
import { WikiLinkSuggestion } from '../wikiLinkSuggestion';
import { handleLinkClick } from '../linkHandler';
import { TableClipboard } from '../tableClipboard';
import { PasteFormatDetect } from '../pasteFormatDetect';
import { ListEmptyItemBackspaceFix } from '../listItemBackspace';
import { SelectionHighlight } from '../selectionHighlight';
import { InlineEmojiRender } from '../inlineEmoji';
import { MultiClickSelectionFix } from '../multiClickSelection';
import { CollapsedBlockSelection } from '../collapsedBlockSelection';
import { EnterKeyBehavior } from '../enterKeyBehavior';
import { SelectAllBehavior } from '../selectAllBehavior';
import { TabKeyBehavior } from '../tabKeyBehavior';
import { useWindowStore } from '../../../stores/windowStore';
import Suggestion from '@tiptap/suggestion';
import { Extension, type Extensions } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { redoDocumentHistory, undoDocumentHistory } from '../../history/documentHistory';
import { EnhancedImageBlock } from '../imageNodeView';
import { buildCoreExtensions, MarkdownTable } from './core';
// 引入图片扩展的类型增强，使自定义图片节点的 setImage 命令在全局链式 API 中可见。
import '@tiptap/extension-image';
import { fixTableEditingSelection } from '../tableSelectionFix';

/** 表格选区修正属于界面行为，核心表格继续共享相同属性与 Markdown 规则。 */
const MarkdownTableView = MarkdownTable.extend({
  addProseMirrorPlugins() { return fixTableEditingSelection(this.parent?.() ?? []); },
});

export interface LinkClickHandlerOptions {
  onOpenLinkModal?: () => void;
}

// 渲染后的原始 HTML 容器：HTML 块渲染区与行内 HTML 渲染区
const RENDERED_RAW_HTML_SELECTOR = '.nb-md-html-render, .nb-md-html-inline';

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
              // 渲染后的原始 HTML（HTML 块 / 行内 HTML）中的链接由其节点视图自行处理（见 handleRenderedHtmlLinkClick）：
              // click 不是 ProseMirror 内置处理的事件，自定义处理器不经过节点视图 stopEvent 过滤，需在此显式让出
              if (target?.closest(RENDERED_RAW_HTML_SELECTOR)) return false;
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
              if (target?.closest(RENDERED_RAW_HTML_SELECTOR)) return false;
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

export interface BuildExtensionsOptions {
  onOpenLinkModal?: () => void;
  /**
   * 是否由文件级统一时间线接管撤销/重做（默认 true）
   * 多维表格单元格等嵌入式编辑器没有独立的文档历史，需关闭以保留 TipTap 自带的短程撤销。
   */
  documentHistory?: boolean;
  /** 空文档占位文案 */
  placeholder?: string;
  /** 是否跟踪纯文本粘贴以提示转换 Markdown / HTML（md 文档可视化编辑器与多维表格多行文本编辑器启用，默认 false） */
  pasteFormatDetect?: boolean;
  /** 是否启用双向链接 `[[笔记]]`（解析、补全与跳转；默认 true，多维表格单元格不需要仓库内跳转时关闭） */
  wikiLinks?: boolean;
}

/**
 * 构建完整 TipTap 扩展列表：复用核心规则，再补充节点视图和交互。
 * 这是唯一的界面装配点，不分散到各组件，也不修改核心解析、属性或序列化定义。
 */
export function buildExtensions(docKey = '', options?: BuildExtensionsOptions): Extensions {
  const useDocumentHistory = options?.documentHistory !== false;
  // 只按节点名称补充视图；核心扩展的顺序、属性默认值和 Markdown 规则均保持原样。
  const views = new Map([EnhancedImageBlock, CodeBlockView, MathInline, MathBlock, MermaidBlock, PlantUmlBlock, InfographicBlock, GitHubAlert, DetailsBlock, ColumnsBlock, ColumnBlock, CalloutBlock, RawHtmlInline, RawHtmlBlock, WikiLink, MarkdownTableView].map((extension) => [extension.name, extension]));
  const core = buildCoreExtensions(options).map((extension) => {
    const view = views.get(extension.name);
    // 配置沿用核心实例；双链的文档身份仅供主线程跳转，不进入后台解析状态。
    return view ? view.configure({ ...extension.options, ...(extension.name === 'wikiLink' ? { docKey } : {}) }) : extension;
  });
  return [
    ...core,

    // 撤销/重做由文件级时间线统一接管，原生历史仅用于判断输入分组边界；
    // 嵌入式编辑器关闭接管后，Mod-z 等快捷键回落到 StarterKit 自带的撤销栈
    ...(useDocumentHistory ? [UnifiedDocumentHistoryKeys.configure({ docKey })] : []),
    // 空列表项退格只删除该节点本身，避免内置 listKeymap 触发 liftListItem
    // 把后面的同级列表项收编为子列表、导致层级整体错乱
    ListEmptyItemBackspaceFix,
    LinkClickHandler.configure({
      onOpenLinkModal: options?.onOpenLinkModal,
    }),

    // 占位符
    Placeholder.configure({
      placeholder: options?.placeholder ?? '开始输入，或键入 / 插入内容',
      emptyEditorClass: 'is-empty',
    }),

    // 字数统计
    CharacterCount,

    // 选区可视化：完整选中的块（列表、代码块、折叠块、图片等）整体显示底板
    SelectionHighlight,
    // 正文表情：表情库内的 Unicode 表情显示为与表情面板一致的 Noto SVG（文件中仍是标准字符）
    InlineEmojiRender,
    // 双击 / 三击选区不跨越段落边界：行尾空白双击不再选中换行，段落间隙判给更近的文本块
    MultiClickSelectionFix,
    // 拖选经过收起的代码块 / 折叠块时整块选中，不被浏览器吸附到块外
    CollapsedBlockSelection,
    // 回车类按键统一行为：Enter 换段落、Shift+Enter 段内换行、Ctrl+Enter 跳出到下方（支持 Enter 与 Shift+Enter 互换）
    EnterKeyBehavior,
    // 全选：Ctrl+A 第一次选中当前文本块，再按一次全选文档
    SelectAllBehavior,
    // 正文 Tab 插入空格；块内已有快捷键优先，无法继续缩进或导航时也不触发浏览器焦点遍历。
    TabKeyBehavior,

    // 表格及表格剪贴板增强（支持标准 TSV 复制与二维矩阵粘贴）
    TableClipboard,

    // 查找/替换
    searchReplaceExtension(),
    // 双链补全只在界面中运行，核心仍保留 wikiLink 节点与 Markdown 规则。
    ...(options?.wikiLinks !== false ? [WikiLinkSuggestion.configure({ docKey })] : []),

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

    // 粘贴格式检测：放在最后，其它扩展的粘贴处理优先
    ...(options?.pasteFormatDetect ? [PasteFormatDetect] : [])
  ];
}
