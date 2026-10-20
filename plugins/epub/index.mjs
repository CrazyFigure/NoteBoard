// EPUB 阅读：章节在独立 Shadow DOM 中渲染并经 DOMPurify 净化，不执行脚本、不请求远程资源。
import DOMPurify from 'dompurify';
import { createView, el, iconButton, zoomControl, pager, separator, copyText } from '../shared/view.mjs';
import { openBook, resolvePath } from './book.mjs';

const MIME = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', css:'text/css', ttf:'font/ttf', otf:'font/otf', woff:'font/woff', woff2:'font/woff2' };
const MAX_CHAPTER = 8 * 1024 * 1024;

/** 书籍样式里的 html/body 选择器改指向正文容器，否则在 Shadow DOM 中不会生效。 */
export function scopeBookCss(text) {
  return text.replace(/(^|[\s,{}>+~(])(html|body)(?=[\s,{.#:[>+~)]|$)/gi, '$1.np-epub-body');
}

export async function mount({ container, name, bytes, signal, notify }) {
  const book = await openBook(bytes);
  if (signal.aborted) return;
  const view = createView(container, book.title || name);
  const urls = new Map();
  let chapter = -1, scale = 1, saveTimer = 0, generation = 0, destroyed = false;
  const storageKey = `nb-epub-progress:${name}:${bytes.byteLength}`;

  view.style.textContent += `
    .np-epub{display:flex;flex:1;min-height:0;position:relative}
    .np-toc{width:260px;flex-shrink:0;overflow:auto;padding:14px 10px 24px;border-right:1px solid var(--editor-border);background:var(--editor-surface)}
    .np-toc[hidden]{display:none}
    .np-toc h2{font-size:12px;font-weight:500;color:var(--editor-text-muted);margin:2px 8px 10px;letter-spacing:.04em}
    .np-toc-item{display:block;width:100%;height:auto;min-height:30px;padding:6px 8px;border:0;border-radius:6px;background:transparent;text-align:left;white-space:normal;line-height:1.45;color:var(--editor-text)}
    .np-toc-item:hover{background:var(--toolbar-hover)}.np-toc-item:active{background:var(--toolbar-active)}
    .np-toc-item[aria-current=true]{color:var(--editor-accent);background:color-mix(in srgb,var(--editor-accent) 10%,transparent);font-weight:500}
    .np-book-meta{margin:0 8px 14px;padding-bottom:12px;border-bottom:1px solid var(--editor-border)}.np-book-meta strong{display:block;font-size:14px;line-height:1.5}.np-book-meta span{font-size:12px;color:var(--editor-text-muted)}
    .np-scroll{background:var(--editor-bg)}
    .np-epub-error{padding:48px 24px;text-align:center;color:var(--editor-text-muted)}
    .np-chapter-nav{display:flex;justify-content:space-between;gap:12px;max-width:46em;margin:0 auto;padding:0 48px 56px}
    .np-chapter-nav button{height:36px;padding:0 16px;max-width:48%}.np-chapter-nav button>span{overflow:hidden;text-overflow:ellipsis}
    @media(max-width:760px){.np-toc{position:absolute;z-index:5;top:0;bottom:0;left:0;width:min(82%,300px);box-shadow:var(--shadow-lg)}.np-chapter-nav{padding:0 16px 40px}}
  `;
  const layout = el('div', 'np-epub'), toc = el('nav', 'np-toc'), page = el('div', 'np-epub-page');
  toc.setAttribute('aria-label', '目录');
  const footer = el('div', 'np-chapter-nav');
  view.viewport.append(page, footer);
  layout.append(toc, view.viewport.parentElement.removeChild(view.viewport));
  view.root.querySelector('.np-layout').append(layout);
  // 正文使用嵌套 Shadow DOM，书籍自带样式不会影响工具栏与目录。
  const shadow = page.attachShadow({ mode:'open' });

  /** 压缩包内资源转为 Blob URL 并缓存；被加密的资源不加载。 */
  async function asset(path) {
    if (book.encrypted.has(path) || !book.zip.file(path)) return '';
    if (!urls.has(path)) {
      const type = book.types.get(path) || MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
      urls.set(path, book.read(path, 'uint8array').then((data) => URL.createObjectURL(new Blob([data], { type }))));
    }
    return urls.get(path);
  }
  /** 处理书籍 CSS：内联 @import（最多三层），本地 url() 换成 Blob，远程地址一律移除。 */
  async function css(text, base, depth = 0) {
    const imports = [...text.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?[^;]*;/gi)];
    for (const match of imports) {
      const target = /^[a-z][a-z0-9+.-]*:/i.test(match[1]) || depth >= 3 ? '' : await book.read(resolvePath(base, match[1])).then((value) => css(value, resolvePath(base, match[1]), depth + 1)).catch(() => '');
      text = text.replace(match[0], target);
    }
    const refs = [...new Set([...text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]))];
    for (const ref of refs) {
      const url = /^(data|blob):/i.test(ref) ? ref : /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') ? '' : await asset(resolvePath(base, ref));
      text = text.split(ref).join(url || 'about:invalid');
    }
    return scopeBookCss(text);
  }

  /** 把章节里的资源与链接改写为可控地址，再交给 DOMPurify 净化。 */
  async function chapterContent(path) {
    const raw = await book.read(path);
    if (raw.length > MAX_CHAPTER) throw new Error('本章节过大，无法显示');
    let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(raw, 'text/html');
    let styles = '';
    for (const node of doc.querySelectorAll('link[rel~="stylesheet"][href], style')) {
      if (node.localName === 'style') styles += await css(node.textContent ?? '', path);
      else { const target = resolvePath(path, node.getAttribute('href')); styles += await book.read(target).then((text) => css(text, target)).catch(() => ''); }
    }
    const body = doc.body ?? doc.getElementsByTagName('body')[0] ?? doc.documentElement;
    for (const node of body.querySelectorAll('[src],[href],[poster],[srcset]')) {
      node.removeAttribute('srcset'); node.removeAttribute('poster');
      if (node.localName === 'a') {
        const href = node.getAttribute('href') ?? '';
        if (href.startsWith('#')) node.setAttribute('href', `#nb-frag:${href.slice(1)}`);
        else if (/^(https?|mailto):/i.test(href)) continue;
        else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) node.removeAttribute('href');
        else node.setAttribute('href', `#nb-epub:${encodeURIComponent(resolvePath(path, href))}|${href.split('#')[1] ?? ''}`);
        continue;
      }
      for (const attr of ['src', 'href']) {
        const value = node.getAttribute(attr); if (value == null) continue;
        const next = /^(data:|#)/i.test(value) ? value : /^[a-z][a-z0-9+.-]*:/i.test(value) ? '' : await asset(resolvePath(path, value));
        // 远程或缺失资源直接去掉地址，图片只显示替代文字，不留空请求。
        if (next) node.setAttribute(attr, next); else node.removeAttribute(attr);
      }
    }
    for (const node of body.querySelectorAll('image')) {
      const value = node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? node.getAttribute('xlink:href');
      if (value != null) { node.removeAttributeNS('http://www.w3.org/1999/xlink', 'href'); node.setAttribute('href', /^[a-z][a-z0-9+.-]*:/i.test(value) ? '' : await asset(resolvePath(path, value))); }
    }
    const fragment = DOMPurify.sanitize(body.innerHTML, {
      RETURN_DOM_FRAGMENT:true,
      FORBID_TAGS:['style', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'frame', 'object', 'embed', 'audio', 'video', 'source', 'track'],
      ALLOWED_URI_REGEXP:/^(?:blob:|https?:|mailto:|#)/i,
    });
    // 只有链接可以保留远程地址（点击时复制而不是打开）；其它元素的远程资源与样式内远程 url 全部清除。
    for (const node of fragment.querySelectorAll('[src],[href],[style]')) {
      if (node.localName !== 'a') for (const attr of ['src', 'href']) if (/^(https?|mailto):/i.test(node.getAttribute(attr) ?? '')) node.removeAttribute(attr);
      const style = node.getAttribute('style');
      if (style && /url\(/i.test(style)) node.setAttribute('style', style.replace(/url\([^)]*\)/gi, 'none'));
    }
    return { styles, fragment, className:(body.getAttribute('class') ?? '').replace(/[^\w\s-]/g, '') };
  }

  const baseCss = `
    :host{display:block}
    .np-epub-body{box-sizing:border-box;max-width:46em;margin:0 auto;padding:44px 48px 40px;font-family:var(--content-font-family,var(--ui-font-family));font-size:calc(17px * var(--np-epub-scale,1))!important;line-height:1.85;overflow-wrap:break-word;user-select:text}
    .np-epub-body img,.np-epub-body svg,.np-epub-body video{max-width:100%;height:auto}
    .np-epub-body table{max-width:100%;border-collapse:collapse}
    .np-epub-body pre{white-space:pre-wrap}
    @media(max-width:760px){.np-epub-body{padding:24px 18px 28px}}`;
  // 阅读配色始终跟随应用主题：书籍自定义的文字与背景色在深色模式下常常不可读。
  const themeCss = `
    .np-epub-body,.np-epub-body *{color:var(--editor-text)!important;background-color:transparent!important;border-color:var(--editor-border)!important}
    .np-epub-body a[href]{color:var(--editor-accent)!important;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
    .np-epub-body ::selection{background:color-mix(in srgb,var(--editor-accent) 32%,transparent)}`;

  const tocItems = [];
  function renderToc() {
    const meta = el('div', 'np-book-meta'); meta.append(el('strong', '', book.title || name)); if (book.creator) meta.append(el('span', '', book.creator));
    toc.replaceChildren(meta, el('h2', '', '目录'));
    const walk = (items, depth) => { for (const item of items) {
      const b = el('button', 'np-toc-item', item.label || '（无标题）'); b.type = 'button'; b.style.paddingLeft = `${8 + depth * 14}px`;
      b.addEventListener('click', () => { open(book.spine.findIndex((s) => s.path === item.path), { fragment:item.fragment }); if (innerWidth <= 760) toc.hidden = true; });
      tocItems.push({ button:b, path:item.path }); toc.append(b); walk(item.children, depth + 1);
    } };
    walk(book.toc, 0);
  }
  function markToc() {
    const path = book.spine[chapter]?.path;
    let current = null;
    for (const item of tocItems) { const match = item.path === path && !current; if (match) current = item; item.button.setAttribute('aria-current', String(match)); }
    current?.button.scrollIntoView({ block:'nearest' });
  }

  /** 打开指定章节；fragment 定位到锚点，ratio 恢复上次阅读的位置。 */
  async function open(index, { fragment = '', ratio = 0 } = {}) {
    if (index < 0 || index >= book.spine.length) return;
    const token = ++generation;
    try {
      const content = await chapterContent(book.spine[index].path);
      if (token !== generation || destroyed) return;
      const style = el('style'); style.textContent = baseCss + content.styles + themeCss;
      const article = el('article', `np-epub-body ${content.className}`.trim()); article.append(content.fragment);
      shadow.replaceChildren(style, article);
    } catch (error) {
      if (token !== generation || destroyed) return;
      shadow.replaceChildren(el('div', 'np-epub-error', `本章无法显示：${error.message}`));
    }
    chapter = index; pageControl.set(index + 1, book.spine.length); markToc(); renderFooter();
    // 插入后布局是同步的，直接定位；不等待动画帧，后台标签页节流时也能准确跳转。
    const anchor = fragment && (shadow.getElementById(fragment) ?? shadow.querySelector(`[name="${CSS.escape(fragment)}"]`));
    if (anchor) anchor.scrollIntoView({ block:'start' });
    else view.viewport.scrollTop = ratio * Math.max(0, view.viewport.scrollHeight - view.viewport.clientHeight);
    save();
  }
  function renderFooter() {
    footer.replaceChildren();
    const label = (index) => book.toc.find((item) => item.path === book.spine[index]?.path)?.label;
    if (chapter > 0) { const b = el('button'); b.type = 'button'; b.append(el('span', '', `上一章${label(chapter - 1) ? ` · ${label(chapter - 1)}` : ''}`)); b.addEventListener('click', () => open(chapter - 1, { ratio:1 })); footer.append(b); } else footer.append(el('span'));
    if (chapter < book.spine.length - 1) { const b = el('button'); b.type = 'button'; b.append(el('span', '', `下一章${label(chapter + 1) ? ` · ${label(chapter + 1)}` : ''}`)); b.addEventListener('click', () => open(chapter + 1)); footer.append(b); }
  }
  /** 阅读进度按文件名与大小记在本机，存储不可用时静默跳过。 */
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const max = view.viewport.scrollHeight - view.viewport.clientHeight;
      try { localStorage.setItem(storageKey, JSON.stringify({ chapter, ratio:max > 0 ? view.viewport.scrollTop / max : 0, scale })); } catch { /* 隐私模式等场景无法保存进度 */ }
    }, 300);
  }

  const pageControl = pager({ vertical:false, go:(n) => open(n - 1) });
  const zoomer = zoomControl({ min:.7, max:2, step:.1, target:view.viewport, get:() => scale, set:(next) => {
    // 字号变化会改变总高度，按比例保持当前阅读位置。
    const max = view.viewport.scrollHeight - view.viewport.clientHeight, ratio = max > 0 ? view.viewport.scrollTop / max : 0;
    scale = Math.round(next * 100) / 100; page.style.setProperty('--np-epub-scale', String(scale));
    view.viewport.scrollTop = ratio * Math.max(0, view.viewport.scrollHeight - view.viewport.clientHeight); save();
  } });
  const tocButton = iconButton('list', '目录', () => { toc.hidden = !toc.hidden; tocButton.setAttribute('aria-pressed', String(!toc.hidden)); });
  tocButton.setAttribute('aria-pressed', 'true');
  view.toolbar.prepend(tocButton);
  view.toolbar.append(pageControl.element, separator(), zoomer.element);
  if (innerWidth <= 760) { toc.hidden = true; tocButton.setAttribute('aria-pressed', 'false'); }

  // 书内链接跳转章节或锚点；外部链接只复制地址，不直接打开。
  shadow.addEventListener('click', (event) => {
    const link = event.composedPath().find((node) => node instanceof Element && node.localName === 'a');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#nb-frag:')) { const target = shadow.getElementById(href.slice(9)); target?.scrollIntoView({ block:'start' }); }
    else if (href.startsWith('#nb-epub:')) { const [path, fragment] = href.slice(9).split('|'); open(book.spine.findIndex((item) => item.path === decodeURIComponent(path)), { fragment }); }
    else if (/^(https?|mailto):/i.test(href)) void copyText(href.replace(/^mailto:/i, ''), notify);
  });
  view.root.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); open(chapter + (event.key === 'ArrowLeft' ? -1 : 1), { ratio:event.key === 'ArrowLeft' ? 1 : 0 }); }
  });
  view.viewport.tabIndex = 0;
  view.viewport.addEventListener('scroll', save, { passive:true });

  renderToc();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); } catch { /* 读取失败从头开始 */ }
  if (saved?.scale) { scale = Math.min(2, Math.max(.7, Number(saved.scale) || 1)); page.style.setProperty('--np-epub-scale', String(scale)); zoomer.update(); }
  await open(Math.min(book.spine.length - 1, Math.max(0, Number(saved?.chapter) || 0)), { ratio:Number(saved?.ratio) || 0 });
  return () => {
    destroyed = true; generation++; clearTimeout(saveTimer); view.destroy();
    for (const pending of urls.values()) void pending.then((url) => URL.revokeObjectURL(url));
  };
}
