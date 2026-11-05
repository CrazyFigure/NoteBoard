// NoteBoard 双链嵌入渲染（`![[...]]`）
// 1. 图片：直接显示，`|300` / `|300x200` 指定显示宽高（与 Obsidian 一致）；
// 2. Markdown 笔记：卡片内只读渲染整篇或 `#标题` 小节，点击卡片标题打开原笔记；
//    拖动卡片底边调整高度，写回为 `![[笔记|400]]`（与图片的 `|宽度` 同一位置），双击底边恢复自动高度；
// 3. 其它文件或目标未找到：退化为普通双链样式的提示卡片。
// 内容进入可视区附近才读取与渲染，避免长文档一次读取大量被嵌入文件。

import { pathKey } from '../explorer/pathUtils';
import type { NoteEntry } from '../wikilink/noteIndex';
import { readNoteText, type WikiLinkResolution } from '../wikilink/wikiLinkNavigation';
import { EMBED_IMAGE_EXTENSIONS, extractHeadingSection, parseWikiLinkInner, stripFrontMatter, wikiLinkLabel } from '../wikilink/wikiLinkSyntax';
import { observe } from './viewportActivation';

/** 嵌入内容的长度上限：超出部分截断，避免把巨型笔记整个塞进当前文档 */
const EMBED_MAX_LENGTH = 60000;

/** 笔记嵌入可拖动调整的高度范围（像素） */
export const EMBED_MIN_HEIGHT = 80;
export const EMBED_MAX_HEIGHT = 2000;
/** 节点视图把 `|高度` 写入该 CSS 变量，笔记卡片正文据此定高 */
export const EMBED_HEIGHT_VAR = '--nb-wikiembed-height';

/** 嵌入渲染的上下文 */
export interface WikiEmbedContext {
  inner: string;
  resolution: WikiLinkResolution;
  /** 打开被嵌入的笔记 */
  onOpen: () => void;
  /** 拖动卡片底边结束：写回高度；null 表示恢复自动高度 */
  onResize: (height: number | null) => void;
  /** 显示调整高度的提示（原生 DOM 节点没有 React Tooltip） */
  onHint: (target: HTMLElement | null, text?: string) => void;
}

/**
 * 笔记卡片底边的高度拖柄：拖动时实时改 CSS 变量，松手后通过 onResize 写回 `|高度`；双击恢复自动高度。
 * 只读状态（沉浸阅读等）由样式隐藏。
 */
function createResizeHandle(container: HTMLElement, body: HTMLElement, context: WikiEmbedContext): HTMLElement {
  const handle = element('span', 'nb-wikiembed-resize');
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.setAttribute('aria-label', '调整嵌入高度');
  handle.appendChild(element('span', 'nb-wikiembed-resize-grip'));

  let startY = 0;
  let startHeight = 0;
  let current: number | null = null;

  const onMove = (event: PointerEvent) => {
    const next = Math.round(Math.min(EMBED_MAX_HEIGHT, Math.max(EMBED_MIN_HEIGHT, startHeight + event.clientY - startY)));
    current = next;
    container.style.setProperty(EMBED_HEIGHT_VAR, `${next}px`);
  };
  const onUp = (event: PointerEvent) => {
    handle.releasePointerCapture?.(event.pointerId);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    handle.classList.remove('is-dragging');
    if (current !== null) context.onResize(current);
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    context.onHint(null);
    startY = event.clientY;
    startHeight = body.getBoundingClientRect().height;
    current = null;
    handle.classList.add('is-dragging');
    handle.setPointerCapture?.(event.pointerId);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
  // 不让 ProseMirror 把拖柄上的按下当作选中节点
  handle.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  handle.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    container.style.removeProperty(EMBED_HEIGHT_VAR);
    context.onResize(null);
  });
  handle.addEventListener('mouseenter', () => context.onHint(handle, '拖动调整高度 · 双击恢复自动'));
  handle.addEventListener('mouseleave', () => context.onHint(null));
  return handle;
}

/** `300` / `300x200` 形式的尺寸 */
function parseSize(alias: string): { width?: string; height?: string } {
  const match = /^(\d{1,5})(?:x(\d{1,5}))?$/.exec(alias.trim());
  if (!match) return {};
  return { width: `${match[1]}px`, height: match[2] ? `${match[2]}px` : undefined };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 图片嵌入 */
function renderImage(container: HTMLElement, entry: NoteEntry, alias: string): () => void {
  const image = element('img', 'nb-wikiembed-image');
  image.alt = entry.name;
  image.draggable = false;
  image.referrerPolicy = 'no-referrer';
  const { width, height } = parseSize(alias);
  if (width) image.style.width = width;
  if (height) image.style.height = height;
  container.appendChild(image);
  let disposed = false;
  void import('./rawHtmlBlockView').then(({ resolveLocalSrc }) => {
    if (!disposed) image.src = resolveLocalSrc(entry.path, entry.dir);
  });
  return () => {
    disposed = true;
  };
}

/** 笔记嵌入：标题栏 + 只读正文，进入视口附近才加载 */
function renderNote(container: HTMLElement, entry: NoteEntry, heading: string, context: WikiEmbedContext): () => void {
  const header = element('button', 'nb-wikiembed-header');
  header.type = 'button';
  header.appendChild(element('span', 'nb-wikiembed-title', heading ? `${entry.stem} › ${heading}` : entry.stem));
  header.appendChild(element('span', 'nb-wikiembed-open', '打开'));
  // 不让 ProseMirror 把点击当作选中节点
  header.addEventListener('mousedown', (event) => event.preventDefault());
  header.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    context.onOpen();
  });
  const body = element('div', 'nb-wikiembed-body');
  body.appendChild(element('span', 'nb-wikiembed-hint', '正在加载…'));
  container.append(header, body, createResizeHandle(container, body, context));

  let disposed = false;
  let cancelTypeset: (() => void) | null = null;
  const stopObserving = observe(body, () => {
    void (async () => {
      try {
        const [content, { renderReadonlyMarkdownInto }, { resolveLocalSrc }] = await Promise.all([
          readNoteText(entry),
          import('../bitable/BitableMarkdown'),
          import('./rawHtmlBlockView'),
        ]);
        if (disposed) return;
        let source = stripFrontMatter(content);
        if (heading) {
          const section = extractHeadingSection(source, heading);
          if (section === null) {
            body.replaceChildren(element('span', 'nb-wikiembed-hint', `「${entry.stem}」中没有标题「${heading}」`));
            return;
          }
          source = section;
        }
        if (!source.trim()) {
          body.replaceChildren(element('span', 'nb-wikiembed-hint', '空笔记'));
          return;
        }
        const truncated = source.length > EMBED_MAX_LENGTH;
        // 被嵌入笔记中的相对图片按它自己的目录解析
        cancelTypeset = renderReadonlyMarkdownInto(
          body,
          truncated ? source.slice(0, EMBED_MAX_LENGTH) : source,
          (src) => resolveLocalSrc(src, entry.dir),
        );
        if (truncated) body.appendChild(element('div', 'nb-wikiembed-hint', '内容较长，已截断，打开原笔记查看全部'));
      } catch {
        if (!disposed) body.replaceChildren(element('span', 'nb-wikiembed-hint', `无法读取「${entry.name}」`));
      }
    })();
  }, { once: true });

  return () => {
    disposed = true;
    stopObserving();
    cancelTypeset?.();
  };
}

/**
 * 在容器中渲染嵌入内容，返回清理函数。
 * 容器由节点视图持有；解析结果变化时节点视图清空容器后重新调用。
 */
export function renderWikiEmbed(container: HTMLElement, context: WikiEmbedContext): () => void {
  const parts = parseWikiLinkInner(context.inner);
  const { resolution } = context;
  container.replaceChildren();

  if (resolution.status === 'resolved') {
    const { entry } = resolution;
    if (EMBED_IMAGE_EXTENSIONS.has(entry.ext)) {
      container.dataset.embedKind = 'image';
      return renderImage(container, entry, parts.alias);
    }
    if (entry.isMarkdown) {
      container.dataset.embedKind = 'note';
      return renderNote(container, entry, parts.heading, context);
    }
  }

  // 未找到、仍在解析或不支持嵌入的文件：显示为提示卡片（嵌入的 `|` 部分是尺寸，不作为名称）
  container.dataset.embedKind = 'placeholder';
  const label = wikiLinkLabel({ ...parts, alias: '' }) || context.inner;
  const text = resolution.status === 'missing'
    ? `未找到「${label}」，可能尚未同步`
    : resolution.status === 'pending'
      ? `正在查找「${label}」…`
      : `「${label}」不支持嵌入预览，点击打开`;
  const hint = element('button', 'nb-wikiembed-header', text);
  hint.type = 'button';
  hint.addEventListener('mousedown', (event) => event.preventDefault());
  hint.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    context.onOpen();
  });
  container.appendChild(hint);
  return () => {};
}

/** 笔记嵌入 `|高度` 中的高度（像素）；不是纯数字时返回 null（自动高度） */
export function embedHeightOf(inner: string): number | null {
  const match = /^\d{1,4}$/.exec(parseWikiLinkInner(inner).alias);
  if (!match) return null;
  return Math.min(EMBED_MAX_HEIGHT, Math.max(EMBED_MIN_HEIGHT, Number(match[0])));
}

/** 解析结果的身份：路径、修改时间与状态都不变时无需重新渲染嵌入内容 */
export function embedIdentity(resolution: WikiLinkResolution): string {
  if (resolution.status !== 'resolved') return resolution.status;
  return `${pathKey(resolution.entry.path)}:${resolution.entry.mtime}:${resolution.entry.size}`;
}
