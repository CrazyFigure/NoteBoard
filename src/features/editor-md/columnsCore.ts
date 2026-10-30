// 共享文档规则：后台解析与主线程使用同一份定义，禁止引入界面、store 或原生 API。
import { Node, mergeAttributes } from '@tiptap/core';
import { createIndexedBlockStart } from './markdownBlockStart';
import { emitRawSegment } from './rawMarkdownSegments';
import { DIV_CLOSE_TAG, readDivBody } from './divBlockSyntax';

/** 外层容器开始标签（标准写法，逐字匹配） */
export const COLUMNS_OPEN_TAG = '<div class="nb-columns" style="display: flex; gap: 16px;">';

// 单栏开始标签：栏宽只接受规范数字（无前导零、无多余小数位），保证解析后能逐字还原
export const COLUMN_OPEN_PATTERN = /^<div class="nb-column" style="flex: (0\.[1-9]|[1-9]\d{0,2}(?:\.[1-9])?); min-width: 0;">$/;

export const COLUMNS_START_PATTERN = /(?:^|\n)<div class="nb-columns" style="display: flex; gap: 16px;">\n<div class="nb-column" /;

/** 栏宽取一位小数；结果的字符串形式即规范写法 */
export function roundWidth(value: number): number {
  return Math.max(0.1, Math.min(999.9, Math.round(value * 10) / 10));
}

/** 生成单栏开始标签 */
export function renderColumnOpenTag(width: number): string {
  return `<div class="nb-column" style="flex: ${roundWidth(width)}; min-width: 0;">`;
}

/** 标准写法分栏块的分析结果 */
export interface ColumnsMatch {
  raw: string;
  columns: Array<{ width: number; body: string }>;
}

/**
 * 识别源码开头的标准写法分栏块；不符合标准写法时返回 null（交由 RawHtmlBlock 原样保留）。
 * 导出供测试使用。
 */
export function matchColumnsBlock(src: string): ColumnsMatch | null {
  if (!src.startsWith(`${COLUMNS_OPEN_TAG}\n`)) return null;
  const lines = src.split('\n');
  const columns: ColumnsMatch['columns'] = [];
  let index = 1;

  while (index < lines.length) {
    const open = COLUMN_OPEN_PATTERN.exec(lines[index]);
    if (!open) break;
    // 单栏为「开始标签 + 空行 + 正文 + 空行 + 结束标签」，结构不符即整体不识别
    const parsed = readDivBody(lines, index);
    if (!parsed) return null;
    const { body, closeIndex } = parsed;
    columns.push({ width: Number(open[1]), body });
    index = closeIndex + 1;
  }

  // 至少一栏，且各栏之后紧跟外层结束标签
  if (columns.length === 0 || lines[index] !== DIV_CLOSE_TAG) return null;
  // 结束标签后必须是空行或文末，否则 CommonMark 会把后续文字并入同一 HTML 块
  if (index + 1 < lines.length && lines[index + 1].trim() !== '') return null;

  const raw = lines.slice(0, index + 1).join('\n') + (index + 1 < lines.length ? '\n' : '');
  return { raw, columns };
}

/** ColumnBlock 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const ColumnBlockCore = Node.create({
  name: 'columnBlock',
  content: 'block+',
  // 栏边界不可被退格/合并跨越
  isolating: true,
  defining: true,
  selectable: false,
  draggable: false,

  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      width: {
        default: 50,
        /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
        parseHTML: (element) => {
          const width = Number((element as HTMLElement).getAttribute('data-width'));
          return Number.isFinite(width) && width > 0 ? roundWidth(width) : 50;
        },
        /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
        renderHTML: (attributes) => ({
          'data-width': String(attributes.width),
          style: `flex: ${attributes.width} 1 0%; min-width: 0;`,
        }),
      },
    };
  },

  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [{ tag: 'div[data-column]' }];
  },

  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-column': '', class: 'nb-column' }), 0];
  },

  /** 按共享源码规则回写，结果不受节点视图和交互设置影响。 */
  renderMarkdown: (node, helpers) => {
    const head = emitRawSegment(renderColumnOpenTag(Number(node.attrs?.width ?? 50)));
    const tail = emitRawSegment(DIV_CLOSE_TAG);
    const body = node.content ? helpers.renderChildren(node.content, '\n\n') : '';
    return body.trim() === '' ? `${head}\n\n${tail}` : `${head}\n\n${body}\n\n${tail}`;
  }
});

/** ColumnsBlock 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const ColumnsBlockCore = Node.create({
  name: 'columnsBlock',
  group: 'block',
  content: 'columnBlock+',
  selectable: true,
  defining: true,
  isolating: true,

  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [{ tag: 'div[data-columns]' }];
  },

  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-columns': '', class: 'nb-columns' }), 0];
  },

  // 块级 tokenizer：优先于 marked 内置 html 块识别标准写法
  markdownTokenizer: {
    name: 'columnsBlock',
    level: 'block',
    start: createIndexedBlockStart(COLUMNS_START_PATTERN),
    tokenize: (src, _tokens, lexer) => {
      const match = matchColumnsBlock(src);
      if (!match) return undefined;
      const columns = match.columns.map((column) => {
        const tokens = column.body ? lexer.blockTokens(column.body) : [];
        // 位于列表内时 marked 以"非顶层"状态解析，段落会成为块级 text token；
        // 栏内正文按顶层块处理（与折叠块一致），原地改为段落以保留稍后填充的行内 token
        for (const token of tokens) {
          if (token.type === 'text' && Array.isArray(token.tokens)) token.type = 'paragraph';
        }
        return { width: column.width, tokens };
      });
      return {
        type: 'columnsBlock',
        raw: match.raw,
        text: match.raw,
        columns,
        // 汇总子 token，便于 marked 的 walkTokens 等遍历
        tokens: columns.flatMap((column) => column.tokens),
      };
    },
  },

  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown: (token, helpers) => {
    const parseBlocks = helpers.parseBlockChildren ?? helpers.parseChildren;
    const columns = (token.columns as Array<{ width: number; tokens: unknown[] }> | undefined) ?? [];
    const content = columns.map((column) => {
      const children = parseBlocks((column.tokens || []) as Parameters<typeof parseBlocks>[0]);
      // 栏内容约束为 block+，空栏补一个空段落
      return helpers.createNode('columnBlock', { width: column.width }, children.length > 0 ? children : [{ type: 'paragraph' }]);
    });
    return helpers.createNode('columnsBlock', {}, content);
  },

  // 序列化为标准写法；首尾标签走原样片段，避免全文后处理误改
  renderMarkdown: (node, helpers) => {
    const head = emitRawSegment(COLUMNS_OPEN_TAG);
    const tail = emitRawSegment(DIV_CLOSE_TAG);
    const body = node.content ? helpers.renderChildren(node.content, '\n') : '';
    return `${head}\n${body}\n${tail}`;
  }
});
