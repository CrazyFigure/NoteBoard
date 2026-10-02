// NoteBoard 行内标记的安全 Markdown tokenizer
// 官方 Underline（++x++）与 Highlight（==x==）的 tokenizer 会匹配普通文本中的 `C++ and C++`、`a == b`，
// 并对内部内容做 trim，导致"只打开文件就篡改文本"。这里收紧为：
// 1. 定界符内侧不得为空白（与 CommonMark 强调的 flanking 规则一致）；
// 2. 闭合定界符后不得紧跟同一字符（避免 `+++`、`===` 被拆开）；
// 3. 不 trim 内部内容，保证往返无损。
// 不限制定界符外侧字符，保证中文语境 `文字==高亮==文字` 仍可识别。

import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import type { MarkdownLexerConfiguration, MarkdownToken } from '@tiptap/core';

const SAFE_UNDERLINE_PATTERN = /^\+\+(?!\s)([\s\S]*?\S)\+\+(?!\+)/;
const SAFE_HIGHLIGHT_PATTERN = /^==(?!\s)([^=]*?[^=\s])==(?!=)/;

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

/** 高亮：仅替换 Markdown tokenizer，多色等配置由调用方 configure。 */
export const SafeMarkdownHighlight = Highlight.extend({
  markdownTokenizer: {
    name: 'highlight',
    level: 'inline',
    start: (src: string) => src.indexOf('=='),
    tokenize: (src, _tokens, lexer) => tokenizeDelimited(SAFE_HIGHLIGHT_PATTERN, 'highlight', src, lexer),
  },
});
