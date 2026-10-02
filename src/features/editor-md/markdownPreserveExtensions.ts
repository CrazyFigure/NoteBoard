// NoteBoard 原样保留类 Markdown 节点
// 可视化编辑器不具备语义编辑能力、但必须在往返中逐字保留的语法：
// 1. Front matter（文档首部 `---` YAML 块）——此前会被解析成分隔线 + 二级标题并持续漂移；
// 2. 脚注引用 `[^id]` 与脚注定义 `[^id]: 内容`——此前被 marked 当作引用式链接改写为 `[^1](note)`；
// 3. 块级原始 HTML（`<details>`、`<div align>` 等）——此前被剥成纯文本。
// 这些节点在可视化模式中以只读源码样式展示，编辑需切换到源码模式。

import { Node, mergeAttributes } from '@tiptap/core';
import { emitRawSegment } from './rawMarkdownSegments';
import { normalizeImageAlign, normalizeImageWidth } from './imageNodeView';

// Front matter：必须位于文档最开始，结束标记为 `---` 或 `...`
const FRONT_MATTER_PATTERN = /^---[ \t]*\n((?:[^\n]*\n)*?)(?:---|\.\.\.)[ \t]*(?:\n|$)/;
// 首个非空行需形如 `key: value`，避免把以分隔线开头的普通文档误判为 front matter
const YAML_KEY_LINE = /^[\w"'-][^:\n]*:(?:[ \t]|$)/;

// 脚注定义：`[^id]: 内容`，后续以至少两个空格或制表符缩进的行视为续行；
// 连续（无空行分隔）的多条定义合并为一个节点，保证往返时不被插入空行
const FOOTNOTE_DEFINITION_PATTERN = /^(?: {0,3}\[\^[^\]\s]+\]:[^\n]*(?:\n(?: {2,}|\t)[^\n]*)*(?:\n|$))+/;

// 行内 HTML：CommonMark 开始/结束标签与注释。schema 已能表达的标签交给默认路径（转为下划线、高亮等）
const INLINE_HTML_TAG_PATTERN = /^(?:<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>)/;
const SCHEMA_INLINE_HTML_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'mark', 'code', 'a', 'img', 'br']);
const FOOTNOTE_DEFINITION_START = /(?:^|\n) {0,3}\[\^[^\]\s]+\]:/;
// 脚注引用：`[^id]`，后面不能紧跟冒号（那是定义）
const FOOTNOTE_REFERENCE_PATTERN = /^\[\^([^\]\s]+)\](?!:)/;

// 独占一块的单个 <img> 标签
const STANDALONE_IMG_PATTERN = /^<img\b([^>]*?)\/?>$/i;
const HTML_ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** 还原 HTML 属性值中的基本实体 */
function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 解析独立 <img> 标签为图片节点属性；含 width/align 以外的复杂属性也只取已知字段。 */
function parseStandaloneImageTag(raw: string): Record<string, string | null> | null {
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

/** Front matter 原子节点：raw 保存含分隔符的完整原文 */
export const FrontMatterBlock = Node.create({
  name: 'frontMatter',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      raw: { default: '', rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: 'pre[data-front-matter]', getAttrs: (dom) => ({ raw: (dom as HTMLElement).textContent ?? '' }) }];
  },
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
  parseMarkdown: (token, helpers) => helpers.createNode('frontMatter', { raw: token.text ?? '' }),
  renderMarkdown: (node) => emitRawSegment(String(node.attrs?.raw ?? '')),
});

/** 脚注定义原子节点：raw 保存 `[^id]: 内容`（含续行）原文 */
export const FootnoteDefinitionBlock = Node.create({
  name: 'footnoteDefinition',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      raw: { default: '', rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-footnote-definition]', getAttrs: (dom) => ({ raw: (dom as HTMLElement).textContent ?? '' }) }];
  },
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
    start: (src: string) => {
      const match = FOOTNOTE_DEFINITION_START.exec(src);
      if (!match) return -1;
      return match.index + (match[0].startsWith('\n') ? 1 : 0);
    },
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
  parseMarkdown: (token, helpers) => helpers.createNode('footnoteDefinition', { raw: token.text ?? '' }),
  renderMarkdown: (node) => emitRawSegment(String(node.attrs?.raw ?? '')),
});

/** 脚注引用行内原子节点 */
export const FootnoteReference = Node.create({
  name: 'footnoteReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: '', rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: 'sup[data-footnote-ref]', getAttrs: (dom) => ({ id: (dom as HTMLElement).getAttribute('data-footnote-ref') ?? '' }) }];
  },
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
  parseMarkdown: (token, helpers) => helpers.createNode('footnoteReference', { id: token.id ?? '' }),
  renderMarkdown: (node) => emitRawSegment(`[^${String(node.attrs?.id ?? '')}]`),
});

/** 行内原始 HTML 标签原子节点：保留 <kbd>、<span style>、<sub> 等 schema 无法表达的标签，标签间文字仍可编辑 */
export const RawHtmlInline = Node.create({
  name: 'rawHtmlInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      raw: { default: '', rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: 'code[data-raw-html-inline]', getAttrs: (dom) => ({ raw: (dom as HTMLElement).textContent ?? '' }) }];
  },
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
      // 已有对应节点/标记的标签维持默认 HTML 解析
      if (match[1] && SCHEMA_INLINE_HTML_TAGS.has(match[1].toLowerCase())) return undefined;
      return {
        type: 'rawHtmlInline',
        raw: match[0],
        text: match[0],
      };
    },
  },
  parseMarkdown: (token, helpers) => helpers.createNode('rawHtmlInline', { raw: token.text ?? '' }),
  renderMarkdown: (node) => emitRawSegment(String(node.attrs?.raw ?? '')),
});

/** 块级原始 HTML 原子节点：仅接管 marked 的块级 html token，行内 HTML 维持原有处理 */
export const RawHtmlBlock = Node.create({
  name: 'rawHtmlBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      raw: { default: '', rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: 'pre[data-raw-html]', getAttrs: (dom) => ({ raw: (dom as HTMLElement).textContent ?? '' }) }];
  },
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
  renderMarkdown: (node) => emitRawSegment(String(node.attrs?.raw ?? '')),
});
