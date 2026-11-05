// NoteBoard 行内标记的安全 Markdown tokenizer
// 官方 Underline（++x++）与 Highlight（==x==）的 tokenizer 会匹配普通文本中的 `C++ and C++`、`a == b`，
// 并对内部内容做 trim，导致"只打开文件就篡改文本"。这里收紧为：
// 1. 定界符内侧不得为空白（与 CommonMark 强调的 flanking 规则一致）；
// 2. 闭合定界符后不得紧跟同一字符（避免 `+++`、`===` 被拆开）；
// 3. 不 trim 内部内容，保证往返无损。
// 不限制定界符外侧字符，保证中文语境 `文字==高亮==文字` 仍可识别。
// 多色高亮：`==x==` 只能表达默认黄色，其它颜色序列化为 `<mark style="background-color: …">x</mark>`，
// 否则保存后重新解析（如规范化）会把颜色丢成默认黄色。
// 字体颜色：Markdown 无对应语法，写作 `<span style="color: …">x</span>`（VS Code 预览、Typora 等可显示颜色，
// GitHub 过滤 style 后退化为普通文字）；只接管该标准写法，其它 <span> 仍由行内 HTML 原样保留。

import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import { Extension, Mark, mergeAttributes, type Attributes, type JSONContent, type MarkdownLexerConfiguration, type MarkdownToken } from '@tiptap/core';

/** 解析器上与标记施加相关的最小接口；每个编辑器独立安装，避免重复包裹。 */
interface InlineAtomMarkManager {
  applyMarkToContent?: (markType: string, content: JSONContent[], attrs?: Record<string, unknown>) => JSONContent[];
  nbInlineAtomMarksPatched?: boolean;
}

// 这些原子节点可承载行内标记；图片、块级公式等继续遵循各自的结构与解析规则。
const MARKED_INLINE_ATOMS = new Set(['wikiLink', 'mathInline', 'footnoteReference', 'rawHtmlInline']);

/**
 * @tiptap/markdown 默认只给文本节点加标记，行内原子节点没有可递归的正文，标记会被丢掉。
 * 双链、公式、脚注及原始 HTML 共用补充逻辑，保留包裹它们的原范围，回写见 serialize.ts。
 */
function applyMarksToInlineAtoms(manager: InlineAtomMarkManager | undefined): void {
  if (!manager || manager.nbInlineAtomMarksPatched || typeof manager.applyMarkToContent !== 'function') return;
  const original = manager.applyMarkToContent;
  manager.applyMarkToContent = function (markType, content, attrs) {
    const result = original.call(this, markType, content, attrs);
    return result.map((node) => (MARKED_INLINE_ATOMS.has(node.type ?? '')
      ? { ...node, marks: [...(node.marks ?? []), attrs ? { type: markType, attrs } : { type: markType }] }
      : node));
  };
  manager.nbInlineAtomMarksPatched = true;
}

/**
 * Markdown 在 onBeforeCreate 中创建解析器；最低优先级保证补充逻辑排在其后，
 * 无头编辑器也能在首次解析前生效，且不依赖是否启用双向链接。
 */
export const MarkdownInlineAtomMarks = Extension.create({
  name: 'markdownInlineAtomMarks',
  priority: 1,
  onBeforeCreate() {
    applyMarksToInlineAtoms((this.editor.storage as unknown as { markdown?: { manager?: InlineAtomMarkManager } }).markdown?.manager);
  },
});

const SAFE_UNDERLINE_PATTERN = /^\+\+(?!\s)([\s\S]*?\S)\+\+(?!\+)/;
const SAFE_HIGHLIGHT_PATTERN = /^==(?!\s)([^=]*?[^=\s])==(?!=)/;
// 默认高亮色（与 globals.css 中 `.ProseMirror mark` 一致），该颜色仍写作 `==x==`
const DEFAULT_HIGHLIGHT_COLOR = '#fef08a';
// 允许写入 style 属性的颜色值：十六进制、颜色名与 rgb()/hsl() 等函数写法，排除引号与尖括号
const SAFE_COLOR_VALUE = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(?:rgb|rgba|hsl|hsla)\([\d\s.,%/]+\))$/;
// `background: <单个颜色>` 简写（源码模式旧版工具栏的写法）
const BACKGROUND_SHORTHAND = /(?:^|;)\s*background\s*:\s*([^;]+?)\s*(?:;|$)/i;
// 彩色高亮的标准写法（与 renderMarkdown 输出一致）
const COLORED_MARK_OPEN_PREFIX = '<mark style="background-color: ';
const COLORED_MARK_OPEN_PATTERN = /^<mark style="background-color: ([^"<>;]+)">/;
const COLORED_MARK_CLOSE = '</mark>';
// 字体颜色的标准写法（与 renderMarkdown 输出一致）
const TEXT_COLOR_OPEN_PREFIX = '<span style="color: ';
const TEXT_COLOR_OPEN_PATTERN = /^<span style="color: ([^"<>;]+)">/;
const TEXT_COLOR_CLOSE = '</span>';

/** 按给定规则构造行内标记 token；不匹配时返回 undefined 让 marked 回退为普通文本。 */
function tokenizeDelimited(
  pattern: RegExp,
  type: string,
  src: string,
  lexer: MarkdownLexerConfiguration,
): MarkdownToken | undefined {
  const match = pattern.exec(src);
  if (!match) return undefined;
  const innerContent = match[1];
  return {
    type,
    raw: match[0],
    text: innerContent,
    tokens: lexer.inlineTokens(innerContent),
  };
}

/** 下划线：仅替换 Markdown tokenizer，其余行为与官方扩展一致。 */
export const SafeMarkdownUnderline = Underline.extend({
  markdownTokenizer: {
    name: 'underline',
    level: 'inline',
    start: (src: string) => src.indexOf('++'),
    tokenize: (src, _tokens, lexer) => tokenizeDelimited(SAFE_UNDERLINE_PATTERN, 'underline', src, lexer),
  },
});

/**
 * 识别序列化产出的彩色高亮 `<mark style="background-color: X">…</mark>`，内部按行内 Markdown 解析
 *（走默认 HTML 路径时内部的 `**粗体**` 等会变成字面文本）。其它 `<mark>` 写法仍交给 HTML 解析。
 */
function tokenizeColoredMark(src: string, lexer: MarkdownLexerConfiguration): MarkdownToken | undefined {
  const open = COLORED_MARK_OPEN_PATTERN.exec(src);
  if (!open || !SAFE_COLOR_VALUE.test(open[1])) return undefined;
  const rest = src.slice(open[0].length);
  const closeIndex = rest.indexOf(COLORED_MARK_CLOSE);
  // 内容为空或含嵌套 <mark> 时不处理，避免错配闭合标签
  if (closeIndex <= 0 || /<mark\b/i.test(rest.slice(0, closeIndex))) return undefined;
  const innerContent = rest.slice(0, closeIndex);
  return {
    type: 'highlight',
    raw: open[0] + innerContent + COLORED_MARK_CLOSE,
    text: innerContent,
    color: open[1],
    tokens: lexer.inlineTokens(innerContent),
  };
}

/** 高亮颜色是否需要以 `<mark>` 写出：无颜色或默认黄色写作 `==x==`。 */
function resolveExplicitHighlightColor(color: unknown): string | null {
  if (typeof color !== 'string') return null;
  const value = color.trim();
  if (!value || value.toLowerCase() === DEFAULT_HIGHLIGHT_COLOR) return null;
  return SAFE_COLOR_VALUE.test(value) ? value : null;
}

/** 生成高亮的 Markdown 源码：默认色为 `==x==`，其它颜色为标准 `<mark>` 写法（源码模式工具栏共用）。 */
export function renderHighlightSource(content: string, color: unknown): string {
  const explicitColor = resolveExplicitHighlightColor(color);
  return explicitColor ? `${COLORED_MARK_OPEN_PREFIX}${explicitColor}">${content}${COLORED_MARK_CLOSE}` : `==${content}==`;
}

/**
 * 规范化高亮属性：会写作 `==x==` 的颜色（默认黄色等）统一存为无颜色，
 * 保证文档与其序列化结果重新解析后一致（否则冗余转义清理的语义校验失败，`[` 等被整体保留转义）。
 */
export function normalizeHighlightAttributes(color: unknown): { color: string | null } {
  return { color: resolveExplicitHighlightColor(color) };
}

/** 高亮：替换 Markdown tokenizer 与序列化，多色等配置由调用方 configure。 */
export const SafeMarkdownHighlight = Highlight.extend({
  addCommands() {
    const toAttributes = (attributes?: { color: string }) =>
      (attributes ? normalizeHighlightAttributes(attributes.color) : attributes) as { color: string } | undefined;
    return {
      ...this.parent?.(),
      setHighlight: (attributes) => ({ commands }) => commands.setMark(this.name, toAttributes(attributes)),
      toggleHighlight: (attributes) => ({ commands }) => commands.toggleMark(this.name, toAttributes(attributes)),
    };
  },
  addAttributes() {
    const attributes: Attributes = this.parent?.() ?? {};
    const colorAttribute = attributes.color;
    if (!colorAttribute) return attributes;
    return {
      ...attributes,
      color: {
        ...colorAttribute,
        // 在官方解析基础上补充 `background: #xxx` 简写，保留原始颜色写法而非浏览器规范化后的 rgb()
        parseHTML: (element: HTMLElement) => {
          const style = element.getAttribute('style') ?? '';
          const shorthand = BACKGROUND_SHORTHAND.exec(style)?.[1];
          if (!element.hasAttribute('data-color') && !/background-color/i.test(style) && shorthand && SAFE_COLOR_VALUE.test(shorthand)) {
            return shorthand;
          }
          return colorAttribute.parseHTML?.(element);
        },
      },
    };
  },
  renderMarkdown: (node, h) => renderHighlightSource(h.renderChildren(node), node.attrs?.color),
  parseMarkdown: (token, h) => {
    const color = typeof token.color === 'string' ? token.color : null;
    return h.applyMark('highlight', h.parseInline(token.tokens || []), color ? { color } : undefined);
  },
  markdownTokenizer: {
    name: 'highlight',
    level: 'inline',
    start: (src: string) => {
      const indexes = [src.indexOf('=='), src.indexOf(COLORED_MARK_OPEN_PREFIX)].filter((index) => index >= 0);
      return indexes.length > 0 ? Math.min(...indexes) : -1;
    },
    tokenize: (src, _tokens, lexer) =>
      tokenizeColoredMark(src, lexer) ?? tokenizeDelimited(SAFE_HIGHLIGHT_PATTERN, 'highlight', src, lexer),
  },
});

/**
 * 字体颜色预设：取中等明度的色值，浅色主题白底与深色主题黑底上都清晰可读
 *（深色主题另在 globals.css 中提亮显示，文件中仍保存原色值）。
 */
export const TEXT_COLORS = [
  { name: '红色', color: '#d44c47' },
  { name: '橙色', color: '#d9730d' },
  { name: '黄色', color: '#cb912f' },
  { name: '绿色', color: '#448361' },
  { name: '蓝色', color: '#337ea9' },
  { name: '紫色', color: '#9065b0' },
  { name: '粉色', color: '#c14c8a' },
  { name: '灰色', color: '#787774' },
];

/** 字体颜色是否可写入 style 属性；非法值返回 null */
function resolveTextColor(color: unknown): string | null {
  if (typeof color !== 'string') return null;
  const value = color.trim();
  return value && SAFE_COLOR_VALUE.test(value) ? value : null;
}

/** 生成字体颜色的 Markdown 源码（源码模式工具栏与可视化序列化共用）；颜色非法时原样返回内容 */
export function renderTextColorSource(content: string, color: unknown): string {
  const value = resolveTextColor(color);
  return value ? `${TEXT_COLOR_OPEN_PREFIX}${value}">${content}${TEXT_COLOR_CLOSE}` : content;
}

/**
 * 识别标准写法 `<span style="color: X">…</span>`，内部按行内 Markdown 解析。
 * 内容为空或含嵌套 <span> 时不处理，交给行内 HTML 原样保留，避免错配闭合标签。
 */
function tokenizeTextColor(src: string, lexer: MarkdownLexerConfiguration): MarkdownToken | undefined {
  const open = TEXT_COLOR_OPEN_PATTERN.exec(src);
  if (!open || !resolveTextColor(open[1]) || open[1] !== open[1].trim()) return undefined;
  const rest = src.slice(open[0].length);
  const closeIndex = rest.indexOf(TEXT_COLOR_CLOSE);
  if (closeIndex <= 0 || /<span\b/i.test(rest.slice(0, closeIndex))) return undefined;
  const innerContent = rest.slice(0, closeIndex);
  return {
    type: 'textColor',
    raw: open[0] + innerContent + TEXT_COLOR_CLOSE,
    text: innerContent,
    color: open[1],
    tokens: lexer.inlineTokens(innerContent),
  };
}

/**
 * 字体颜色标记。
 * marked 后注册的行内 tokenizer 先执行，须注册在 RawHtmlInline 之后，才能先于行内 HTML 识别标准写法。
 */
export const TextColor = Mark.create({
  name: 'textColor',

  addAttributes() {
    return {
      color: {
        default: null,
        // 只从本编辑器输出的 data 属性还原：网页粘贴的文字颜色（含深色网页的白字）不带入文档
        parseHTML: (element: HTMLElement) => resolveTextColor(element.getAttribute('data-text-color')),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-text-color]' }];
  },

  // 颜色同时写入 CSS 变量，供深色主题在显示时提亮；粘贴到其它应用仍保留原色
  renderHTML({ mark, HTMLAttributes }) {
    const color = resolveTextColor(mark.attrs.color);
    if (!color) return ['span', HTMLAttributes, 0];
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-text-color': color,
        class: 'nb-text-color',
        style: `color: ${color}; --nb-text-color: ${color}`,
      }),
      0,
    ];
  },

  renderMarkdown: (node, h) => renderTextColorSource(h.renderChildren(node), node.attrs?.color),
  parseMarkdown: (token, h) => {
    const color = resolveTextColor(token.color);
    return h.applyMark('textColor', h.parseInline(token.tokens || []), color ? { color } : undefined);
  },
  markdownTokenizer: {
    name: 'textColor',
    level: 'inline',
    start: (src: string) => src.indexOf(TEXT_COLOR_OPEN_PREFIX),
    tokenize: (src, _tokens, lexer) => tokenizeTextColor(src, lexer),
  },
});
