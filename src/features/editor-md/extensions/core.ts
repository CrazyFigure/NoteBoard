// Markdown 核心装配：schema、tokenizer 和往返规则在主线程与 Worker 中共用；禁止依赖界面或应用状态。
import StarterKit from '@tiptap/starter-kit';
import { Code } from '@tiptap/extension-code';
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
import { CodeBlockViewCore as CodeBlockView } from '../codeBlockCore';
import { MarkdownInlineAtomMarks, SafeMarkdownHighlight, SafeMarkdownUnderline, TextColor } from '../markdownInlineMarks';
import { BlockFormatSyntax, FormattedHeading, FormattedParagraph } from '../blockFormat';
import { MathInlineCore as MathInline, MathBlockCore as MathBlock } from '../mathCore';
import { MermaidBlockCore as MermaidBlock } from '../mermaidCore';
import { PlantUmlBlockCore as PlantUmlBlock } from '../../plantuml/plantumlCore';
import { InfographicBlockCore as InfographicBlock } from '../infographicCore';
import { GitHubAlertCore as GitHubAlert } from '../alertCore';
import { DetailsBlockCore as DetailsBlock } from '../detailsCore';
import { ColumnBlockCore as ColumnBlock, ColumnsBlockCore as ColumnsBlock } from '../columnsCore';
import { CalloutBlockCore as CalloutBlock } from '../calloutCore';
import { FootnoteDefinitionBlockCore as FootnoteDefinitionBlock, FootnoteReferenceCore as FootnoteReference, FrontMatterBlockCore as FrontMatterBlock, RawHtmlBlockCore as RawHtmlBlock, RawHtmlBlockMergeCore as RawHtmlBlockMerge, RawHtmlInlineCore as RawHtmlInline } from '../markdownPreserveCore';
import { WikiLinkCore as WikiLink } from '../wikiLinkCore';
import { renderTableMarkdown, tableMarkdownStyleOf, type TableMarkdownStyle } from '../markdownTable';
import { MarkdownHtmlEntity } from '../markdownHtmlEntities';
import { MarkdownBulletList, MarkdownOrderedList, MarkdownTaskList } from '../markdownListSpacing';
import { Extension, type Extensions, type JSONContent, type MarkdownParseHelpers, type MarkdownParseResult, type MarkdownToken, type MarkdownTokenizer } from '@tiptap/core';
import { EnhancedImageBlockCore as EnhancedImageBlock, formatMarkdownDestination, parseLinkedImageToken } from '../imageCore';
import { formatShortcut } from '../../../core/shortcuts';

/** 只传递影响文档语法的选项，不读取全局 store。 */
export interface CoreExtensionsOptions {
  /** 嵌入式编辑器可关闭双链节点，普通文档默认启用。 */
  wikiLinks?: boolean;
}

/**
 * 文档级属性：记录源文件末尾的换行（Markdown 解析会丢弃它）、不可见空白的书写方式（实体或字符）。
 * 序列化时据此还原，避免"仅切换模式就让文件末尾换行消失"等假差异。
 */
export const MarkdownDocumentAttributes = Extension.create({
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
export const MarkdownTable = Table.extend({
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
});

/**
 * 列表项：已有内容沿用原缩进；新建续段与子列表默认对齐标记后的文字位置。
 * 格式属性只控制源码写法，不能改变节点的父子关系或代码块内部的空白。
 */
export const MarkdownListItem = ListItem.extend({
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
export const MarkdownTaskItem = TaskItem.extend({
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
export const MarkdownLink = Link.extend({
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

// Markdown 允许粗体、斜体等标记包裹行内代码；默认 Code 的 excludes: '_'
// 会让合法的 **文字 `code`** 在解析时生成非法 marks，并触发整篇纯文本降级。
export const MarkdownCompatibleCode = Code.extend({
  excludes: '',
  // 代码必须位于高亮、下划线等标记内层；否则 ==`code`== 会被回写为 `==code==`，丢失高亮。
  priority: 50,
});

/** 两端共用相同顺序的文档与 Markdown 扩展；仅界面行为由完整装配点补充。 */
export function buildCoreExtensions(options?: CoreExtensionsOptions): Extensions {
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

    // 任务列表（项间距：紧凑 / 宽松）
    MarkdownTaskList,
    MarkdownTaskItem.configure({
      nested: true,
      HTMLAttributes: {
        'data-type': 'taskItem',
      },
    }),
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
      ? [WikiLink]
      : []),

    // 每个编辑器独占解析器，避免回收重建和多文档不断向全局 marked 追加相同规则。
    // TipTap 的注入类型沿用可调用的全局 marked；实际只使用 Marked 同样提供的解析/词法 API。
    Markdown.configure({ marked: createIsolatedMarkdownParser() })
  ];
}
