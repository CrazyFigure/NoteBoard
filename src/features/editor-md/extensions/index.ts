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
import { TaskItem, ListItem, getListMarker } from '@tiptap/extension-list';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table';
import { TableHeader } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import { createIsolatedMarkdownParser } from '../markdownBlockStart';
import { MarkdownBlockSpacing, MarkdownBlockquote, MarkdownDocument } from '../markdownBlockSpacing';
import { MarkdownTrailingNode } from '../markdownTrailingNode';
import { emitRawSegment } from '../rawMarkdownSegments';
import { Link } from '@tiptap/extension-link';

import { CodeBlockView } from '../codeBlockView';
import { MarkdownInlineAtomMarks, SafeMarkdownHighlight, SafeMarkdownUnderline, TextColor } from '../markdownInlineMarks';
import { BlockFormatSyntax, FormattedHeading, FormattedParagraph } from '../blockFormat';
import { searchReplaceExtension } from '../searchReplace';
import { MathInline, MathBlock } from '../katexExtensions';
import { MermaidBlock } from '../mermaidExtension';
import { PlantUmlBlock } from '../../plantuml/plantumlExtension';
import { InfographicBlock } from '../infographicExtension';
import { GitHubAlert } from '../alertExtension';
import { DetailsBlock } from '../detailsExtension';
import { ColumnBlock, ColumnsBlock } from '../columnsExtension';
import { CalloutBlock } from '../calloutExtension';
import { FootnoteDefinitionBlock, FootnoteReference, FrontMatterBlock, RawHtmlBlock, RawHtmlBlockMerge, RawHtmlInline } from '../markdownPreserveExtensions';
import { slashSuggestion } from '../slashCommand';
import { WikiLink } from '../wikiLinkNode';
import { WikiLinkSuggestion } from '../wikiLinkSuggestion';

import { handleLinkClick } from '../linkHandler';
import { TableClipboard } from '../tableClipboard';
import { fixTableEditingSelection } from '../tableSelectionFix';
import { renderTableMarkdown, tableMarkdownStyleOf, type TableMarkdownStyle } from '../markdownTable';
import { MarkdownHtmlEntity } from '../markdownHtmlEntities';
import { MarkdownBulletList, MarkdownOrderedList, MarkdownTaskList } from '../markdownListSpacing';
import { PasteFormatDetect } from '../pasteFormatDetect';
import { ListEmptyItemBackspaceFix } from '../listItemBackspace';
import { SelectionHighlight } from '../selectionHighlight';
import { InlineEmojiRender } from '../inlineEmoji';
import { MultiClickSelectionFix } from '../multiClickSelection';
import { EnterKeyBehavior } from '../enterKeyBehavior';
import { SelectAllBehavior } from '../selectAllBehavior';
import { TabKeyBehavior } from '../tabKeyBehavior';
import { useWindowStore } from '../../../stores/windowStore';

import Suggestion from '@tiptap/suggestion';
import { Extension, type Extensions, type JSONContent, type MarkdownParseHelpers, type MarkdownParseResult, type MarkdownToken, type MarkdownTokenizer } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import {
  redoDocumentHistory,
  undoDocumentHistory,
} from '../../history/documentHistory';

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

import { EnhancedImageBlock, formatMarkdownDestination, parseLinkedImageToken } from '../imageNodeView';
import { formatShortcut } from '../../../core/shortcuts';

/**
 * 文档级属性：记录源文件末尾的换行（Markdown 解析会丢弃它）、不可见空白的书写方式（实体或字符）。
 * 序列化时据此还原，避免"仅切换模式就让文件末尾换行消失"等假差异。
 */
const MarkdownDocumentAttributes = Extension.create({
  name: 'markdownDocumentAttributes',
  addGlobalAttributes() {
    return [
      {
        types: ['doc'],
        attributes: {
          trailingNewline: {
            default: '',
            rendered: false,
          },
          // 原文是否以实体（&nbsp; 等）书写不可见空白：是则序列化写回实体，否则保持字符原样
          invisibleCharEntities: {
            default: false,
            rendered: false,
          },
        },
      },
    ];
  },
});

/**
 * 表格：按原文风格（紧凑 / 对齐）序列化，见 markdownTable.ts。
 * 序列化结果首尾自带换行，与块间分隔叠加后会多出空行（原文 `p\n\n| a |` 变成 `p\n\n\n| a |`）。
 * 顶层表格去掉首部空行（块间距离由文档级分隔控制）；列表等容器内依赖首部换行与前一段落隔开，保持原样。
 * 尾部空白行在任何位置都去掉。
 */
const MarkdownTable = Table.extend({
  // 表格起点只依赖前两行；不可为每个普通段落反复拆分剩余全文。
  markdownTokenizer: {
    ...(Table.config.markdownTokenizer as MarkdownTokenizer),
    start: (src: string) => {
      const firstEnd = src.indexOf('\n');
      if (firstEnd < 0 || !src.slice(0, firstEnd).includes('|')) return -1;
      const secondEnd = src.indexOf('\n', firstEnd + 1);
      const separator = src.slice(firstEnd + 1, secondEnd < 0 ? src.length : secondEnd);
      return /^[ \t|:]*-[ \t|:-]*$/.test(separator) && separator.includes('|') ? 0 : -1;
    },
  },
  // markdownStyle：原文的表格书写风格，仅用于序列化时沿用原写法，不参与渲染
  addAttributes() {
    return {
      ...this.parent?.(),
      markdownStyle: {
        default: null,
        rendered: false,
      },
    };
  },
  parseMarkdown(token, helpers) {
    const parentParse = (this as unknown as {
      parent?: (token: unknown, helpers: unknown) => JSONContent | JSONContent[];
    }).parent;
    const parsed = parentParse?.(token, helpers);
    if (!parsed || Array.isArray(parsed)) return parsed ?? [];
    return { ...parsed, attrs: { ...parsed.attrs, markdownStyle: tableMarkdownStyleOf(token) } };
  },
  renderMarkdown(node, helpers, context) {
    // 新建的表格没有原文风格，默认按显示宽度对齐
    const style = (node.attrs?.markdownStyle as TableMarkdownStyle | null | undefined) ?? 'aligned';
    const rendered = renderTableMarkdown(node, helpers, style);
    const withoutTrailing = rendered.replace(/(?:\n[ \t]*)+$/, '');
    // 折叠块正文、分栏的单栏、高亮块正文与文档一样以空行分隔子块，首部换行同样会多出一个空行
    const isTopLevel =
      !context?.parentType ||
      ['doc', 'detailsBlock', 'columnBlock', 'calloutBlock'].includes(String(context.parentType));
    return isTopLevel ? withoutTrailing.replace(/^(?:[ \t]*\n)+/, '') : withoutTrailing;
  },
  // 从表格外的空段落拖选进表格时，官方选区规整会把选区收缩成单元格内的光标，这里修正
  addProseMirrorPlugins() {
    return fixTableEditingSelection(this.parent?.() ?? []);
  },
});

/**
 * 列表项：已有内容沿用原缩进；新建续段与子列表默认对齐标记后的文字位置。
 * 格式属性只控制源码写法，不能改变节点的父子关系或代码块内部的空白。
 */
const MarkdownListItem = ListItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      sourceIndent: { default: null, rendered: false, keepOnSplit: false },
      sourceContinuationIndents: { default: null, rendered: false, keepOnSplit: false },
    };
  },
  renderMarkdown(node, helpers, context) {
    const parentType = context?.parentType;
    let prefix = node.type === 'taskItem' ? `- [${node.attrs?.checked ? 'x' : ' '}] ` : '- ';
    if (parentType === 'orderedList') {
      const parentAttrs = context?.meta?.parentAttrs as { start?: number; type?: string } | undefined;
      const index = (parentAttrs?.start || 1) - 1 + (context?.index || 0);
      prefix = getListMarker(parentAttrs?.type, index, '. ');
    }
    const [first, ...rest] = node.content ?? [];
    if (!first) return prefix;
    // 新建任务子项沿用既有的两格默认；已有文档仍优先使用记录的缩进。
    const defaultIndent = node.type === 'taskItem' ? 2 : prefix.length;
    // 首段的软换行 / 硬换行仍属于当前列表项，不能在回写时退到文档顶层。
    const continuation = node.attrs?.sourceContinuationIndents as string[] | null;
    const firstContent = helpers.renderChildren([first]).split('\n').map((line, index) =>
      index === 0 ? line : (continuation?.[index - 1] ?? ' '.repeat(defaultIndent)) + line,
    ).join('\n');
    let output = `${prefix}${firstContent}`;
    rest.forEach((child, index) => {
      const rendered = helpers.renderChild?.(child, index + 1) ?? helpers.renderChildren([child]);
      if (rendered === undefined || rendered === null) return;
      const sourceIndents = node.attrs?.sourceIndent as Array<string | null> | null;
      const childIndent = sourceIndents?.[index + 1] ?? ' '.repeat(defaultIndent);
      // 与官方实现一致：子块内部的空行同样带缩进，保证无序列表的输出与旧版逐字相同
      const indented = rendered.split('\n').map((line) => childIndent + line).join('\n');
      output += child.type === 'paragraph' ? `\n\n${indented}` : `\n${indented}`;
    });
    return output;
  },
});

/** 任务列表使用同一套原文缩进回写规则，避免子任务或普通子列表被统一压成两格。 */
const MarkdownTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      sourceIndent: { default: null, rendered: false, keepOnSplit: false },
      sourceContinuationIndents: { default: null, rendered: false, keepOnSplit: false },
    };
  },
  renderMarkdown: MarkdownListItem.config.renderMarkdown,
});

/**
 * 链接：`[![alt](src)](href)` 的内容只有一张图片，而图片是独立节点、无法承载链接标记，
 * 官方解析会丢掉外层链接（README 徽章点击不再跳转）。这种情况生成带 href 的图片节点，其余照常。
 * 注意：行内 token 只会交给第一个注册的处理器，无法另注册扩展"让出"，因此直接扩展 Link。
 */
const MarkdownLink = Link.extend({
  parseMarkdown(token, helpers) {
    const linkedImage = parseLinkedImageToken(token, helpers);
    if (linkedImage) return linkedImage;
    const parentParse = (this as unknown as {
      parent?: (token: MarkdownToken, helpers: MarkdownParseHelpers) => MarkdownParseResult;
    }).parent;
    return parentParse?.(token, helpers) ?? [];
  },
  renderMarkdown(node, helpers) {
    // 地址和标题属于链接语法，不能被普通正文的实体还原 / 冗余转义清理改写。
    const href = formatMarkdownDestination(String(node.attrs?.href ?? ''));
    const title = String(node.attrs?.title ?? '');
    const destination = title ? `${href} "${title.replace(/(["\\])/g, '\\$1')}"` : href;
    return `[${helpers.renderChildren(node)}](${emitRawSegment(destination)})`;
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

// Markdown 允许粗体、斜体等标记包裹行内代码；默认 Code 的 excludes: '_'
// 会让合法的 **文字 `code`** 在解析时生成非法 marks，并触发整篇纯文本降级。
const MarkdownCompatibleCode = Code.extend({
  excludes: '',
  // 代码必须位于高亮、下划线等标记内层；否则 ==`code`== 会被回写为 `==code==`，丢失高亮。
  priority: 50,
});

/**
 * 构建 TipTap 扩展列表
 * 这是唯一的扩展装配点，不分散到各组件
 */
export function buildExtensions(docKey = '', options?: BuildExtensionsOptions): Extensions {
  const useDocumentHistory = options?.documentHistory !== false;
  return [
    // StarterKit 包含：bold, italic, strike, code, heading, bulletList, orderedList,
    // listItem, blockquote, horizontalRule, history, paragraph, text, document,
    // 但不含 codeBlock（我们用自定义的）
    StarterKit.configure({
      // 根文档与引用块改为按原文记录的边界回写，避免无条件在独立块之间补空行。
      document: false,
      blockquote: false,
      // 自动补齐的尾段需要记录辅助身份，避免被误当成作者空行写回文件。
      trailingNode: false,
      // 改由允许 Markdown 标记嵌套的 Code 扩展注册，避免同名扩展和 schema 冲突
      code: false,
      codeBlock: false, // 用自定义的 CodeBlockView
      // 改由 SafeMarkdownUnderline 注册：官方 `++` tokenizer 会误伤 `C++` 等普通文本
      underline: false,
      // 改由 MarkdownListItem 注册：续段缩进需与列表标记宽度一致
      listItem: false,
      // 改由 MarkdownBulletList / MarkdownOrderedList 注册：记住并写回列表项间距（紧凑 / 宽松）
      bulletList: false,
      orderedList: false,
      // 缩短连续输入的合并窗口，并保留更多编辑步骤；保存操作不会重建该历史栈
      undoRedo: {
        depth: 200,
        newGroupDelay: 300,
      },
      // 改由 MarkdownLink 注册：需接管 `[![alt](src)](href)` 的解析
      link: false,
      // 改由 FormattedParagraph / FormattedHeading 注册：承载对齐与缩进，序列化为 div 包裹写法
      paragraph: false,
      heading: false,
      dropcursor: {
        width: 2,
        color: 'var(--editor-accent)',
        class: 'nb-dropcursor',
      },
    }),

    // 行内代码需允许与粗体/斜体共存，才能无损承载合法 Markdown 的嵌套结构
    MarkdownCompatibleCode,
    // 双链、公式、脚注与原始 HTML 同样承载行内标记，禁用双链时其余节点仍需要这条规则。
    MarkdownInlineAtomMarks,

    // 段落与标题（支持对齐、缩进）
    MarkdownDocument,
    MarkdownBlockquote,
    MarkdownBlockSpacing,
    MarkdownTrailingNode,
    FormattedParagraph,
    FormattedHeading,

    // 列表项（续段缩进与列表标记等宽）
    MarkdownListItem,
    // 无序 / 有序列表（项间距：紧凑 / 宽松）
    MarkdownBulletList,
    MarkdownOrderedList,

    // HTML 实体（&copy;、&nbsp;、&#169; 等）解码为对应字符
    MarkdownHtmlEntity,

    // 文档末尾换行等源文件级信息
    MarkdownDocumentAttributes,

    // 撤销/重做由文件级时间线统一接管，原生历史仅用于判断输入分组边界；
    // 嵌入式编辑器关闭接管后，Mod-z 等快捷键回落到 StarterKit 自带的撤销栈
    ...(useDocumentHistory ? [UnifiedDocumentHistoryKeys.configure({ docKey })] : []),
    // 空列表项退格只删除该节点本身，避免内置 listKeymap 触发 liftListItem
    // 把后面的同级列表项收编为子列表、导致层级整体错乱
    ListEmptyItemBackspaceFix,
    LinkClickHandler.configure({
      onOpenLinkModal: options?.onOpenLinkModal,
    }),

    // 链接（带链接的图片解析为带 href 的图片节点，其余与官方一致）
    MarkdownLink.configure({
      openOnClick: false,
      // 盘符不是网络协议；各平台显示其他平台文档时也保留其本地地址，点击仍由应用接管。
      isAllowedUri: (url, context) => /^[a-z]:[\\/]/i.test(url) || context.defaultValidate(url),
      HTMLAttributes: {
        rel: 'noopener noreferrer',
        target: null, // 🔴 必须为 null，绝不能设置 _blank，避免 WebView2 底层触发系统新窗口
        title: formatShortcut('Ctrl + 单击以访问链接'),
      },
    }),

    // 本地图片增强扩展（支持 Base64、本地相对路径 Asset 解析、大图预览与排版调节）
    EnhancedImageBlock,
    // 下划线（安全的 `++` Markdown tokenizer）
    SafeMarkdownUnderline,
    // 文本高亮扩展（支持多色配置；安全的 `==` Markdown tokenizer，避免误伤 `a == b`）
    SafeMarkdownHighlight.configure({
      multicolor: true,
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
    // 回车类按键统一行为：Enter 换段落、Shift+Enter 段内换行、Ctrl+Enter 跳出到下方（支持 Enter 与 Shift+Enter 互换）
    EnterKeyBehavior,
    // 全选：Ctrl+A 第一次选中当前文本块，再按一次全选文档
    SelectAllBehavior,
    // 正文 Tab 插入空格；块内已有快捷键优先，无法继续缩进或导航时也不触发浏览器焦点遍历。
    TabKeyBehavior,

    // 任务列表（项间距：紧凑 / 宽松）
    MarkdownTaskList,
    MarkdownTaskItem.configure({
      nested: true,
      HTMLAttributes: {
        'data-type': 'taskItem',
      },
    }),

    // 表格及表格剪贴板增强（支持标准 TSV 复制与二维矩阵粘贴）
    TableClipboard,
    MarkdownTable.configure({
      resizable: true,
      HTMLAttributes: {
        class: 'nb-table',
      },
    }),
    TableRow,
    TableCell,
    TableHeader,

    // 普通 CodeBlock + 自定义 NodeView 不消费 lowlight 选项；语言选择、复制及 Markdown 序列化保持原样。
    // 高亮库仍由真正使用它的视图加载，不能为无效选项在首开注册全部语法。
    // 语法高亮由 CodeBlockView 内置的 codeHighlightPlugin 负责，遇到需高亮的代码块才动态加载 lowlight。
    CodeBlockView,

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

    // 被空行拆开的完整 HTML 合并为一块：marked 中后注册者先执行，须排在折叠块/分栏/高亮块之前，让其标准写法优先
    RawHtmlBlockMerge,

    // 折叠块：只接管标准写法的 <details>，须先于块级 HTML 原样保留注册
    DetailsBlock,

    // 分栏卡片：只接管标准写法的 <div class="nb-columns">，同样须先于块级 HTML 原样保留注册
    ColumnsBlock,
    ColumnBlock,

    // 高亮块：只接管标准写法的 <div class="nb-callout">，同样须先于块级 HTML 原样保留注册
    CalloutBlock,

    // 段落 / 标题的对齐与缩进：只接管标准写法的 <div align / style>，同样须先于块级 HTML 原样保留注册
    BlockFormatSyntax,

    // 原样保留语法：front matter、脚注、块级 HTML（可视化中只读展示，保证往返不丢失）
    FrontMatterBlock,
    FootnoteDefinitionBlock,
    FootnoteReference,
    RawHtmlBlock,
    RawHtmlInline,
    // 字体颜色：须排在行内 HTML 之后，让标准写法的 <span style="color"> 先被识别
    TextColor,

    // 双向链接 `[[笔记]]`：原子节点逐字保留原文，输入 `[[` 弹出仓库笔记补全
    ...(options?.wikiLinks !== false
      ? [WikiLink.configure({ docKey }), WikiLinkSuggestion.configure({ docKey })]
      : []),

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

    // 每个编辑器独占解析器，避免回收重建和多文档不断向全局 marked 追加相同规则。
    // TipTap 的注入类型沿用可调用的全局 marked；实际只使用 Marked 同样提供的解析/词法 API。
    Markdown.configure({ marked: createIsolatedMarkdownParser() }),

    // 粘贴格式检测：放在最后，其它扩展的粘贴处理优先
    ...(options?.pasteFormatDetect ? [PasteFormatDetect] : []),
  ];
}
