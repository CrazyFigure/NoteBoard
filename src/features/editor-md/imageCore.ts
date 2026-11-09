// 共享文档规则：后台解析与主线程使用同一份定义，禁止引入界面、store 或原生 API。
import { Node, mergeAttributes, type JSONContent, type MarkdownParseHelpers, type MarkdownToken } from '@tiptap/core';
import { Tokenizer } from 'marked';
import { emitRawSegment } from './rawMarkdownSegments';

// ── 图片 Markdown 序列化 ──

export const DEFAULT_IMAGE_WIDTH = '100%';

export const DEFAULT_IMAGE_ALIGN = 'center';

/** 解析 <img width> 属性：纯数字按像素处理，百分比/像素原样保留，其余回退默认宽度。 */
export function normalizeImageWidth(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  if (/^\d+(?:\.\d+)?%$/.test(trimmed) || /^\d+(?:\.\d+)?px$/.test(trimmed)) return trimmed;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return `${trimmed}px`;
  return DEFAULT_IMAGE_WIDTH;
}

/** 解析 <img align> 属性：仅接受左/中/右三种对齐。 */
export function normalizeImageAlign(value: string | null | undefined): string {
  const lowered = (value ?? '').trim().toLowerCase();
  return lowered === 'left' || lowered === 'right' || lowered === 'center' ? lowered : DEFAULT_IMAGE_ALIGN;
}

/** HTML 属性值转义 */
export function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Markdown 链接 / 图片地址：含空白、括号或尖括号时用 <...> 包裹，避免目标被截断。 */
export function formatMarkdownDestination(src: string): string {
  if (!/[\s()<>]/.test(src)) return src;
  return `<${src.replace(/[<>]/g, (character) => encodeURIComponent(character))}>`;
}

// 标题沿用 Markdown 的三种定界符，且必须紧接图片结束括号，避免把文件名中间的引号当成标题。
const IMAGE_TITLE_SUFFIX = /^[ \t]+("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\((?:\\.|[^()\\\r\n])*\))[ \t]*\)/;

/**
 * 为原生分词器无法识别的裸空格图片地址补充兼容。只扫描当前行内的图片，
 * 标签、转义、标题仍交给原生分词器校验；返回原地址供 Windows 路径保护使用。
 */
export function tokenizeImageWithSpaces(source: string, tokenizer: Tokenizer) {
  if (!source.startsWith('![')) return undefined;
  let labelDepth = 1;
  let index = 2;
  // 跳过转义和行内代码，支持替代文字中的嵌套方括号。
  for (; index < source.length && labelDepth > 0; index += 1) {
    const character = source[index];
    if (character === '\r' || character === '\n') return undefined;
    if (character === '\\') {
      index += 1;
    } else if (character === '`') {
      const code = Tokenizer.prototype.codespan.call(tokenizer, source.slice(index));
      if (code) index += code.raw.length - 1;
    } else if (character === '[') {
      labelDepth += 1;
    } else if (character === ']') {
      labelDepth -= 1;
    }
  }
  if (labelDepth !== 0 || source[index] !== '(') return undefined;
  index += 1;
  while (source[index] === ' ' || source[index] === '\t') index += 1;
  const destinationStart = index;
  // 尖括号地址已经由标准语法支持，不在兼容规则中重新解释。
  if (source[index] === '<') return undefined;
  let parentheses = 0;
  let destinationEnd = index;
  let title = '';
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\r' || character === '\n') return undefined;
    if (parentheses === 0 && (character === ' ' || character === '\t')) {
      const suffix = IMAGE_TITLE_SUFFIX.exec(source.slice(index));
      if (suffix) {
        destinationEnd = index;
        title = ` ${suffix[1]}`;
        index += suffix[0].length - 1;
        break;
      }
      // 连续空白只探测一次标题，避免长文件名中的空白序列导致重复扫描。
      while (source[index + 1] === ' ' || source[index + 1] === '\t') index += 1;
    }
    if (character === '\\') {
      index += 1;
    } else if (character === '(') {
      parentheses += 1;
    } else if (character === ')') {
      if (parentheses === 0) {
        destinationEnd = index;
        break;
      }
      parentheses -= 1;
    }
  }
  if (index >= source.length) return undefined;
  const destination = source.slice(destinationStart, destinationEnd).trimEnd();
  if (!/[^\S\r\n]/.test(destination)) return undefined;
  // 临时使用标准尖括号写法解析，保留真实 raw，避免打开或切换模式时改写源码。
  const canonical = `${source.slice(0, destinationStart)}${formatMarkdownDestination(destination)}${title})`;
  const token = Tokenizer.prototype.link.call(tokenizer, canonical);
  if (!token || token.type !== 'image' || token.raw.length !== canonical.length) return undefined;
  token.raw = source.slice(0, index + 1);
  return { token, destination };
}

/**
 * 图片序列化：默认尺寸与对齐输出标准 `![alt](src "title")`；
 * 用户调整过尺寸或对齐时输出 `<img>`，保证重新打开后排版可恢复（GitHub 等渲染器同样识别 width / align）。
 */
export function renderImageMarkdown(attrs: Record<string, unknown>): string {
  const src = String(attrs.src ?? '');
  const alt = String(attrs.alt ?? '');
  const title = String(attrs.title ?? '');
  const width = String(attrs.width ?? DEFAULT_IMAGE_WIDTH) || DEFAULT_IMAGE_WIDTH;
  const align = String(attrs.align ?? DEFAULT_IMAGE_ALIGN) || DEFAULT_IMAGE_ALIGN;

  if (width !== DEFAULT_IMAGE_WIDTH || align !== DEFAULT_IMAGE_ALIGN) {
    const parts = [`src="${escapeHtmlAttribute(src)}"`];
    if (alt) parts.push(`alt="${escapeHtmlAttribute(alt)}"`);
    if (title) parts.push(`title="${escapeHtmlAttribute(title)}"`);
    if (width !== DEFAULT_IMAGE_WIDTH) parts.push(`width="${escapeHtmlAttribute(width)}"`);
    if (align !== DEFAULT_IMAGE_ALIGN) parts.push(`align="${escapeHtmlAttribute(align)}"`);
    return `<img ${parts.join(' ')}>`;
  }

  // alt 中的方括号需转义（反斜杠保持原样，避免 Windows 路径类文本被翻倍）；title 中的双引号需转义
  const safeAlt = alt.replace(/([[\]])/g, '\\$1');
  const destination = formatMarkdownDestination(src);
  return title
    ? `![${safeAlt}](${destination} "${title.replace(/(["\\])/g, '\\$1')}")`
    : `![${safeAlt}](${destination})`;
}

/** 带链接的图片：外层包裹 `[...](href "title")`，与 README 徽章等写法 `[![alt](src)](href)` 一致 */
export function wrapImageLink(image: string, attrs: Record<string, unknown>): string {
  const href = typeof attrs.href === 'string' ? attrs.href : '';
  if (!href) return image;
  const linkTitle = typeof attrs.linkTitle === 'string' ? attrs.linkTitle : '';
  const destination = formatMarkdownDestination(href);
  return linkTitle
    ? `[${image}](${destination} "${linkTitle.replace(/(["\\])/g, '\\$1')}")`
    : `[${image}](${destination})`;
}

/**
 * 解析 `[![alt](src)](href)`：图片是独立节点，无法承载链接标记，原先外层链接会在解析时丢失。
 * 链接内容仅为一张图片时返回带 href 的图片节点；其余链接返回 null，由 Link 扩展按原逻辑处理。
 */
export function parseLinkedImageToken(token: MarkdownToken, helpers: MarkdownParseHelpers): JSONContent | null {
  const children = (token.tokens ?? []).filter((child) => !(child.type === 'text' && !child.raw?.trim()));
  const image = children.length === 1 && children[0].type === 'image' ? children[0] : null;
  if (!image) return null;
  return helpers.createNode('image', {
    src: image.href,
    title: image.title,
    alt: image.text,
    width: '100%',
    align: 'center',
    href: token.href,
    linkTitle: token.title || null,
  });
}

/** EnhancedImageBlock 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const EnhancedImageBlockCore = Node.create({
  name: 'image',
  group: 'block',
  inline: false,
  draggable: true,
  selectable: true,
  isolating: true,

  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      src: {
        default: null,
      },
      alt: {
        default: null,
      },
      title: {
        default: null,
      },
      width: {
        default: '100%',
      },
      align: {
        default: 'center',
      },
      // 图片外层链接（`[![alt](src)](href)`）及其标题，仅用于 Markdown 往返与悬停工具栏中的打开链接
      href: {
        default: null,
        rendered: false,
      },
      linkTitle: {
        default: null,
        rendered: false,
      },
    };
  },

  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          if (typeof dom === 'string') return {};
          const el = dom as HTMLImageElement;
          return {
            src: el.getAttribute('data-raw-src') || el.getAttribute('src'),
            alt: el.getAttribute('alt'),
            title: el.getAttribute('title'),
            // 兼容序列化输出的标准 width / align 属性（Markdown 中以 <img> 保存尺寸与对齐）
            width: el.getAttribute('data-width') || normalizeImageWidth(el.getAttribute('width')),
            align: el.getAttribute('data-align') || normalizeImageAlign(el.getAttribute('align')),
          };
        },
      },
    ];
  },

  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ HTMLAttributes }) {
    // 渲染 HTML 时默认添加 referrerpolicy，确保导出或预览时不被防盗链拦截
    return ['img', mergeAttributes({ referrerpolicy: 'no-referrer' }, HTMLAttributes)];
  },

  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown: (token, helpers) => {
    return helpers.createNode('image', {
      src: token.href,
      title: token.title,
      alt: token.text,
      width: '100%',
      align: 'center',
    });
  },

  // 图片地址、替代文字和标题已按各自语法转义，全文正文清理不得再次解释它们。
  renderMarkdown: (node) => emitRawSegment(wrapImageLink(renderImageMarkdown(node.attrs ?? {}), node.attrs ?? {}))
});
