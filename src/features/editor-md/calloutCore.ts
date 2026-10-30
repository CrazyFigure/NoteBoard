// 共享文档规则：后台解析与主线程使用同一份定义，禁止引入界面、store 或原生 API。
import { Node, mergeAttributes } from '@tiptap/core';
import { createIndexedBlockStart } from './markdownBlockStart';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { emitRawSegment } from './rawMarkdownSegments';
import { DIV_CLOSE_TAG, readDivBody } from './divBlockSyntax';
import { DEFAULT_CALLOUT_COLOR, DEFAULT_CALLOUT_ICON, calloutColorHex, isValidCalloutColor } from './calloutSchema';

// 开始标签：属性顺序固定，样式随后与颜色推导结果逐字比对
export const CALLOUT_OPEN_PATTERN = /^<div class="nb-callout" data-color="([a-z]+|#[0-9a-f]{6})"(?: data-icon="([a-z0-9]+(?:-[a-z0-9]+)*)")? style="[^"]*">$/;

export const CALLOUT_START_PATTERN = /(?:^|\n)<div class="nb-callout" data-color="/;

/** 由颜色推导导出用的内联样式（10% 底色 + 30% 描边，深浅背景下都可读） */
export function calloutExportStyle(color: string): string {
  const hex = calloutColorHex(color);
  return `padding: 12px 16px; border-radius: 8px; border: 1px solid ${hex}4d; background: ${hex}1a;`;
}

/** 生成开始标签（标准写法） */
export function renderCalloutOpenTag(color: string, icon: string): string {
  const iconAttr = icon ? ` data-icon="${icon}"` : '';
  return `<div class="nb-callout" data-color="${color}"${iconAttr} style="${calloutExportStyle(color)}">`;
}

/** 规范化颜色属性（异常值回退为默认色） */
export function colorOf(node: ProseMirrorNode | { attrs?: Record<string, unknown> }): string {
  const color = String(node.attrs?.color ?? '');
  return isValidCalloutColor(color) ? color : DEFAULT_CALLOUT_COLOR;
}

/** 规范化图标属性（非法图标名视为不带图标） */
export function iconOf(node: ProseMirrorNode | { attrs?: Record<string, unknown> }): string {
  const icon = String(node.attrs?.icon ?? '');
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(icon) ? icon : '';
}

/** 标准写法高亮块的分析结果 */
export interface CalloutMatch {
  raw: string;
  color: string;
  icon: string;
  body: string;
}

/**
 * 识别源码开头的标准写法高亮块；不符合标准写法时返回 null（交由 RawHtmlBlock 原样保留）。
 * 导出供测试使用。
 */
export function matchCalloutBlock(src: string): CalloutMatch | null {
  const firstBreak = src.indexOf('\n');
  const head = firstBreak < 0 ? src : src.slice(0, firstBreak);
  const open = CALLOUT_OPEN_PATTERN.exec(head);
  if (!open) return null;
  const color = open[1];
  const icon = open[2] ?? '';
  // 颜色必须合法，且样式与颜色推导结果逐字一致（手改过样式的视为自定义 HTML）
  if (!isValidCalloutColor(color) || head !== renderCalloutOpenTag(color, icon)) return null;

  const lines = src.split('\n');
  const parsed = readDivBody(lines, 0);
  if (!parsed) return null;
  const { body, closeIndex } = parsed;
  // 结束标签后必须是空行或文末，否则 CommonMark 会把后续文字并入同一 HTML 块
  if (closeIndex + 1 < lines.length && lines[closeIndex + 1].trim() !== '') return null;

  const raw = lines.slice(0, closeIndex + 1).join('\n') + (closeIndex + 1 < lines.length ? '\n' : '');
  return { raw, color, icon, body };
}

/** CalloutBlock 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const CalloutBlockCore = Node.create({
  name: 'calloutBlock',
  group: 'block',
  content: 'block+',
  selectable: true,
  defining: true,

  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      color: {
        default: DEFAULT_CALLOUT_COLOR,
        /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
        parseHTML: (element) => {
          const color = (element as HTMLElement).getAttribute('data-color') ?? '';
          return isValidCalloutColor(color) ? color : DEFAULT_CALLOUT_COLOR;
        },
        /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
        renderHTML: (attributes) => ({ 'data-color': String(attributes.color) }),
      },
      icon: {
        default: DEFAULT_CALLOUT_ICON,
        /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
        parseHTML: (element) => (element as HTMLElement).getAttribute('data-icon') ?? '',
        /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
        renderHTML: (attributes) => (attributes.icon ? { 'data-icon': String(attributes.icon) } : {}),
      },
    };
  },

  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  // 复制到剪贴板等场景输出带底色的 HTML，粘贴到其他应用也能看出是高亮块
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'nb-callout', style: calloutExportStyle(colorOf(node)) }),
      0,
    ];
  },

  // 块级 tokenizer：优先于 marked 内置 html 块识别标准写法
  markdownTokenizer: {
    name: 'calloutBlock',
    level: 'block',
    start: createIndexedBlockStart(CALLOUT_START_PATTERN),
    tokenize: (src, _tokens, lexer) => {
      const match = matchCalloutBlock(src);
      if (!match) return undefined;
      const tokens = match.body ? lexer.blockTokens(match.body) : [];
      // 位于列表内时 marked 以"非顶层"状态解析，段落会成为块级 text token；
      // 块内正文按顶层块处理（与分栏、折叠块一致），原地改为段落以保留稍后填充的行内 token
      for (const token of tokens) {
        if (token.type === 'text' && Array.isArray(token.tokens)) token.type = 'paragraph';
      }
      return {
        type: 'calloutBlock',
        raw: match.raw,
        text: match.raw,
        color: match.color,
        icon: match.icon,
        tokens,
      };
    },
  },

  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown: (token, helpers) => {
    const parseBlocks = helpers.parseBlockChildren ?? helpers.parseChildren;
    const children = parseBlocks(token.tokens || []);
    // 内容约束为 block+，空高亮块补一个空段落
    return helpers.createNode(
      'calloutBlock',
      { color: String(token.color), icon: String(token.icon ?? '') },
      children.length > 0 ? children : [{ type: 'paragraph' }],
    );
  },

  // 序列化为标准写法；首尾标签走原样片段，避免全文后处理误改
  renderMarkdown: (node, helpers) => {
    const head = emitRawSegment(renderCalloutOpenTag(colorOf(node), iconOf(node)));
    const tail = emitRawSegment(DIV_CLOSE_TAG);
    const body = node.content ? helpers.renderChildren(node.content, '\n\n') : '';
    return body.trim() === '' ? `${head}\n\n${tail}` : `${head}\n\n${body}\n\n${tail}`;
  }
});
