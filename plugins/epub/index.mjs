// EPUB 阅读：章节在独立 Shadow DOM 中渲染并经 DOMPurify 净化，不执行脚本、不请求远程资源。
import DOMPurify from 'dompurify';
import { createView, el, iconButton, zoomControl, pager, separator, copyText, tip } from '../shared/view.mjs';
import { openBook, resolvePath, findAnchor, chapterFragment, decodeFragment } from './book.mjs';

const MIME = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', css:'text/css', ttf:'font/ttf', otf:'font/otf', woff:'font/woff', woff2:'font/woff2' };
const MAX_CHAPTER = 8 * 1024 * 1024;

/** 书籍样式里的 html/body 选择器改指向正文容器，否则在 Shadow DOM 中不会生效。 */
export function scopeBookCss(text) {
  return text.replace(/(^|[\s,{}>+~(])(html|body)(?=[\s,{.#:[>+~)]|$)/gi, '$1.np-epub-body');
}

export async function mount({ container, name, bytes, signal, notify, reading }) {
  const book = await openBook(bytes);
  if (signal.aborted) return;
  const view = createView(container, book.title || name, reading);
  const urls = new Map();
  let chapter = -1, scale = 1, saveTimer = 0, generation = 0, destroyed = false;
  // 目录宽度只影响当前阅读器，随阅读进度保存；未调整时保留原有桌面和窄屏默认尺寸。
  let tocWidth = null, resizing = null;
  const storageKey = `nb-epub-progress:${name}:${bytes.byteLength}`;

  view.style.textContent += `
    .np-epub{display:flex;flex:1;min-height:0;position:relative}
    .np-toc{width:var(--np-toc-width,260px);flex-shrink:0;overflow:auto;padding:14px 10px 24px;border-right:1px solid var(--editor-border);background:var(--editor-surface)}
    .np-toc[hidden]{display:none}
    .np-toc-resizer{position:relative;z-index:6;flex:0 0 6px;margin:0 -3px;cursor:col-resize;touch-action:none;user-select:none}
    .np-toc-resizer:hover{background:color-mix(in srgb,var(--editor-accent) 25%,transparent)}.np-toc-resizer:active,.np-toc-resizer[data-resizing]{background:var(--editor-accent)}
    .np-toc-resizer:focus-visible{outline:2px solid var(--editor-accent);outline-offset:-2px}.np-toc[hidden]+.np-toc-resizer{display:none}
    .np-toc h2{font-size:12px;font-weight:500;color:var(--editor-text-muted);margin:2px 8px 10px;letter-spacing:.04em}
    .np-toc-item{display:block;width:100%;height:auto;min-height:30px;padding:6px 8px;border:0;border-radius:6px;background:transparent;text-align:left;white-space:normal;line-height:1.45;color:var(--editor-text)}
    .np-toc-item:hover{background:var(--toolbar-hover)}.np-toc-item:active{background:var(--toolbar-active)}
    .np-toc-item[aria-current=true]{color:var(--editor-accent);background:color-mix(in srgb,var(--editor-accent) 10%,transparent);font-weight:500}
    .np-book-meta{margin:0 8px 14px;padding-bottom:12px;border-bottom:1px solid var(--editor-border)}.np-book-meta strong{display:block;font-size:14px;line-height:1.5}.np-book-meta span{font-size:12px;color:var(--editor-text-muted)}
    .np-scroll{background:var(--editor-bg);min-width:0}
    .np-epub-error{padding:48px 24px;text-align:center;color:var(--editor-text-muted)}
    .np-chapter-nav{display:flex;justify-content:space-between;gap:12px;max-width:46em;margin:0 auto;padding:0 48px 56px}
    .np-chapter-nav button{height:36px;padding:0 16px;max-width:48%}.np-chapter-nav button>span{overflow:hidden;text-overflow:ellipsis}
    @media(max-width:760px){.np-toc{position:absolute;z-index:5;top:0;bottom:0;left:0;width:min(82%,var(--np-toc-width,300px));box-shadow:var(--shadow-lg)}.np-toc-resizer{position:absolute;top:0;bottom:0;left:min(82%,var(--np-toc-width,300px));width:6px;margin:0;transform:translateX(-50%)}.np-chapter-nav{padding:0 16px 40px}}
  `;
  const layout = el('div', 'np-epub'), toc = el('nav', 'np-toc'), page = el('div', 'np-epub-page'), resizer = el('div', 'np-toc-resizer');
  toc.setAttribute('aria-label', '目录');
  resizer.tabIndex = 0; resizer.setAttribute('role', 'separator'); resizer.setAttribute('aria-orientation', 'vertical'); resizer.setAttribute('aria-label', '调整目录宽度');
  tip(resizer, '拖动调整目录宽度');
  const footer = el('div', 'np-chapter-nav');
  view.viewport.append(page, footer);
  layout.append(toc, resizer, view.viewport.parentElement.removeChild(view.viewport));
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
  async function chapterContent(section, targetFragment = '') {
    const { path } = section;
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
    // 脚注等书内链接未必列入目录，按目标锚点在原文中的位置找到所属章节后再截取。
    const target = findAnchor(body, targetFragment);
    if (target) {
      let closest = null;
      for (const candidate of book.chapters) {
        if (candidate.path !== path) continue;
        const start = findAnchor(body, candidate.fragment);
        if (start && (start === target || (start.compareDocumentPosition(target) & 4)) && (!closest || (closest.compareDocumentPosition(start) & 4))) {
          section = candidate; closest = start;
        }
      }
    }
    // 一个正文文件可包含整本书，只渲染当前目录锚点到下一锚点之间的内容。
    body.replaceChildren(chapterFragment(body, section));
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
    return { styles, fragment, index:book.chapters.indexOf(section), className:(body.getAttribute('class') ?? '').replace(/[^\w\s-]/g, '') };
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
      const index = chapterIndex(item.path, item.fragment);
      b.addEventListener('click', () => { open(index); if (innerWidth <= 760) { toc.hidden = true; tocButton.setAttribute('aria-pressed', 'false'); } });
      tocItems.push({ button:b, index }); toc.append(b); walk(item.children, depth + 1);
    } };
    walk(book.toc, 0);
  }
  /** 文件路径与锚点共同决定章节，同文件的其它章节不能误认成第一章。 */
  function chapterIndex(path, fragment = '') {
    const target = decodeFragment(fragment);
    const exact = book.chapters.findIndex((item) => item.path === path && item.fragment === target);
    return exact >= 0 ? exact : book.chapters.findIndex((item) => item.path === path);
  }
  function markToc() {
    let current = null;
    for (const item of tocItems) { const match = item.index === chapter && !current; if (match) current = item; item.button.setAttribute('aria-current', String(match)); }
    current?.button.scrollIntoView({ block:'nearest' });
  }

  /** 共用正文替换流程，旧版进度迁移与正常开章采用相同的净化结果和主题样式。 */
  function displayContent(content) {
    const style = el('style'); style.textContent = baseCss + content.styles + themeCss;
    const article = el('article', `np-epub-body ${content.className}`.trim()); article.append(content.fragment);
    shadow.replaceChildren(style, article);
  }

  /** 打开指定章节；fragment 定位到锚点，ratio 恢复上次阅读的位置。 */
  async function open(index, { fragment = '', ratio = 0 } = {}) {
    if (index < 0 || index >= book.chapters.length) return;
    const token = ++generation;
    try {
      const content = await chapterContent(book.chapters[index], fragment);
      if (token !== generation || destroyed) return;
      index = content.index;
      displayContent(content);
    } catch (error) {
      if (token !== generation || destroyed) return;
      shadow.replaceChildren(el('div', 'np-epub-error', `本章无法显示：${error.message}`));
    }
    chapter = index; pageControl.set(index + 1, book.chapters.length); markToc(); renderFooter();
    // 插入后布局是同步的，直接定位；不等待动画帧，后台标签页节流时也能准确跳转。
    const anchor = fragment && findAnchor(shadow, fragment);
    if (anchor) anchor.scrollIntoView({ block:'start' });
    else view.viewport.scrollTop = ratio * Math.max(0, view.viewport.scrollHeight - view.viewport.clientHeight);
    save();
  }
  /** 旧进度以整个正文文件的滚动比例保存，先测量原文锚点，再换算为新章节内的进度。 */
  async function restoreLegacyProgress(index, ratio) {
    const token = ++generation, section = book.chapters[index];
    try {
      const content = await chapterContent({ ...section, fragment:'', endFragment:'' });
      if (token !== generation || destroyed || signal.aborted) return;
      displayContent(content); chapter = index; renderFooter(); view.viewport.scrollTop = 0;
      const position = ratio * Math.max(0, view.viewport.scrollHeight - view.viewport.clientHeight);
      const top = view.viewport.getBoundingClientRect().top;
      let start = 0, end = view.viewport.scrollHeight - footer.offsetHeight;
      for (let candidate = 0; candidate < book.chapters.length; candidate++) {
        if (book.chapters[candidate].path !== section.path) continue;
        const anchor = findAnchor(shadow, book.chapters[candidate].fragment);
        if (!anchor) continue;
        const offset = anchor.getBoundingClientRect().top - top;
        if (offset > position) { end = offset; break; }
        index = candidate; start = offset;
      }
      // 章内滚动区间扣除可视高度，并计入底部翻章区，首尾位置统一夹到有效范围。
      ratio = Math.min(1, Math.max(0, (position - start) / Math.max(1, end - start + footer.offsetHeight - view.viewport.clientHeight)));
    } catch { /* 迁移失败仍允许从对应正文的首章继续阅读 */ }
    if (token === generation && !destroyed && !signal.aborted) await open(index, { ratio });
  }
  function renderFooter() {
    footer.replaceChildren();
    const label = (index) => book.chapters[index]?.label;
    if (chapter > 0) { const b = el('button'); b.type = 'button'; b.append(el('span', '', `上一章${label(chapter - 1) ? ` · ${label(chapter - 1)}` : ''}`)); b.addEventListener('click', () => open(chapter - 1, { ratio:1 })); footer.append(b); } else footer.append(el('span'));
    if (chapter < book.chapters.length - 1) { const b = el('button'); b.type = 'button'; b.append(el('span', '', `下一章${label(chapter + 1) ? ` · ${label(chapter + 1)}` : ''}`)); b.addEventListener('click', () => open(chapter + 1)); footer.append(b); }
  }
  /** 阅读进度按文件名与大小记在本机，存储不可用时静默跳过。 */
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 300);
  }
  /** 保存锚点身份，章节展开后的索引变化不会把新进度恢复到错误章节。 */
  function persist() {
    if (chapter < 0) return;
    const max = view.viewport.scrollHeight - view.viewport.clientHeight, section = book.chapters[chapter];
    try { localStorage.setItem(storageKey, JSON.stringify({ chapter, path:section.path, fragment:section.fragment, ratio:max > 0 ? view.viewport.scrollTop / max : 0, scale, tocWidth })); } catch { /* 隐私模式等场景无法保存进度 */ }
  }

  const pageControl = pager({ vertical:false, unit:'章', go:(n) => open(n - 1) });
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

  /** 拖动范围按阅读器实际宽度限制，桌面至少保留 240px 正文，窄屏仍使用覆盖式目录。 */
  function widthLimits() {
    const width = layout.clientWidth || innerWidth;
    const max = Math.max(120, innerWidth <= 760 ? Math.floor(width * .82) : Math.min(520, width - 240));
    return { min:Math.min(180, max), max };
  }
  /** 统一鼠标、触摸与键盘调整，窗口缩小时同步收紧已选宽度。 */
  function resizeToc(next = tocWidth) {
    const { min, max } = widthLimits();
    if (next != null) {
      tocWidth = Math.round(Math.min(max, Math.max(min, next)));
      layout.style.setProperty('--np-toc-width', `${tocWidth}px`);
    }
    resizer.setAttribute('aria-valuemin', String(min)); resizer.setAttribute('aria-valuemax', String(max));
    resizer.setAttribute('aria-valuenow', String(tocWidth ?? toc.getBoundingClientRect().width));
  }
  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizing = { id:event.pointerId, x:event.clientX, width:toc.getBoundingClientRect().width };
    resizer.setPointerCapture(event.pointerId); resizer.setAttribute('data-resizing', '');
  });
  resizer.addEventListener('pointermove', (event) => {
    if (resizing?.id === event.pointerId) resizeToc(resizing.width + event.clientX - resizing.x);
  });
  // 指针取消或移出后由捕获机制收尾，避免拖动状态残留。
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) resizer.addEventListener(type, (event) => {
    if (resizing?.id !== event.pointerId) return;
    resizing = null; resizer.removeAttribute('data-resizing');
    if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
    save();
  });
  resizer.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const { min, max } = widthLimits();
    resizeToc(event.key === 'Home' ? min : event.key === 'End' ? max : toc.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -10 : 10));
    save();
  });
  const resizeObserver = new ResizeObserver(() => resizeToc());
  resizeObserver.observe(layout);

  // 书内链接跳转章节或锚点；外部链接只复制地址，不直接打开。
  shadow.addEventListener('click', (event) => {
    const link = event.composedPath().find((node) => node instanceof Element && node.localName === 'a');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#nb-frag:')) {
      const fragment = href.slice(9), target = findAnchor(shadow, fragment);
      if (target) { target.scrollIntoView({ block:'start' }); save(); }
      else open(chapterIndex(book.chapters[chapter]?.path, fragment), { fragment });
    }
    else if (href.startsWith('#nb-epub:')) { const [path, fragment] = href.slice(9).split('|'); open(chapterIndex(decodeURIComponent(path), fragment), { fragment }); }
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
  if (Number.isFinite(saved?.tocWidth)) resizeToc(saved.tocWidth);
  // 旧版保存的是书脊文件索引，先匹配原文档，避免误把旧“第 2 页”当成第 2 章。
  const restored = saved?.path ? chapterIndex(saved.path, saved.fragment) : book.chapters.findIndex((item) => item.spineIndex === (Number(saved?.chapter) || 0));
  const legacySplit = !saved?.path && book.chapters.filter((item) => item.path === book.chapters[restored]?.path).length > 1;
  const restoredRatio = Math.min(1, Math.max(0, Number(saved?.ratio) || 0));
  if (legacySplit && restoredRatio > 0) await restoreLegacyProgress(restored, restoredRatio);
  else await open(Math.max(0, restored), { ratio:restoredRatio });
  /** 卸载时立即落盘并释放观察器与资源，关闭文件后不遗留拖动和延迟保存任务。 */
  function destroy() {
    if (destroyed) return;
    persist(); destroyed = true; generation++; clearTimeout(saveTimer); resizeObserver.disconnect();
    signal.removeEventListener('abort', destroy); view.destroy();
    for (const pending of urls.values()) void pending.then((url) => URL.revokeObjectURL(url));
  }
  signal.addEventListener('abort', destroy, { once:true });
  if (signal.aborted) destroy();
  return destroy;
}
