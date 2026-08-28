// NoteBoard 多维表格多行文本的 Markdown 只读渲染
// 与笔记本编辑器共用 lowlight 高亮实例，保证同一份代码在两处渲染效果一致
// 安全性：markdown-it 以 html:false 运行，源文本中的原始 HTML 一律被转义，不会注入脚本

import React, { useMemo } from 'react';
import MarkdownIt from 'markdown-it';
import { toHtml } from 'hast-util-to-html';
import { lowlight, normalizeLanguage, SINGLE_BLOCK_LIMIT } from '../editor-md/lowlight';

/** 单元格/卡片内的紧凑模式与侧栏的常规模式，仅影响排版密度 */
export type MarkdownDensity = 'compact' | 'normal';

interface BitableMarkdownProps {
  /** Markdown 源码 */
  source: string;
  /** 排版密度，默认 normal */
  density?: MarkdownDensity;
  /** 点击链接时的回调；未提供时链接不可跳转，避免 WebView 内部导航破坏应用 */
  onOpenLink?: (href: string) => void;
}

/** 样式只注入一次：用模块级标记避免每个单元格重复插入 style 标签 */
let styleInjected = false;

const MARKDOWN_CSS = `
.nb-bitable-md { color: var(--editor-text, #1e293b); word-break: break-word; }
.nb-bitable-md > *:first-child { margin-top: 0 !important; }
.nb-bitable-md > *:last-child { margin-bottom: 0 !important; }
.nb-bitable-md p { margin: 0.45em 0; }
.nb-bitable-md h1, .nb-bitable-md h2, .nb-bitable-md h3,
.nb-bitable-md h4, .nb-bitable-md h5, .nb-bitable-md h6 {
  margin: 0.6em 0 0.35em; font-weight: 700; line-height: 1.3; color: var(--editor-heading, #0f172a);
}
.nb-bitable-md h1 { font-size: 1.35em; }
.nb-bitable-md h2 { font-size: 1.2em; }
.nb-bitable-md h3 { font-size: 1.1em; }
.nb-bitable-md h4, .nb-bitable-md h5, .nb-bitable-md h6 { font-size: 1em; }
.nb-bitable-md ul, .nb-bitable-md ol { margin: 0.4em 0; padding-left: 1.5em; }
.nb-bitable-md li { margin: 0.15em 0; }
.nb-bitable-md li > p { margin: 0.1em 0; }
.nb-bitable-md blockquote {
  margin: 0.5em 0; padding: 0.2em 0.7em; border-left: 3px solid var(--editor-accent, #3b82f6);
  background: var(--editor-quote-bg, rgba(59,130,246,0.08)); border-radius: 0 4px 4px 0;
  color: var(--editor-text-secondary, #64748b);
}
.nb-bitable-md blockquote > *:first-child { margin-top: 0; }
.nb-bitable-md blockquote > *:last-child { margin-bottom: 0; }
.nb-bitable-md code {
  font-family: var(--editor-font-mono, 'Cascadia Code', Consolas, monospace);
  background: var(--editor-code-bg, #f8fafc); border: 1px solid var(--editor-border, #e5e7eb);
  border-radius: 3px; padding: 0.05em 0.35em; font-size: 0.9em;
}
.nb-bitable-md pre {
  margin: 0.5em 0; padding: 0.6em 0.75em; overflow-x: auto;
  background: var(--editor-code-bg, #f8fafc); border: 1px solid var(--editor-border, #e5e7eb);
  border-radius: 6px; line-height: 1.5;
}
.nb-bitable-md pre code {
  background: transparent; border: none; padding: 0; font-size: 0.88em; display: block;
}
.nb-bitable-md a { color: var(--editor-link, #2563eb); text-decoration: none; }
.nb-bitable-md a:hover { text-decoration: underline; }
.nb-bitable-md hr { border: none; border-top: 1px solid var(--editor-border, #e5e7eb); margin: 0.7em 0; }
.nb-bitable-md table { border-collapse: collapse; margin: 0.5em 0; font-size: 0.95em; }
.nb-bitable-md th, .nb-bitable-md td { border: 1px solid var(--editor-border, #e5e7eb); padding: 3px 8px; }
.nb-bitable-md th { background: var(--editor-code-bg, #f8fafc); font-weight: 600; }
.nb-bitable-md img { max-width: 100%; border-radius: 4px; }
.nb-bitable-md.compact { font-size: 12px; line-height: 1.55; }
.nb-bitable-md.compact p { margin: 0.3em 0; }
.nb-bitable-md.compact h1 { font-size: 1.2em; }
.nb-bitable-md.compact h2 { font-size: 1.12em; }
.nb-bitable-md.compact h3 { font-size: 1.05em; }
.nb-bitable-md.compact pre { padding: 0.45em 0.6em; max-height: 220px; }
.nb-bitable-md.compact blockquote { padding: 0.1em 0.6em; }
/* highlight.js 语法高亮配色：随主题切换，仅覆盖常用 token，未覆盖的保持正文色 */
.nb-bitable-md .hljs-comment, .nb-bitable-md .hljs-quote { color: var(--editor-text-muted, #94a3b8); font-style: italic; }
.nb-bitable-md .hljs-keyword, .nb-bitable-md .hljs-selector-tag, .nb-bitable-md .hljs-literal { color: #a855f7; }
.nb-bitable-md .hljs-string, .nb-bitable-md .hljs-regexp, .nb-bitable-md .hljs-addition { color: #16a34a; }
.nb-bitable-md .hljs-number, .nb-bitable-md .hljs-built_in, .nb-bitable-md .hljs-builtin-name { color: #d97706; }
.nb-bitable-md .hljs-title, .nb-bitable-md .hljs-section, .nb-bitable-md .hljs-title.function_ { color: #2563eb; }
.nb-bitable-md .hljs-attr, .nb-bitable-md .hljs-attribute, .nb-bitable-md .hljs-variable,
.nb-bitable-md .hljs-template-variable { color: #db2777; }
.nb-bitable-md .hljs-type, .nb-bitable-md .hljs-class .hljs-title { color: #0891b2; }
.nb-bitable-md .hljs-deletion { color: #dc2626; }
.nb-bitable-md .hljs-emphasis { font-style: italic; }
.nb-bitable-md .hljs-strong { font-weight: 700; }
`;

/** 懒创建共享解析器：多维表格可能同时渲染数百个单元格，实例必须复用 */
let parser: MarkdownIt | null = null;

function getParser(): MarkdownIt {
  if (parser) return parser;
  parser = new MarkdownIt({
    // 关闭原始 HTML：单元格内容可能来自粘贴的外部数据，转义后渲染可杜绝脚本注入
    html: false,
    linkify: true,
    breaks: true,
    typographer: false,
    highlight: (code, lang) => {
      // 超长文本跳过语法高亮，避免高亮计算卡住滚动
      if (code.length > SINGLE_BLOCK_LIMIT) return '';
      const name = normalizeLanguage(lang);
      try {
        // lowlight 未注册的语言会抛错，回退到自动识别
        const tree = lowlight.registered(name)
          ? lowlight.highlight(name, code)
          : lowlight.highlightAuto(code);
        return `<pre><code class="hljs">${toHtml(tree)}</code></pre>`;
      } catch {
        return '';
      }
    },
  });
  return parser;
}

/**
 * 把 Markdown 源码渲染为 HTML 字符串
 * 单独导出以便单元测试验证高亮与安全转义，无需挂载 React 组件。
 * 任何解析异常都降级为空串：一个坏单元格不能炸掉整张表。
 */
export function renderBitableMarkdown(source: string): string {
  if (!source) return '';
  try {
    return getParser().render(source);
  } catch {
    return '';
  }
}

/** 首次渲染时把样式表挂到 document.head，供所有单元格共享 */
function ensureStyleInjected() {
  if (styleInjected || typeof document === 'undefined') return;
  const exists = document.getElementById('nb-bitable-md-style');
  if (exists) {
    styleInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'nb-bitable-md-style';
  style.textContent = MARKDOWN_CSS;
  document.head.appendChild(style);
  styleInjected = true;
}

export function BitableMarkdown({
  source,
  density = 'normal',
  onOpenLink,
}: BitableMarkdownProps) {
  ensureStyleInjected();

  // 解析结果按源码缓存：滚动或选区变化时不重复解析
  const html = useMemo(() => renderBitableMarkdown(source), [source]);

  // 拦截链接点击：默认阻止 WebView 内部导航，交由上层决定打开方式
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement | null)?.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    if (onOpenLink) onOpenLink(href);
  };

  if (!source) return null;

  return (
    <div
      className={`nb-bitable-md${density === 'compact' ? ' compact' : ''}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
