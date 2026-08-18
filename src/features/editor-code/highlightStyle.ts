// NoteBoard CodeMirror 6 高亮样式
// @lezer/highlight tag → --hljs-* CSS 变量映射
// 详见 docs/06-主题与设计规范.md §6.4
// 这是让「同一套颜色驱动两个内核（CM6 + lowlight）」的关键

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t, type Tag } from '@lezer/highlight';

// ── 辅助：从 CSS 变量取色 ──

function cssVar(name: string): string {
  return `var(${name})`;
}

// ── tag → Token 映射表（照 docs/06-主题与设计规范.md §6.4 逐行抄）──

interface TagStyleSpec {
  tag: Tag | Tag[];
  color?: string;
  fontStyle?: 'italic' | 'normal';
  fontWeight?: 'bold' | 'normal';
  textDecoration?: string;
}

export const SPEC: TagStyleSpec[] = [
  // comment → --hljs-comment + italic
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: cssVar('--hljs-comment'),
    fontStyle: 'italic',
  },
  // keyword → --hljs-keyword
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
    ],
    color: cssVar('--hljs-keyword'),
  },
  // string → --hljs-string
  {
    tag: [t.string, t.special(t.string), t.docString],
    color: cssVar('--hljs-string'),
  },
  // number/integer/float/bool/null → --hljs-number
  {
    tag: [t.number, t.integer, t.float, t.bool, t.null],
    color: cssVar('--hljs-number'),
  },
  // typeName → --hljs-number (与 hljs 的 type→number 一致)
  {
    tag: [t.typeName, t.standard(t.typeName)],
    color: cssVar('--hljs-number'),
  },
  // className → --hljs-class
  { tag: t.className, color: cssVar('--hljs-class') },
  // propertyName / definition(propertyName) → --hljs-title (JSON 的键走这里)
  {
    tag: [t.propertyName, t.definition(t.propertyName)],
    color: cssVar('--hljs-title'),
  },
  // variableName / local(variableName) → --hljs-variable
  {
    tag: [t.variableName, t.local(t.variableName)],
    color: cssVar('--hljs-variable'),
  },
  // function(variableName) / function(propertyName) → --hljs-function
  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    color: cssVar('--hljs-function'),
  },
  // tagName → --hljs-title (XML/HTML 标签名)
  { tag: t.tagName, color: cssVar('--hljs-title') },
  // attributeName → --hljs-attr (XML 属性名)
  { tag: t.attributeName, color: cssVar('--hljs-attr') },
  // attributeValue → --hljs-string
  { tag: t.attributeValue, color: cssVar('--hljs-string') },
  // regexp → --hljs-regexp
  { tag: t.regexp, color: cssVar('--hljs-regexp') },
  // meta / processingInstruction → --hljs-meta (XML 的 <?xml ?>)
  {
    tag: [t.meta, t.processingInstruction],
    color: cssVar('--hljs-meta'),
  },
  // link / url → --hljs-link + underline
  {
    tag: [t.link, t.url],
    color: cssVar('--hljs-link'),
    textDecoration: 'underline',
  },
  // escape → --hljs-variable
  { tag: t.escape, color: cssVar('--hljs-variable') },
  // labelName → --hljs-selector-id
  { tag: t.labelName, color: cssVar('--hljs-selector-id') },
  // inserted → --hljs-addition
  { tag: t.inserted, color: cssVar('--hljs-addition') },
  // deleted → --hljs-deletion
  { tag: t.deleted, color: cssVar('--hljs-deletion') },
  // operator / punctuation / separator / bracket → --editor-text-secondary
  {
    tag: [t.operator, t.punctuation, t.separator, t.bracket],
    color: cssVar('--editor-text-secondary'),
  },
  // heading → --editor-heading + bold (Markdown source 模式)
  {
    tag: t.heading,
    color: cssVar('--editor-heading'),
    fontWeight: 'bold',
  },
  // emphasis → italic
  { tag: t.emphasis, fontStyle: 'italic' },
  // strong → bold
  { tag: t.strong, fontWeight: 'bold' },
  // strikethrough → line-through
  { tag: t.strikethrough, textDecoration: 'line-through' },
  // invalid → --error-500 + 波浪下划线
  {
    tag: t.invalid,
    color: 'var(--error-500)',
    textDecoration: 'underline wavy',
  },
];


const styleSpec = SPEC.flatMap(({ tag, ...rest }) => {
  const tags = Array.isArray(tag) ? tag : [tag];
  return tags.map((tg) => ({ tag: tg, ...rest }));
});

export const nbHighlightStyle = HighlightStyle.define(styleSpec);

// ── 便捷导出：高亮扩展 ──

export const nbSyntaxHighlighting = syntaxHighlighting(nbHighlightStyle);
