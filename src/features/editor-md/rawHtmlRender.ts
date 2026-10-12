// NoteBoard 块级原始 HTML 渲染预览
// 只负责"显示"：节点的 raw 原文仍是唯一数据源，序列化逐字输出，渲染结果从不写回文件。
// 渲染前用 DOMPurify 按白名单过滤（标签/属性集合参照 GitHub README 的渲染规则），
// 因为编辑器运行在 Tauri webview 中，未过滤的脚本可能直接访问 IPC。
// 以下情况不渲染、继续以源码样式展示：
// 1. 纯注释块（渲染后不可见，用户无从定位与编辑）；
// 2. 标签不配对的片段（如 `<div align="center">` 与 `</div>` 中间夹 Markdown 时被拆成的两半）；
// 3. 过滤后没有任何可见内容（如整块都是 <script>/<style>）。

import DOMPurify from 'dompurify';

/** 渲染预览结果：render 为可安全插入的 HTML，source 表示应按源码展示 */
export type RawHtmlPreview =
  | { kind: 'render'; html: string }
  | { kind: 'source'; reason: 'comment' | 'fragment' | 'empty' };

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

// 无结束标签的空元素
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// 可省略结束标签的元素：未闭合不视为片段
const OPTIONAL_END_TAGS = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'option', 'rt', 'rp', 'colgroup']);
// 标签扫描：注释整体跳过；属性值可含 `>`，需按引号匹配
const TAG_SCAN_PATTERN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*(\/?)>/g;
const COMMENT_ONLY_PATTERN = /^(?:\s*<!--[\s\S]*?-->)+\s*$/;
// 不含文字时仍算可见内容的元素
const VISIBLE_ELEMENT_SELECTOR = 'img, picture, hr, table';

/** 判断 HTML 片段的标签是否配对（允许省略可选结束标签） */
export function isBalancedHtml(raw: string): boolean {
  const stack: string[] = [];
  TAG_SCAN_PATTERN.lastIndex = 0;
  for (const match of raw.matchAll(TAG_SCAN_PATTERN)) {
    const name = match[2]?.toLowerCase();
    // 注释或空元素、自闭合写法不参与配对
    if (!name || VOID_TAGS.has(name) || match[3] === '/') continue;
    if (match[1] !== '/') {
      stack.push(name);
      continue;
    }
    // 结束标签：越过中间可省略结束标签的元素寻找匹配项，找不到即为孤立的结束标签
    const index = stack.lastIndexOf(name);
    if (index < 0 || stack.slice(index + 1).some((tag) => !OPTIONAL_END_TAGS.has(tag))) return false;
    stack.length = index;
  }
  return stack.every((tag) => OPTIONAL_END_TAGS.has(tag));
}

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
export function renderRawHtmlPreview(raw: string, resolveSrc: (src: string) => string = (src) => src): RawHtmlPreview {
  if (COMMENT_ONLY_PATTERN.test(raw)) return { kind: 'source', reason: 'comment' };
  if (!isBalancedHtml(raw)) return { kind: 'source', reason: 'fragment' };

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
  for (const source of fragment.querySelectorAll('source[src]')) {
    source.setAttribute('src', resolveSrc(source.getAttribute('src') ?? ''));
  }

  const container = document.createElement('div');
  container.appendChild(fragment);
  return { kind: 'render', html: container.innerHTML };
}
