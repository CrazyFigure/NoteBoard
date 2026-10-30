// 共享文档规则：后台解析与主线程使用同一份定义，禁止引入界面、store 或原生 API。
import { mergeAttributes, Node, type MarkdownToken, type MarkdownTokenizer } from '@tiptap/core';
import { findWikiLinkStart, formatWikiLinkMarkdown, matchWikiLinkAtStart, parseWikiLinkInner, wikiLinkLabel } from '../wikilink/wikiLinkSyntax';
import { emitRawSegment } from './rawMarkdownSegments';

export interface WikiLinkOptions {
  /** 所在文档 key（解析相对目标、同名优先级用）；为空时使用活动标签 */
  docKey: string;
}

/** tokenizer 附加在 marked token 上的内部文字与嵌入标记 */
export type WikiLinkMarkdownToken = MarkdownToken & { inner?: string; embed?: boolean };

/** 行内 `[[...]]` / `![[...]]` tokenizer：不跨行、内部不含方括号 */
export const wikiLinkTokenizer: MarkdownTokenizer = {
  name: 'wikiLink',
  level: 'inline',
  start: findWikiLinkStart,
  tokenize(source) {
    const match = matchWikiLinkAtStart(source);
    if (!match) return undefined;
    return { type: 'wikiLink', raw: match.raw, inner: match.inner, embed: match.embed };
  },
};

/** WikiLink 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const WikiLinkCore = Node.create<WikiLinkOptions>({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  /** 保留核心默认选项，界面功能由主线程扩展补充。 */
  addOptions() {
    return { docKey: '' };
  },

  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      inner: {
        default: '',
        /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
        parseHTML: (element) => element.getAttribute('data-wiki-link') ?? '',
        /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
        renderHTML: (attributes) => ({ 'data-wiki-link': attributes.inner }),
      },
      embed: {
        default: false,
        /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
        parseHTML: (element) => element.hasAttribute('data-wiki-embed'),
        /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
        renderHTML: (attributes) => (attributes.embed ? { 'data-wiki-embed': '' } : {}),
      },
    };
  },

  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [{ tag: 'span[data-wiki-link]' }];
  },

  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: node.attrs.embed ? 'nb-wikiembed' : 'nb-wikilink' }),
      wikiLinkLabel(parseWikiLinkInner(String(node.attrs.inner ?? ''))),
    ];
  },

  /** 纯文本通道保留该节点的原始语义，不依赖节点视图。 */
  renderText({ node }) {
    // 复制为纯文本、搜索辅助文本等通道保留原始写法
    return `${node.attrs.embed ? '!' : ''}[[${String(node.attrs.inner ?? '')}]]`;
  },

  markdownTokenName: 'wikiLink',
  markdownTokenizer: wikiLinkTokenizer,
  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown(token, helpers) {
    const wikiToken = token as WikiLinkMarkdownToken;
    return helpers.createNode('wikiLink', { inner: wikiToken.inner ?? '', embed: wikiToken.embed === true });
  },
  /** 按共享源码规则回写，结果不受节点视图和交互设置影响。 */
  renderMarkdown(node) {
    // 正常保存时 serialize.ts 已把双链转为受保护的原文片段（携带粗体等标记）；这里只服务其它直接序列化的通道。
    // 原文同样经 emitRawSegment 登记，全文后处理（实体还原、冗余转义清理）不会改动链接内容
    return emitRawSegment(formatWikiLinkMarkdown(String(node.attrs?.inner ?? ''), node.attrs?.embed === true));
  }
});
