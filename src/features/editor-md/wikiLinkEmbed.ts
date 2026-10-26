// NoteBoard 双链嵌入渲染（`![[...]]`）
// 1. 图片：直接显示，`|300` / `|300x200` 指定显示宽高（与 Obsidian 一致）；
// 2. Markdown 笔记：卡片内只读渲染整篇或 `#标题` 小节，点击卡片标题打开原笔记；
// 3. 其它文件或目标未找到：退化为普通双链样式的提示卡片。
// 内容进入可视区附近才读取与渲染，避免长文档一次读取大量被嵌入文件。

import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { pathKey } from '../explorer/pathUtils';
import type { NoteEntry } from '../wikilink/noteIndex';
import type { WikiLinkResolution } from '../wikilink/wikiLinkNavigation';
import { extractHeadingSection, parseWikiLinkInner, stripFrontMatter, wikiLinkLabel } from '../wikilink/wikiLinkSyntax';
import { observe } from './viewportActivation';

/** 可直接显示的图片扩展名 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'svg', 'bmp', 'avif', 'apng', 'ico']);
/** 嵌入内容的长度上限：超出部分截断，避免把巨型笔记整个塞进当前文档 */
const EMBED_MAX_LENGTH = 60000;

/** 嵌入渲染的上下文 */
export interface WikiEmbedContext {
  inner: string;
  resolution: WikiLinkResolution;
  /** 打开被嵌入的笔记 */
  onOpen: () => void;
}

/** 读取被嵌入笔记的正文：已打开的文档用内存中的最新内容 */
async function readNoteContent(entry: NoteEntry): Promise<string> {
  const key = pathKey(entry.path);
  for (const doc of useDocumentStore.getState().documents.values()) {
    if (pathKey(doc.key) === key && typeof doc.content === 'string') return doc.content;
  }
  const payload = await ipc.readDocument(entry.path);
  return payload.content ?? '';
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
  container.append(header, body);

  let disposed = false;
  let cancelTypeset: (() => void) | null = null;
  const stopObserving = observe(body, () => {
    void (async () => {
      try {
        const [content, { renderReadonlyMarkdownInto }, { resolveLocalSrc }] = await Promise.all([
          readNoteContent(entry),
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
    if (IMAGE_EXTENSIONS.has(entry.ext)) {
      container.dataset.embedKind = 'image';
      return renderImage(container, entry, parts.alias);
    }
    if (entry.isMarkdown) {
      container.dataset.embedKind = 'note';
      return renderNote(container, entry, parts.heading, context);
    }
  }

  // 未找到、仍在解析或不支持嵌入的文件：显示为提示卡片
  container.dataset.embedKind = 'placeholder';
  const label = wikiLinkLabel(parts) || context.inner;
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

/** 解析结果的身份：路径、修改时间与状态都不变时无需重新渲染嵌入内容 */
export function embedIdentity(resolution: WikiLinkResolution): string {
  if (resolution.status !== 'resolved') return resolution.status;
  return `${pathKey(resolution.entry.path)}:${resolution.entry.mtime}:${resolution.entry.size}`;
}
