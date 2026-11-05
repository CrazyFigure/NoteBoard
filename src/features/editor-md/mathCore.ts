// 共享文档规则：后台解析与主线程使用同一份定义，禁止引入界面、store 或原生 API。
import { Node, mergeAttributes, type MarkdownToken, type MarkdownTokenizer } from '@tiptap/core';
import { findInlineMathStart, matchInlineMath } from './mathSyntax';
import { createIndexedBlockStart } from './markdownBlockStart';
import { emitRawSegment } from './rawMarkdownSegments';

// ── Markdown 公式语法 ──

/** 数学 tokenizer 附加在 marked token 上的 LaTeX 原文。 */
export type MathMarkdownToken = MarkdownToken & { latex?: string };

/** 行内 `$...$` tokenizer：不跨行，并跳过转义或不满足边界约束的美元符号。 */
export const inlineMathTokenizer: MarkdownTokenizer = {
  name: 'mathInline',
  level: 'inline',
  start: findInlineMathStart,
  tokenize(source) {
    const match = matchInlineMath(source);
    if (!match) return undefined;
    return {
      type: 'mathInline',
      raw: match.raw,
      latex: match.latex,
    };
  },
};

/** 查找独占一行或单行闭合的 `$$...$$` 块公式起点。 */
export const findBlockMathStart = createIndexedBlockStart(/^ {0,3}\$\$(?=[ \t]*(?:\r?\n|[^\r\n]*\$\$[ \t]*(?:\r?\n|$)))/m);

/** 块级 `$$...$$` tokenizer：同时支持标准多行形式与单行形式。 */
export const blockMathTokenizer: MarkdownTokenizer = {
  name: 'mathBlock',
  level: 'block',
  start: findBlockMathStart,
  tokenize(source) {
    const multiline = /^ {0,3}\$\$[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\$\$[ \t]*(?:\r?\n|$)/.exec(source);
    if (multiline) {
      return {
        type: 'mathBlock',
        raw: multiline[0],
        latex: multiline[1],
      };
    }

    const singleLine = /^ {0,3}\$\$[ \t]*([^\r\n]*?)[ \t]*\$\$[ \t]*(?:\r?\n|$)/.exec(source);
    if (!singleLine) return undefined;
    return {
      type: 'mathBlock',
      raw: singleLine[0],
      latex: singleLine[1],
    };
  },
};

/** MathInline 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const MathInlineCore = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      latex: {
        default: '',
      },
    };
  },
  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [
      { tag: 'span[data-math-inline]' },
    ];
  },
  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-math-inline': '' })];
  },
  /** 纯文本通道保留该节点的原始语义，不依赖节点视图。 */
  renderText({ node }) {
    // 剪贴板、搜索辅助文本等纯文本通道必须保留 Markdown 分隔符，不能丢失原子节点。
    return `$${String(node.attrs.latex ?? '')}$`;
  },
  markdownTokenName: 'mathInline',
  markdownTokenizer: inlineMathTokenizer,
  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown(token, helpers) {
    // tokenizer 已保存不含分隔符的原始 LaTeX，节点属性直接承载，禁止再次解释反斜杠。
    return helpers.createNode('mathInline', {
      latex: (token as MathMarkdownToken).latex ?? '',
    });
  },
  /** 按共享源码规则回写，结果不受节点视图和交互设置影响。 */
  renderMarkdown(node) {
    // LaTeX 内的实体和反斜杠都是公式源码，不能经过普通 Markdown 文本的全文清理。
    return emitRawSegment(`$${String(node.attrs?.latex ?? '')}$`);
  }
});

/** MathBlock 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const MathBlockCore = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      latex: {
        default: '',
      },
    };
  },
  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [
      { tag: 'div[data-math-block]' },
    ];
  },
  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-math-block': '' })];
  },
  /** 纯文本通道保留该节点的原始语义，不依赖节点视图。 */
  renderText({ node }) {
    // 块公式复制为标准多行 Markdown，粘贴回源码或其他编辑器后仍可识别。
    return `$$\n${String(node.attrs.latex ?? '')}\n$$`;
  },
  markdownTokenName: 'mathBlock',
  markdownTokenizer: blockMathTokenizer,
  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown(token, helpers) {
    // 块公式同样保留 LaTeX 原文，确保 \frac、\sum 等命令在模式往返后不丢反斜杠。
    return helpers.createNode('mathBlock', {
      latex: (token as MathMarkdownToken).latex ?? '',
    });
  },
  /** 按共享源码规则回写，结果不受节点视图和交互设置影响。 */
  renderMarkdown(node) {
    // 逐行保护正文，位于引用或列表时仍由父节点正确添加每行前缀。
    return emitRawSegment(`$$\n${String(node.attrs?.latex ?? '')}\n$$`);
  }
});
