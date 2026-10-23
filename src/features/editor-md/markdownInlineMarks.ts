// NoteBoard 行内标记的安全 Markdown tokenizer
// 官方 Underline（++x++）与 Highlight（==x==）的 tokenizer 会匹配普通文本中的 `C++ and C++`、`a == b`，
// 并对内部内容做 trim，导致"只打开文件就篡改文本"。这里收紧为：
// 1. 定界符内侧不得为空白（与 CommonMark 强调的 flanking 规则一致）；
// 2. 闭合定界符后不得紧跟同一字符（避免 `+++`、`===` 被拆开）；
// 3. 不 trim 内部内容，保证往返无损。
// 不限制定界符外侧字符，保证中文语境 `文字==高亮==文字` 仍可识别。
// 多色高亮：`==x==` 只能表达默认黄色，其它颜色序列化为 `<mark style="background-color: …">x</mark>`，
// 否则保存后重新解析（如规范化）会把颜色丢成默认黄色。

import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import type { Attributes, MarkdownLexerConfiguration, MarkdownToken } from '@tiptap/core';

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
