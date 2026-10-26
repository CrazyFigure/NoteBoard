// NoteBoard 多维表格多行文本的 Markdown 只读渲染
// 与笔记本编辑器共用 lowlight 高亮实例，保证同一份代码在两处渲染效果一致
// 单元格编辑器与笔记本共用扩展集，因此这里同样识别笔记本的扩展语法：
// 公式（$ / $$，KaTeX 渲染）、==高亮== / ++下划线++、GitHub 提示块、任务列表、
// 高亮块 / 分栏 / 折叠块（标准 HTML 写法），图表围栏以轻量占位展示（单元格可能成百上千，不逐个渲染图表）。
// 安全性：允许原始 HTML 以承载上述块，但整篇输出经 DOMPurify 白名单净化，脚本与事件属性一律剔除

import React, { useEffect, useMemo, useRef } from 'react';
import MarkdownIt from 'markdown-it';
import { toHtml } from 'hast-util-to-html';
import { lowlight, normalizeLanguage, SINGLE_BLOCK_LIMIT } from '../editor-md/lowlight';
import { matchInlineMath } from '../editor-md/mathSyntax';
import { ALERT_META, type AlertKind } from '../editor-md/alertExtension';
import { sanitizeRenderedMarkdown } from '../editor-md/rawHtmlRender';
import { resolveDocumentImageSrc } from '../editor-md/rawHtmlBlockView';
// 公式排版样式（KaTeX 运行时本身按需懒加载）
import 'katex/dist/katex.min.css';

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
/* 内容内的定位元素以渲染容器为参照，不能借 fixed 定位覆盖到应用界面上 */
.nb-bitable-md { contain: layout; }
.nb-bitable-md mark { background: #fef08a; color: inherit; border-radius: 2px; padding: 0 1px; }
/* 公式：KaTeX 加载前先显示源码，加载后替换为排版结果 */
.nb-bitable-md .nb-md-math { font-family: var(--editor-font-mono, 'Cascadia Code', Consolas, monospace); font-size: 0.92em; color: var(--editor-text-secondary, #64748b); }
.nb-bitable-md .nb-md-math.is-rendered { font-family: inherit; font-size: inherit; color: inherit; }
.nb-bitable-md div.nb-md-math { margin: 0.5em 0; overflow-x: auto; overflow-y: hidden; text-align: center; }
/* GitHub 提示块 */
.nb-bitable-md blockquote.nb-md-alert { background: color-mix(in srgb, var(--nb-md-alert-color) 8%, transparent); border-left-color: var(--nb-md-alert-color); color: var(--editor-text, #1e293b); }
.nb-bitable-md .nb-md-alert-title { margin: 0 0 0.2em; font-weight: 600; color: var(--nb-md-alert-color); }
.nb-bitable-md .nb-md-alert-note { --nb-md-alert-color: #3b82f6; }
.nb-bitable-md .nb-md-alert-tip { --nb-md-alert-color: #10b981; }
.nb-bitable-md .nb-md-alert-important { --nb-md-alert-color: #8b5cf6; }
.nb-bitable-md .nb-md-alert-warning { --nb-md-alert-color: #f59e0b; }
.nb-bitable-md .nb-md-alert-caution { --nb-md-alert-color: #ef4444; }
/* 任务列表：只读勾选框 */
.nb-bitable-md ul.nb-md-task-list { list-style: none; padding-left: 0.2em; }
.nb-bitable-md li.nb-md-task { position: relative; padding-left: 1.45em; }
.nb-bitable-md li.nb-md-task::before {
  content: ''; position: absolute; left: 0; top: 0.3em; width: 0.9em; height: 0.9em; box-sizing: border-box;
  border: 1.5px solid var(--editor-text-muted, #94a3b8); border-radius: 3px;
}
.nb-bitable-md li.nb-md-task.nb-md-task-checked::before {
  border-color: var(--editor-accent, #3b82f6);
  background: var(--editor-accent, #3b82f6) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 100% no-repeat;
}
.nb-bitable-md li.nb-md-task.nb-md-task-checked > :not(ul):not(ol) { color: var(--editor-text-muted, #94a3b8); text-decoration: line-through; }
/* 高亮块：颜色由内联样式提供，这里只补齐间距 */
.nb-bitable-md .nb-callout { margin: 0.5em 0; padding: 0.45em 0.75em; border-radius: 6px; }
.nb-bitable-md .nb-callout > :first-child { margin-top: 0; }
.nb-bitable-md .nb-callout > :last-child { margin-bottom: 0; }
/* 分栏卡片 */
.nb-bitable-md .nb-columns { display: flex; gap: 8px; margin: 0.5em 0; }
.nb-bitable-md .nb-column { flex: 1 1 0%; min-width: 0; padding: 0.3em 0.6em; border: 1px solid var(--editor-border, #e5e7eb); border-radius: 6px; }
.nb-bitable-md .nb-column > :first-child { margin-top: 0; }
.nb-bitable-md .nb-column > :last-child { margin-bottom: 0; }
/* 折叠块 */
.nb-bitable-md details { margin: 0.5em 0; padding: 0.2em 0.6em; border: 1px solid var(--editor-border, #e5e7eb); border-radius: 6px; }
.nb-bitable-md summary { cursor: pointer; font-weight: 600; }
/* 图表占位：单元格内不逐个渲染图表，打开编辑器查看 */
.nb-bitable-md .nb-md-diagram {
  display: flex; align-items: center; gap: 6px; margin: 0.5em 0; padding: 0.35em 0.6em;
  border: 1px dashed var(--editor-border, #cbd5e1); border-radius: 6px;
  background: var(--editor-code-bg, #f8fafc); color: var(--editor-text-secondary, #64748b); font-size: 0.92em;
}
.nb-bitable-md .nb-md-diagram-label { font-weight: 600; color: var(--editor-text, #1e293b); }
`;

/** 图表围栏语言 → 占位标签 */
const DIAGRAM_FENCE_LABELS: Record<string, string> = {
  mermaid: 'Mermaid 图表',
  plantuml: 'PlantUML 图表',
  puml: 'PlantUML 图表',
  infographic: 'Infographic 信息图',
};

/** GitHub 提示块首行标记，独占一行（与笔记本解析规则一致） */
const ALERT_MARKER_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;
/** 任务列表项标记 `[ ]` / `[x]` */
const TASK_MARKER_PATTERN = /^\[([ xX])\](?:[ \t]+|$)/;
/** 与笔记本一致的安全定界规则：避免误伤 `a == b`、`C++ and C++` 等普通文本 */
const HIGHLIGHT_PATTERN = /^==(?!\s)([^=]*?[^=\s])==(?!=)/;
const UNDERLINE_PATTERN = /^\+\+(?!\s)([\s\S]*?\S)\+\+(?!\+)/;

type InlineRule = Parameters<MarkdownIt['inline']['ruler']['push']>[1];
type BlockRule = Parameters<MarkdownIt['block']['ruler']['push']>[1];
type CoreRule = Parameters<MarkdownIt['core']['ruler']['push']>[1];

/** 成对定界的行内标记（==高亮==、++下划线++）：内部仍按行内 Markdown 解析 */
function delimitedInlineRule(pattern: RegExp, marker: number, tag: string): InlineRule {
  return (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== marker || state.src.charCodeAt(state.pos + 1) !== marker) return false;
    const match = pattern.exec(state.src.slice(state.pos, state.posMax));
    if (!match) return false;
    if (!silent) {
      const start = state.pos;
      const oldPosMax = state.posMax;
      state.push(`${tag}_open`, tag, 1);
      // 与链接文字相同的做法：限定解析范围后递归解析内部行内语法
      state.pos = start + 2;
      state.posMax = start + 2 + match[1].length;
      state.md.inline.tokenize(state);
      state.posMax = oldPosMax;
      state.push(`${tag}_close`, tag, -1);
      state.pos = start;
    }
    state.pos += match[0].length;
    return true;
  };
}

/** 行内公式 `$...$`：复用笔记本的匹配规则（金额、转义、跨行等边界一致） */
const inlineMathRule: InlineRule = (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x24 /* $ */) return false;
  // 前一个字符也是 $ 时属于块公式或金额写法，交给其他规则
  if (state.pos > 0 && state.src.charCodeAt(state.pos - 1) === 0x24) return false;
  const match = matchInlineMath(state.src.slice(state.pos, state.posMax));
  if (!match) return false;
  if (!silent) {
    const token = state.push('nb_math_inline', 'span', 0);
    token.content = match.latex;
  }
  state.pos += match.raw.length;
  return true;
};

/** 块级公式 `$$ ... $$`（支持单行与多行写法） */
const blockMathRule: BlockRule = (state, startLine, endLine, silent) => {
  // 缩进代码块优先
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const firstStart = state.bMarks[startLine] + state.tShift[startLine];
  const firstLine = state.src.slice(firstStart, state.eMarks[startLine]);
  if (!firstLine.startsWith('$$')) return false;

  const rest = firstLine.slice(2).trim();
  let latex: string;
  let lastLine = startLine;
  if (rest.length >= 2 && rest.endsWith('$$')) {
    latex = rest.slice(0, -2);
  } else {
    const lines = rest ? [rest] : [];
    let closed = false;
    for (let line = startLine + 1; line < endLine; line += 1) {
      const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      if (text.trimEnd().endsWith('$$')) {
        const head = text.trimEnd().slice(0, -2);
        if (head.trim()) lines.push(head);
        lastLine = line;
        closed = true;
        break;
      }
      lines.push(text);
    }
    // 未闭合按普通文本处理，避免吞掉后续整段内容
    if (!closed) return false;
    latex = lines.join('\n');
  }
  if (silent) return true;

  state.line = lastLine + 1;
  const token = state.push('nb_math_block', 'div', 0);
  token.block = true;
  token.content = latex.trim();
  token.map = [startLine, state.line];
  return true;
};

/** GitHub 提示块：引用首行为 `[!NOTE]` 等标记时改写为带标题的提示块（须在行内解析前执行） */
const alertCoreRule: CoreRule = (state) => {
  const tokens = state.tokens;
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index].type !== 'blockquote_open') continue;
    const paragraph = tokens[index + 1];
    const inline = tokens[index + 2];
    if (paragraph.type !== 'paragraph_open' || inline.type !== 'inline') continue;
    const match = ALERT_MARKER_PATTERN.exec(inline.content);
    if (!match) continue;

    const kind = match[1].toLowerCase() as AlertKind;
    tokens[index].attrJoin('class', `nb-md-alert nb-md-alert-${kind}`);
    inline.content = inline.content.slice(match[0].length);
    // 标记独占一段时隐藏这一空段落
    if (!inline.content.trim()) {
      paragraph.hidden = true;
      const close = tokens[index + 3];
      if (close?.type === 'paragraph_close') close.hidden = true;
    }
    const meta = ALERT_META[kind];
    const title = new state.Token('html_block', '', 0);
    title.content = `<p class="nb-md-alert-title">${meta.icon} ${meta.label}</p>\n`;
    tokens.splice(index + 1, 0, title);
  }
};

/** 任务列表：列表项以 `[ ]` / `[x]` 开头时标记为任务项（须在行内解析前执行） */
const taskListCoreRule: CoreRule = (state) => {
  const tokens = state.tokens;
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index].type !== 'list_item_open') continue;
    const inline = tokens[index + 2];
    if (tokens[index + 1].type !== 'paragraph_open' || inline.type !== 'inline') continue;
    const match = TASK_MARKER_PATTERN.exec(inline.content);
    if (!match) continue;

    inline.content = inline.content.slice(match[0].length);
    tokens[index].attrJoin('class', match[1] === ' ' ? 'nb-md-task' : 'nb-md-task nb-md-task-checked');
    // 向前找到所属列表并标记，用于去掉圆点
    const level = tokens[index].level - 1;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = tokens[cursor];
      if (candidate.level === level && candidate.type === 'bullet_list_open') {
        if (!candidate.attrGet('class')?.includes('nb-md-task-list')) candidate.attrJoin('class', 'nb-md-task-list');
        break;
      }
    }
  }
};

/** 注册笔记本扩展语法 */
function applyNoteBoardSyntax(md: MarkdownIt): void {
  md.inline.ruler.after('escape', 'nb_math_inline', inlineMathRule);
  md.inline.ruler.before('emphasis', 'nb_highlight', delimitedInlineRule(HIGHLIGHT_PATTERN, 0x3d /* = */, 'mark'));
  md.inline.ruler.before('emphasis', 'nb_underline', delimitedInlineRule(UNDERLINE_PATTERN, 0x2b /* + */, 'u'));
  md.block.ruler.before('fence', 'nb_math_block', blockMathRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.core.ruler.before('inline', 'nb_alert', alertCoreRule);
  md.core.ruler.before('inline', 'nb_task_list', taskListCoreRule);

  const escape = md.utils.escapeHtml;
  md.renderer.rules.nb_math_inline = (tokens, idx) =>
    `<span class="nb-md-math">${escape(tokens[idx].content)}</span>`;
  md.renderer.rules.nb_math_block = (tokens, idx) =>
    `<div class="nb-md-math">${escape(tokens[idx].content)}</div>\n`;

  // 图表围栏：以占位展示，其余围栏走默认渲染（含语法高亮）
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const lang = tokens[idx].info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const label = DIAGRAM_FENCE_LABELS[lang];
    if (label) {
      return `<div class="nb-md-diagram"><span class="nb-md-diagram-label">${label}</span><span>· 打开编辑查看</span></div>\n`;
    }
    return defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}

/** 懒创建共享解析器：多维表格可能同时渲染数百个单元格，实例必须复用 */
let parser: MarkdownIt | null = null;

function getParser(): MarkdownIt {
  if (parser) return parser;
  parser = new MarkdownIt({
    // 放行原始 HTML 以承载高亮块/分栏/折叠块等标准 HTML 写法；
    // 单元格内容可能来自粘贴的外部数据，输出统一经 sanitizeRenderedMarkdown 白名单净化杜绝脚本注入
    html: true,
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
  applyNoteBoardSyntax(parser);
  return parser;
}

/**
 * 把 Markdown 源码渲染为净化后的 HTML 字符串
 * 单独导出以便单元测试验证高亮与安全过滤，无需挂载 React 组件。
 * 任何解析异常都降级为空串：一个坏单元格不能炸掉整张表。
 * @param resolveSrc 图片地址解析（本地相对路径 → webview 可访问的地址），默认原样返回
 */
export function renderBitableMarkdown(source: string, resolveSrc?: (src: string) => string): string {
  if (!source) return '';
  try {
    return sanitizeRenderedMarkdown(getParser().render(source), resolveSrc);
  } catch {
    return '';
  }
}

/** KaTeX 懒加载：只有出现公式的单元格才拉取公式运行时 */
let katexLoading: Promise<typeof import('katex')> | null = null;
function loadKatex(): Promise<typeof import('katex')> {
  if (!katexLoading) {
    katexLoading = import('katex').catch((error) => {
      // 加载失败允许下次重试
      katexLoading = null;
      throw error;
    });
  }
  return katexLoading;
}

/** 公式渲染缓存：同一张表里重复出现的公式只排版一次 */
const katexCache = new Map<string, string>();
const KATEX_CACHE_LIMIT = 300;

function renderLatex(katex: typeof import('katex'), latex: string, displayMode: boolean): string {
  const key = `${displayMode ? 'block' : 'inline'}:${latex}`;
  const cached = katexCache.get(key);
  if (cached !== undefined) return cached;
  const html = katex.renderToString(latex, { displayMode, throwOnError: false, trust: false, strict: false });
  if (katexCache.size >= KATEX_CACHE_LIMIT) katexCache.clear();
  katexCache.set(key, html);
  return html;
}

/** 把容器内的公式占位替换为 KaTeX 排版结果；返回取消函数（容器重渲染前调用） */
function typesetMathPlaceholders(root: HTMLElement): () => void {
  const placeholders = Array.from(root.querySelectorAll<HTMLElement>('.nb-md-math:not(.is-rendered)'));
  if (placeholders.length === 0) return () => {};
  let cancelled = false;
  loadKatex()
    .then((katex) => {
      if (cancelled) return;
      for (const element of placeholders) {
        if (!element.isConnected) continue;
        try {
          element.innerHTML = renderLatex(katex, element.textContent ?? '', element.tagName === 'DIV');
          element.classList.add('is-rendered');
        } catch {
          // 单个公式异常保留源码展示
        }
      }
    })
    .catch(() => {
      // KaTeX 加载失败时保持源码展示
    });
  return () => {
    cancelled = true;
  };
}

/**
 * 在原生 DOM 容器中渲染只读 Markdown（双链嵌入等不经 React 的场景），样式与公式排版同单元格渲染。
 * @returns 取消函数：再次渲染或销毁前调用，丢弃尚未完成的公式排版
 */
export function renderReadonlyMarkdownInto(
  container: HTMLElement,
  source: string,
  resolveSrc?: (src: string) => string,
): () => void {
  ensureStyleInjected();
  container.classList.add('nb-bitable-md');
  container.innerHTML = renderBitableMarkdown(source, resolveSrc);
  return typesetMathPlaceholders(container);
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
  const containerRef = useRef<HTMLDivElement>(null);

  // 解析结果按源码缓存：滚动或选区变化时不重复解析；本地图片按所在文档目录解析
  const html = useMemo(() => renderBitableMarkdown(source, resolveDocumentImageSrc), [source]);
  // React 19 按对象引用比较 dangerouslySetInnerHTML：引用不稳定时每次重渲染都会重设 innerHTML，
  // 冲掉已排版的公式（看板卡片等频繁重渲染处尤为明显），因此随 html 缓存
  const innerHtml = useMemo(() => ({ __html: html }), [html]);

  // 公式占位在挂载后替换为 KaTeX 排版结果（React 只在 html 变化时重设 innerHTML，替换结果不会被覆盖）
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    return typesetMathPlaceholders(root);
  }, [html]);

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
      ref={containerRef}
      className={`nb-bitable-md${density === 'compact' ? ' compact' : ''}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={innerHtml}
    />
  );
}
