// NoteBoard 块级原始 HTML 渲染预览
// 只负责"显示"：节点的 raw 原文仍是唯一数据源，序列化逐字输出，渲染结果从不写回文件。
// 渲染前用 DOMPurify 按白名单过滤（标签/属性集合参照 GitHub README 的渲染规则），
// 因为编辑器运行在 Tauri webview 中，未过滤的脚本可能直接访问 IPC。
// 以下情况不渲染、继续以源码样式展示：
// 1. 纯注释块（渲染后不可见，用户无从定位与编辑）；
// 2. 标签不配对的片段（如 `<div align="center">` 与 `</div>` 中间夹 Markdown 时被拆成的两半）；
// 3. 过滤后没有任何可见内容（如整块都是 <script>/<style>）。
// 自带样式表、SVG 或整页文档的复杂 HTML 走隔离渲染（isolated）：放宽白名单保留 <style>/class/SVG，
// 由节点视图放入 Shadow DOM，样式与编辑器互不影响，显示更接近浏览器；脚本、表单与顶层弹层等仍被过滤。

import DOMPurify from 'dompurify';
import { isBalancedHtml } from './rawHtmlScan';

export { isBalancedHtml };

/**
 * 渲染预览结果：render 为可安全插入的 HTML；isolated 为需放入 Shadow DOM 的 HTML 与样式表文本；
 * source 表示应按源码展示
 */
export type RawHtmlPreview =
  | { kind: 'render'; html: string }
  | { kind: 'isolated'; html: string; styles: string[] }
  | { kind: 'source'; reason: 'comment' | 'fragment' | 'empty' };

/** 渲染选项 */
export interface RawHtmlPreviewOptions {
  /** 允许对复杂 HTML 使用隔离渲染（仅块级 HTML 视图支持） */
  isolate?: boolean;
}

// 允许渲染的标签：GitHub 白名单 + 常见的 u / center
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'br', 'hr', 'wbr',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'a', 'img', 'picture', 'source', 'code', 'pre', 'kbd', 'samp', 'var', 'tt', 'q', 'cite', 'abbr', 'dfn', 'time', 'bdo',
  'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col',
  'details', 'summary', 'figure', 'figcaption', 'ruby', 'rt', 'rp', 'center',
];

// 允许的属性：排版/语义类属性 + 内联样式（笔记场景常用 <span style> 着色，越界定位由容器 contain 约束）
const ALLOWED_ATTR = [
  'align', 'valign', 'width', 'height', 'style', 'title', 'alt', 'href', 'src', 'srcset', 'media', 'type',
  'colspan', 'rowspan', 'scope', 'span', 'start', 'reversed', 'open', 'datetime', 'dir', 'lang', 'cite',
  'border', 'cellpadding', 'cellspacing', 'color', 'size', 'nowrap', 'hspace', 'vspace',
];

// 链接/图片地址：在 DOMPurify 默认规则基础上额外放行 Windows 盘符绝对路径（C:\...）
const ALLOWED_URI_REGEXP = /^(?:(?:(?:f|ht)tps?|mailto|tel):|[a-z]:[\\/]|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

const COMMENT_ONLY_PATTERN = /^(?:\s*<!--[\s\S]*?-->)+\s*$/;
// 不含文字时仍算可见内容的元素
const VISIBLE_ELEMENT_SELECTOR = 'img, picture, hr, table';
const ISOLATED_VISIBLE_ELEMENT_SELECTOR = 'img, picture, hr, table, svg, video';

// 需要隔离渲染的复杂 HTML：自带样式表、内联 SVG 或整页文档
const ISOLATED_HTML_PATTERN = /<(?:style|svg|html|head|body)(?:[\s>/]|$)|<!doctype\b/i;
// 隔离渲染在 DOMPurify 默认 HTML/SVG 白名单基础上额外禁用：
// 可输入的表单控件（在编辑器内抢占键盘）、模板与图像热区链接（绕过链接拦截直接导航）
const ISOLATED_FORBID_TAGS = ['form', 'input', 'textarea', 'select', 'option', 'optgroup', 'datalist', 'template', 'slot', 'map', 'area'];
// popovertarget / command / interestfor 等调用属性无需脚本即可弹出顶层浮层，会越出容器遮盖界面，予以移除；
// popover 本身保留：没有调用者时永远不会打开，与浏览器一样保持隐藏。自动播放与自动聚焦干扰编辑
const ISOLATED_FORBID_ATTR = ['popovertarget', 'popovertargetaction', 'command', 'commandfor', 'interestfor', 'autoplay', 'autofocus', 'accesskey', 'contenteditable'];
// 整页文档的 <body> 改写为带此类名的容器，样式表中的 body 选择器随之指向它
export const ISOLATED_BODY_CLASS = 'nb-html-body';
// 样式表中指向整页文档根节点的选择器：html / body 类型选择器与 :root
const DOCUMENT_SELECTOR_PATTERN = /(^|[\s>+~,(])(html|body)(?=$|[\s>+~,.:#[)])|:root\b/gi;
const DOCUMENT_SELECTOR_HINT = /\b(?:html|body)\b|:root/i;
const CSS_IMPORT_PATTERN = /@import\s[^;]*;/gi;

/** 解析 srcset 中的每个地址（保留宽度/像素密度描述符） */
function resolveSrcset(srcset: string, resolveSrc: (src: string) => string): string {
  return srcset
    .split(',')
    .map((entry) => {
      const [url, ...descriptors] = entry.trim().split(/\s+/);
      return url ? [resolveSrc(url), ...descriptors].join(' ') : '';
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * 生成块级原始 HTML 的渲染预览。
 * @param raw 节点保存的原文
 * @param resolveSrc 图片地址解析（本地相对路径 → webview 可访问的地址），默认原样返回
 */
export function renderRawHtmlPreview(
  raw: string,
  resolveSrc: (src: string) => string = (src) => src,
  options: RawHtmlPreviewOptions = {},
): RawHtmlPreview {
  if (COMMENT_ONLY_PATTERN.test(raw)) return { kind: 'source', reason: 'comment' };
  if (!isBalancedHtml(raw)) return { kind: 'source', reason: 'fragment' };
  if (options.isolate && ISOLATED_HTML_PATTERN.test(raw)) return renderIsolatedHtml(raw, resolveSrc);

  const fragment = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  if (!fragment.textContent?.trim() && !fragment.querySelector(VISIBLE_ELEMENT_SELECTOR)) {
    return { kind: 'source', reason: 'empty' };
  }

  rewriteMediaSources(fragment, resolveSrc);

  const container = document.createElement('div');
  container.appendChild(fragment);
  return { kind: 'render', html: container.innerHTML };
}

/** 隔离渲染：保留样式表与 SVG，整页文档的 <head> 样式与 <body> 内容一并提取 */
function renderIsolatedHtml(raw: string, resolveSrc: (src: string) => string): RawHtmlPreview {
  // 按整页文档解析：位于片段开头的 <style> 会被归入 <head>，按片段解析会被丢弃
  const root = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS: ISOLATED_FORBID_TAGS,
    FORBID_ATTR: ISOLATED_FORBID_ATTR,
    ALLOWED_URI_REGEXP,
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
  }) as HTMLElement;
  const body = root.querySelector('body');
  if (!body) return { kind: 'source', reason: 'empty' };

  // 样式表单独取出，由视图以 textContent 写入 <style>，不会再被当作 HTML 解析
  const styles: string[] = [];
  for (const style of Array.from(root.querySelectorAll('style'))) {
    const css = scopeDocumentSelectors(style.textContent ?? '');
    if (css.trim()) styles.push(css);
    style.remove();
  }

  // <body> 改写为普通容器并保留其属性（内联样式、class 等）
  const container = (root.ownerDocument ?? document).createElement('div');
  for (const attribute of Array.from(body.attributes)) container.setAttribute(attribute.name, attribute.value);
  container.classList.add(ISOLATED_BODY_CLASS);
  container.append(...Array.from(body.childNodes));
  if (!container.textContent?.trim() && !container.querySelector(ISOLATED_VISIBLE_ELEMENT_SELECTOR)) {
    return { kind: 'source', reason: 'empty' };
  }

  rewriteMediaSources(container, resolveSrc);
  return { kind: 'isolated', html: container.outerHTML, styles };
}

/** 递归改写样式规则中的 html / body / :root 选择器 */
function rewriteDocumentSelectors(rules: CSSRuleList): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const next = rule.selectorText.replace(DOCUMENT_SELECTOR_PATTERN, (_match, prefix: string | undefined, name: string | undefined) =>
        name ? `${prefix ?? ''}${name.toLowerCase() === 'body' ? `.${ISOLATED_BODY_CLASS}` : ':host'}` : ':host',
      );
      // 改写后不合法（如 html.dark → :host.dark）时浏览器忽略赋值，保持原选择器
      if (next !== rule.selectorText) rule.selectorText = next;
    }
    // @media / @supports / @layer 与 CSS 嵌套规则
    if ('cssRules' in rule && rule.cssRules) rewriteDocumentSelectors(rule.cssRules as CSSRuleList);
  }
}

/**
 * Shadow DOM 中不存在 <html>/<body>，把样式表中指向它们的选择器改写为宿主（:host）与 body 容器。
 * 借助 CSSOM 解析，不对 CSS 文本做正则替换，避免误改属性值与字符串；运行环境不支持时原样返回。
 */
function scopeDocumentSelectors(css: string): string {
  if (!DOCUMENT_SELECTOR_HINT.test(css)) return css;
  if (typeof CSSStyleSheet === 'undefined' || typeof CSSStyleSheet.prototype.replaceSync !== 'function') return css;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    rewriteDocumentSelectors(sheet.cssRules);
    // 构造样式表不支持 @import，单独保留在最前面
    const imports = css.match(CSS_IMPORT_PATTERN) ?? [];
    return [...imports, ...Array.from(sheet.cssRules, (rule) => rule.cssText)].join('\n');
  } catch {
    return css;
  }
}

// 整篇 Markdown 渲染结果允许保留的 class：代码高亮配色、高亮块/分栏结构与只读渲染自身的标记类。
// 其余 class 一律剔除，防止内容借用应用自身的类名（如全屏遮罩）伪装界面。
const ALLOWED_CLASS_PATTERN = /^(?:hljs(?:-[\w-]+)?|language-[\w+#.-]+|nb-callout|nb-columns|nb-column|nb-md-[\w-]+|[\w-]+_)$/;

/**
 * 净化整篇 Markdown 渲染出的 HTML（多维表格只读单元格等不经编辑器渲染的场景）。
 * 与块级 HTML 预览共用同一白名单，额外放行受限的 class。
 * @param html markdown-it 等渲染器输出的 HTML
 * @param resolveSrc 图片地址解析（本地相对路径 → webview 可访问的地址），默认原样返回
 */
export function sanitizeRenderedMarkdown(html: string, resolveSrc: (src: string) => string = (src) => src): string {
  if (!html) return '';
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: [...ALLOWED_ATTR, 'class'],
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });

  for (const element of fragment.querySelectorAll('[class]')) {
    const kept = Array.from(element.classList).filter((name) => ALLOWED_CLASS_PATTERN.test(name));
    if (kept.length > 0) element.setAttribute('class', kept.join(' '));
    else element.removeAttribute('class');
  }
  rewriteMediaSources(fragment, resolveSrc);

  const container = document.createElement('div');
  container.appendChild(fragment);
  return container.innerHTML;
}

/** 改写片段内图片/媒体地址，并统一图片的拖拽、Referer 与尺寸处理 */
function rewriteMediaSources(fragment: ParentNode, resolveSrc: (src: string) => string): void {
  // 本地图片地址改写为 webview 可加载的地址；禁止原生拖拽图片（会把地址拖进编辑器）；
  // 网络图片与图片节点一致不发送 Referer（兼顾隐私与图床防盗链）
  for (const image of fragment.querySelectorAll('img')) {
    const src = image.getAttribute('src');
    if (src) image.setAttribute('src', resolveSrc(src));
    image.setAttribute('draggable', 'false');
    image.setAttribute('referrerpolicy', 'no-referrer');
    // 全局预检样式 `img { height: auto }` 会让 height 属性失效（只写 height 的 SVG 徽章会被撑满整行），改写为内联尺寸
    const height = image.getAttribute('height')?.trim();
    if (height && !image.style.height) image.style.height = /^\d+(?:\.\d+)?$/.test(height) ? `${height}px` : height;
  }
  for (const element of fragment.querySelectorAll('img[srcset], source[srcset]')) {
    element.setAttribute('srcset', resolveSrcset(element.getAttribute('srcset') ?? '', resolveSrc));
  }
  for (const source of fragment.querySelectorAll('source[src], video[src], audio[src]')) {
    source.setAttribute('src', resolveSrc(source.getAttribute('src') ?? ''));
  }
  for (const video of fragment.querySelectorAll('video[poster]')) {
    video.setAttribute('poster', resolveSrc(video.getAttribute('poster') ?? ''));
  }
}
