// NoteBoard Markdown HTML 实体解析
// TipTap 只解码 &lt; &gt; &quot; &amp; 四个实体，`&copy;`、`&nbsp;`、`&#169;` 等会被当成字面文本，
// 序列化后变成 `&amp;copy;`，在 GitHub / VS Code 中从 © 变成字面的 "&copy;"。
// 这里以行内 tokenizer 接管所有合法的 CommonMark 实体引用，解码为对应字符。
// 代码、行内 HTML、链接地址由各自的 tokenizer 先行消费，不受影响。

import { Extension, type JSONContent, type MarkdownToken } from '@tiptap/core';

// CommonMark 实体引用：命名实体、十进制与十六进制数字实体，必须以分号结尾
const ENTITY_PATTERN = /^&(?:([a-zA-Z][a-zA-Z0-9]{1,31})|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/;

const namedEntityCache = new Map<string, string | null>();
let decoderElement: HTMLTextAreaElement | null = null;

/**
 * 解码命名实体；未知名称返回 null。
 * 借助浏览器内置的 HTML 实体表（textarea 只解析文本，传入的字符串已由正则限定为单个实体，不含标签）。
 * 无 DOM 环境（如 Worker）时返回 null，保持旧行为（按字面文本处理）。
 */
function decodeNamedEntity(name: string): string | null {
  const cached = namedEntityCache.get(name);
  if (cached !== undefined) return cached;
  if (typeof document === 'undefined') return null;
  decoderElement ??= document.createElement('textarea');
  decoderElement.innerHTML = `&${name};`;
  const value = decoderElement.value;
  const decoded = value === `&${name};` ? null : value;
  namedEntityCache.set(name, decoded);
  return decoded;
}

/** 解码数字实体：0、代理区与超出范围的码点按 CommonMark 规定替换为 U+FFFD */
function decodeNumericEntity(codePoint: number): string {
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '�';
  return String.fromCodePoint(codePoint);
}

/** 解码 src 开头的实体引用；不是合法实体时返回 null */
export function decodeLeadingEntity(src: string): { raw: string; text: string } | null {
  const match = ENTITY_PATTERN.exec(src);
  if (!match) return null;
  const [raw, name, decimal, hex] = match;
  if (name !== undefined) {
    const text = decodeNamedEntity(name);
    return text === null ? null : { raw, text };
  }
  return { raw, text: decodeNumericEntity(decimal !== undefined ? Number(decimal) : parseInt(hex, 16)) };
}

/** 判断文本开头（`&` 之后的部分）是否构成会被解码的实体引用，如 `copy;`、`#39;` */
export function isDecodableEntitySuffix(suffix: string): boolean {
  if (!/^(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/.test(suffix)) return false;
  // 无 DOM 时无法确认命名实体是否存在，保守视为实体
  if (/^[a-zA-Z]/.test(suffix) && typeof document !== 'undefined') return decodeLeadingEntity(`&${suffix}`) !== null;
  return true;
}

/**
 * 不可见的空白类字符及其实体写法。原文用实体书写它们时（如 `&nbsp;`），序列化沿用实体；
 * 原文直接使用字符（如从网页复制来的不间断空格）时保持字符原样，见 usesInvisibleCharacterEntities。
 * 只收录空白与零宽空格；零宽连接符等会出现在表情序列中，不在此列。
 */
export const INVISIBLE_CHARACTER_ENTITIES: Record<string, string> = {
  ' ': '&nbsp;',
  ' ': '&ensp;',
  ' ': '&emsp;',
  ' ': '&thinsp;',
  '​': '&#8203;',
};

/** 原文是否以实体书写不可见空白字符（决定序列化时写回实体还是字符） */
export function usesInvisibleCharacterEntities(markdown: string): boolean {
  for (const match of markdown.matchAll(/&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/g)) {
    const entity = decodeLeadingEntity(match[0]);
    if (entity && INVISIBLE_CHARACTER_ENTITIES[entity.text]) return true;
  }
  return false;
}

/** HTML 实体：解析为对应字符的文本节点（序列化由普通文本负责，无需 renderMarkdown） */
export const MarkdownHtmlEntity = Extension.create({
  name: 'markdownHtmlEntity',
  markdownTokenName: 'htmlEntity',
  markdownTokenizer: {
    name: 'htmlEntity',
    level: 'inline',
    start: (src: string) => src.indexOf('&'),
    tokenize: (src: string): MarkdownToken | undefined => {
      const entity = decodeLeadingEntity(src);
      return entity ? { type: 'htmlEntity', raw: entity.raw, text: entity.text } : undefined;
    },
  },
  parseMarkdown: (token: MarkdownToken): JSONContent => ({ type: 'text', text: token.text ?? '' }),
});
