// 共享文档规则：后台解析与主线程使用同一份定义，禁止引入界面、store 或原生 API。
import { Extension, Node, mergeAttributes } from '@tiptap/core';
import { createIndexedBlockStart } from './markdownBlockStart';
import { emitRawSegment } from './rawMarkdownSegments';
import { normalizeImageAlign, normalizeImageWidth } from './imageCore';
import { matchSplitHtmlBlock } from './rawHtmlScan';

// Front matter：必须位于文档最开始，结束标记为 `---` 或 `...`
export const FRONT_MATTER_PATTERN = /^---[ \t]*\n((?:[^\n]*\n)*?)(?:---|\.\.\.)[ \t]*(?:\n|$)/;

// 首个非空行需形如 `key: value`，避免把以分隔线开头的普通文档误判为 front matter
export const YAML_KEY_LINE = /^[\w"'-][^:\n]*:(?:[ \t]|$)/;

// 脚注定义：`[^id]: 内容`，后续以至少两个空格或制表符缩进的行视为续行；
// 连续（无空行分隔）的多条定义合并为一个节点，保证往返时不被插入空行
export const FOOTNOTE_DEFINITION_PATTERN = /^(?: {0,3}\[\^[^\]\s]+\]:[^\n]*(?:\n(?: {2,}|\t)[^\n]*)*(?:\n|$))+/;

// 行内 HTML：CommonMark 开始/结束标签与注释。schema 已能表达的标签交给默认路径（转为下划线、高亮等）
export const INLINE_HTML_TAG_PATTERN = /^(?:<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>)/;

// 不含 img：图片节点是块级节点，段落内的 <img> 交给默认解析会被整个丢弃，需原样保留
export const SCHEMA_INLINE_HTML_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'mark', 'code', 'a', 'br']);

export const ANCHOR_CLOSE_PATTERN = /<\/a\s*>/i;

export const FOOTNOTE_DEFINITION_START = /(?:^|\n) {0,3}\[\^[^\]\s]+\]:/;

// 脚注引用：`[^id]`，后面不能紧跟冒号（那是定义）
export const FOOTNOTE_REFERENCE_PATTERN = /^\[\^([^\]\s]+)\](?!:)/;

// 独占一块的单个 <img> 标签
export const STANDALONE_IMG_PATTERN = /^<img\b([^>]*?)\/?>$/i;

export const HTML_ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** 还原 HTML 属性值中的基本实体 */
export function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * 匹配包裹图片的链接 `<a href><img></a>`（README 徽章/Logo 的常见写法），返回整段原文。
 * 链接标记无法承载图片，交给默认解析会连同图片一起丢失，因此整体作为一个行内节点保留。
 */
export function matchLinkedImage(src: string, openTagLength: number): string | null {
  const close = ANCHOR_CLOSE_PATTERN.exec(src.slice(openTagLength));
  if (!close) return null;
  const inner = src.slice(openTagLength, openTagLength + close.index);
  if (!/<img\b/i.test(inner) || /<a\b/i.test(inner)) return null;
  return src.slice(0, openTagLength + close.index + close[0].length);
}

/** 解析独立 <img> 标签为图片节点属性；含 width/align 以外的复杂属性也只取已知字段。 */
export function parseStandaloneImageTag(raw: string): Record<string, string | null> | null {
  const match = STANDALONE_IMG_PATTERN.exec(raw);
  if (!match) return null;
  const attributes = new Map<string, string>();
  for (const attribute of match[1].matchAll(HTML_ATTRIBUTE_PATTERN)) {
    attributes.set(attribute[1].toLowerCase(), decodeHtmlAttribute(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''));
  }
  const src = attributes.get('src');
  if (!src) return null;
  // 带有无法在可视化节点中表达的属性（如 style、class）时保留为原始 HTML，避免丢失信息
  const supported = new Set(['src', 'alt', 'title', 'width', 'align']);
  if ([...attributes.keys()].some((name) => !supported.has(name))) return null;
  // 没有尺寸/对齐信息的 <img> 是用户手写 HTML，转换后会被序列化成 ![]() 而改变原文，保持原样
  if (!attributes.has('width') && !attributes.has('align')) return null;
  return {
    src,
    alt: attributes.get('alt') ?? null,
    title: attributes.get('title') ?? null,
    width: normalizeImageWidth(attributes.get('width')),
    align: normalizeImageAlign(attributes.get('align')),
  };
}

/** FrontMatterBlock 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const FrontMatterBlockCore = Node.create({
  name: 'frontMatter',
  group: 'block',
  atom: true,
  selectable: true,
  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      raw: { default: '', rendered: false },
    };
  },
  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [{ tag: 'pre[data-front-matter]', getAttrs: (dom) => ({ raw: (dom as HTMLElement).textContent ?? '' }) }];
  },
  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ node, HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, {
        'data-front-matter': '',
        class: 'nb-md-raw-block nb-md-front-matter',
        'data-label': 'Front Matter',
      }),
      String(node.attrs.raw ?? '').replace(/\n$/, ''),
    ];
  },
  markdownTokenizer: {
    name: 'frontMatter',
    level: 'block',
    start: (src: string) => (src.startsWith('---') ? 0 : -1),
    tokenize: (src, tokens) => {
      // 只在当前块序列的第一个位置识别（文档首部）
      if (tokens.length > 0) return undefined;
      const match = FRONT_MATTER_PATTERN.exec(src);
      if (!match) return undefined;
      const firstContentLine = (match[1] ?? '').split('\n').find((line) => line.trim() !== '');
      if (firstContentLine === undefined || !YAML_KEY_LINE.test(firstContentLine)) return undefined;
      return {
        type: 'frontMatter',
        raw: match[0],
        text: match[0].replace(/\n$/, ''),
      };
    },
  },
  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown: (token, helpers) => helpers.createNode('frontMatter', { raw: token.text ?? '' }),
  /** 按共享源码规则回写，结果不受节点视图和交互设置影响。 */
  renderMarkdown: (node) => emitRawSegment(String(node.attrs?.raw ?? ''))
});

/** FootnoteDefinitionBlock 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const FootnoteDefinitionBlockCore = Node.create({
  name: 'footnoteDefinition',
  group: 'block',
  atom: true,
  selectable: true,
  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      raw: { default: '', rendered: false },
    };
  },
  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [{ tag: 'div[data-footnote-definition]', getAttrs: (dom) => ({ raw: (dom as HTMLElement).textContent ?? '' }) }];
  },
  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-footnote-definition': '',
        class: 'nb-md-footnote-definition',
      }),
      String(node.attrs.raw ?? ''),
    ];
  },
  markdownTokenizer: {
    name: 'footnoteDefinition',
    level: 'block',
    start: createIndexedBlockStart(FOOTNOTE_DEFINITION_START),
    tokenize: (src) => {
      const match = FOOTNOTE_DEFINITION_PATTERN.exec(src);
      if (!match) return undefined;
      return {
        type: 'footnoteDefinition',
        raw: match[0],
        text: match[0].replace(/\n$/, ''),
      };
    },
  },
  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown: (token, helpers) => helpers.createNode('footnoteDefinition', { raw: token.text ?? '' }),
  /** 按共享源码规则回写，结果不受节点视图和交互设置影响。 */
  renderMarkdown: (node) => emitRawSegment(String(node.attrs?.raw ?? ''))
});

/** FootnoteReference 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const FootnoteReferenceCore = Node.create({
  name: 'footnoteReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      id: { default: '', rendered: false },
    };
  },
  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [{ tag: 'sup[data-footnote-ref]', getAttrs: (dom) => ({ id: (dom as HTMLElement).getAttribute('data-footnote-ref') ?? '' }) }];
  },
  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ node, HTMLAttributes }) {
    return [
      'sup',
      mergeAttributes(HTMLAttributes, {
        'data-footnote-ref': String(node.attrs.id ?? ''),
        class: 'nb-md-footnote-ref',
      }),
      `[${String(node.attrs.id ?? '')}]`,
    ];
  },
  markdownTokenizer: {
    name: 'footnoteReference',
    level: 'inline',
    start: (src: string) => src.indexOf('[^'),
    tokenize: (src) => {
      const match = FOOTNOTE_REFERENCE_PATTERN.exec(src);
      if (!match) return undefined;
      return {
        type: 'footnoteReference',
        raw: match[0],
        id: match[1],
      };
    },
  },
  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown: (token, helpers) => helpers.createNode('footnoteReference', { id: token.id ?? '' }),
  /** 按共享源码规则回写，结果不受节点视图和交互设置影响。 */
  renderMarkdown: (node) => emitRawSegment(`[^${String(node.attrs?.id ?? '')}]`)
});

/** RawHtmlInline 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const RawHtmlInlineCore = Node.create({
  name: 'rawHtmlInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      raw: { default: '', rendered: false },
    };
  },
  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [{ tag: 'code[data-raw-html-inline]', getAttrs: (dom) => ({ raw: (dom as HTMLElement).textContent ?? '' }) }];
  },
  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ node, HTMLAttributes }) {
    return [
      'code',
      mergeAttributes(HTMLAttributes, {
        'data-raw-html-inline': '',
        class: 'nb-md-raw-inline',
      }),
      String(node.attrs.raw ?? ''),
    ];
  },
  markdownTokenizer: {
    name: 'rawHtmlInline',
    level: 'inline',
    start: (src: string) => src.search(/<[a-zA-Z/!]/),
    tokenize: (src) => {
      const match = INLINE_HTML_TAG_PATTERN.exec(src);
      if (!match) return undefined;
      // 包裹图片的链接整体保留（开始标签以 `<a` 开头且不是结束标签）
      if (match[1]?.toLowerCase() === 'a' && match[0][1] !== '/') {
        const linkedImage = matchLinkedImage(src, match[0].length);
        if (linkedImage) return { type: 'rawHtmlInline', raw: linkedImage, text: linkedImage };
      }
      // 已有对应节点/标记的标签维持默认 HTML 解析
      if (match[1] && SCHEMA_INLINE_HTML_TAGS.has(match[1].toLowerCase())) return undefined;
      return {
        type: 'rawHtmlInline',
        raw: match[0],
        text: match[0],
      };
    },
  },
  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown: (token, helpers) => helpers.createNode('rawHtmlInline', { raw: token.text ?? '' }),
  /** 按共享源码规则回写，结果不受节点视图和交互设置影响。 */
  renderMarkdown: (node) => emitRawSegment(String(node.attrs?.raw ?? ''))
});

/** RawHtmlBlockMerge 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const RawHtmlBlockMergeCore = Extension.create({
  name: 'rawHtmlBlockMerge',
  markdownTokenizer: {
    name: 'rawHtmlBlockMerge',
    level: 'block',
    // 不打断段落：段落后的 HTML 由下一轮块解析处理（同时避免 TipTap 对每个段落用 tokenize 探测起点）
    start: () => -1,
    tokenize: (src, tokens) => {
      const raw = matchSplitHtmlBlock(src, tokens);
      if (!raw) return undefined;
      return { type: 'html', block: true, pre: false, raw, text: raw };
    },
  }
});

/** RawHtmlBlock 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const RawHtmlBlockCore = Node.create({
  name: 'rawHtmlBlock',
  group: 'block',
  atom: true,
  selectable: true,
  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      raw: { default: '', rendered: false },
    };
  },
  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [{ tag: 'pre[data-raw-html]', getAttrs: (dom) => ({ raw: (dom as HTMLElement).textContent ?? '' }) }];
  },
  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ node, HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, {
        'data-raw-html': '',
        class: 'nb-md-raw-block nb-md-raw-html',
        'data-label': 'HTML',
      }),
      String(node.attrs.raw ?? ''),
    ];
  },
  markdownTokenName: 'html',
  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown: (token, helpers) => {
    // 行内 HTML 交还给默认处理（返回空数组让出 token）
    if (!token.block) return [];
    const raw = String(token.raw ?? '').replace(/\s+$/, '');
    if (raw === '') return [];
    // 独占一块的 <img>（图片调整尺寸/对齐后的序列化形式）还原为可视化图片节点
    const image = parseStandaloneImageTag(raw);
    if (image) return helpers.createNode('image', image);
    return helpers.createNode('rawHtmlBlock', { raw });
  },
  /** 按共享源码规则回写，结果不受节点视图和交互设置影响。 */
  renderMarkdown: (node) => emitRawSegment(String(node.attrs?.raw ?? ''))
});
