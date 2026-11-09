// PDF 右侧导航栏：书签大纲与逐页缩略图两种视图，可收起、可拖动宽度，偏好跨文件保存在本机。
import { el, icon, button, iconButton, tip } from '../shared/view.mjs';
import { buildOutline, resolveDest, currentNode, visibleNode } from './outline.mjs';

const STORAGE_KEY = 'nb-pdf-sidebar', NARROW = 760;

export const sidebarCss = `
  .np-pdf-body{display:flex;flex:1;min-height:0;position:relative}.np-pdf-body>.np-scroll{flex:1;min-width:0}
  .np-pdf-side{width:var(--np-pdf-side-width,260px);flex-shrink:0;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--editor-border);background:var(--editor-surface);user-select:none}
  .np-pdf-side[hidden],.np-pdf-side-resizer[hidden]{display:none}
  .np-pdf-side-resizer{position:relative;z-index:6;flex:0 0 6px;margin:0 -3px;cursor:col-resize;touch-action:none;user-select:none}
  .np-pdf-side-resizer:hover{background:color-mix(in srgb,var(--editor-accent) 25%,transparent)}.np-pdf-side-resizer[data-resizing]{background:var(--editor-accent)}
  .np-pdf-side-resizer:focus-visible{outline:2px solid var(--editor-accent);outline-offset:-2px}
  .np-pdf-side-head{display:flex;align-items:center;gap:6px;padding:8px 8px 8px 10px;border-bottom:1px solid var(--editor-border);flex-shrink:0}
  .np-pdf-tabs{display:flex;flex:1;gap:2px;padding:2px;border-radius:7px;background:var(--np-backdrop)}
  .np-pdf-tab{flex:1;height:26px;min-width:0;border:0;border-radius:5px;padding:0 8px;background:transparent;color:var(--editor-text-muted)}
  .np-pdf-tab:hover{background:var(--toolbar-hover);color:var(--editor-text)}.np-pdf-tab:active{background:var(--toolbar-active);transform:none}
  .np-pdf-tab[aria-selected=true]{background:var(--editor-bg);color:var(--editor-text);font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.1)}
  .np-pdf-pane{flex:1;min-height:0;overflow:auto;position:relative;overscroll-behavior:contain}.np-pdf-pane[hidden]{display:none}
  .np-pdf-outline{padding:6px 6px 16px}
  .np-pdf-ol-row{display:flex;align-items:flex-start}
  .np-pdf-ol-twisty{width:20px;min-width:0;height:30px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--editor-text-muted);flex-shrink:0}
  .np-pdf-ol-twisty:hover{background:var(--toolbar-hover);color:var(--editor-text)}.np-pdf-ol-twisty:active{background:var(--toolbar-active);transform:none}
  .np-pdf-ol-twisty svg{transition:transform .15s}.np-pdf-ol-twisty[aria-expanded=true] svg{transform:rotate(90deg)}
  .np-pdf-ol-spacer{width:20px;flex-shrink:0}
  .np-pdf-ol-link{flex:1;min-width:0;height:auto;min-height:30px;display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:5px 8px;border:0;border-radius:6px;background:transparent;text-align:left;white-space:normal;line-height:1.45}
  .np-pdf-ol-link:hover{background:var(--toolbar-hover)}.np-pdf-ol-link:active{background:var(--toolbar-active);transform:none}
  .np-pdf-ol-link>span:first-child{flex:1;min-width:0;overflow-wrap:anywhere}
  .np-pdf-ol-page{flex-shrink:0;padding-top:1px;color:var(--editor-text-muted);font-size:12px;font-variant-numeric:tabular-nums}
  .np-pdf-ol-link[aria-current=true]{color:var(--editor-accent);background:color-mix(in srgb,var(--editor-accent) 10%,transparent);font-weight:500}.np-pdf-ol-link[aria-current=true] .np-pdf-ol-page{color:inherit}
  .np-pdf-ol-link[data-empty]{color:var(--editor-text-muted);cursor:default}
  .np-pdf-ol-children[hidden]{display:none}
  .np-pdf-empty{padding:40px 16px;text-align:center;color:var(--editor-text-muted);font-size:12px}
  .np-pdf-thumbs{display:flex;flex-direction:column;gap:10px;padding:12px 14px 20px}
  .np-pdf-thumb{display:flex;flex-direction:column;align-items:center;gap:6px;width:100%;height:auto;min-width:0;padding:8px;border:0;border-radius:8px;background:transparent}
  .np-pdf-thumb:hover{background:var(--toolbar-hover)}.np-pdf-thumb:active{background:var(--toolbar-active);transform:none}
  .np-pdf-thumb-frame{width:100%;background:white;box-shadow:var(--np-paper-shadow);overflow:hidden;transition:box-shadow .12s}
  .np-pdf-thumb-frame canvas{display:block;width:100%;height:100%}
  .np-pdf-thumb[aria-current=true] .np-pdf-thumb-frame{box-shadow:0 0 0 2px var(--editor-accent)}
  .np-pdf-thumb-num{font-size:12px;color:var(--editor-text-muted);font-variant-numeric:tabular-nums}.np-pdf-thumb[aria-current=true] .np-pdf-thumb-num{color:var(--editor-accent);font-weight:600}
  @media(max-width:760px){.np-pdf-side-sep{display:none}.np-pdf-side{position:absolute;z-index:5;top:0;bottom:0;right:0;width:min(82%,var(--np-pdf-side-width,280px));box-shadow:var(--shadow-lg)}.np-pdf-side-resizer{display:none}.np-pdf-tab{height:36px}.np-pdf-ol-twisty{width:28px;height:36px}.np-pdf-ol-spacer{width:28px}.np-pdf-ol-link{min-height:36px;padding:8px}}
`;

function loadPrefs() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') ?? {}; } catch { return {}; } }
function savePrefs(prefs) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* 隐私模式等场景不保存偏好 */ } }

/** 只滚动侧栏自身，不让 scrollIntoView 连带滚动正文或宿主页面。 */
function reveal(scroller, node) {
  if (!node || scroller.hidden || !scroller.clientHeight) return;
  const top = node.offsetTop, bottom = top + node.offsetHeight;
  if (top < scroller.scrollTop) scroller.scrollTop = top - 8;
  else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight + 8;
}

/**
 * doc 为 PDF.js 文档；size(i) 返回占位尺寸；go(target) 跳转到 {index,left,top}；
 * busy(i) 表示正文正在使用该页，此时缩略图渲染完不清理页面缓存。
 */
export function createSidebar({ doc, count, size, go, busy }) {
  const prefs = loadPrefs(), narrow = () => innerWidth <= NARROW;
  let tab = prefs.tab === 'thumbs' ? 'thumbs' : 'outline', chosen = false, destroyed = false, currentIndex = 0, width = Number.isFinite(prefs.width) ? prefs.width : null;
  const side = el('aside', 'np-pdf-side'), resizer = el('div', 'np-pdf-side-resizer'), head = el('div', 'np-pdf-side-head'), tabs = el('div', 'np-pdf-tabs');
  side.setAttribute('aria-label', '文档导航'); tabs.setAttribute('role', 'tablist');
  resizer.tabIndex = 0; resizer.setAttribute('role', 'separator'); resizer.setAttribute('aria-orientation', 'vertical'); resizer.setAttribute('aria-label', '调整侧栏宽度');
  tip(resizer, '拖动调整侧栏宽度');
  const outlinePane = el('div', 'np-pdf-pane np-pdf-outline'), thumbsPane = el('div', 'np-pdf-pane np-pdf-thumbs');
  const makeTab = (key, label, pane) => {
    const b = el('button', 'np-pdf-tab', label); b.type = 'button'; b.setAttribute('role', 'tab');
    pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-label', label);
    b.addEventListener('click', () => { chosen = true; show(key); });
    return b;
  };
  const outlineTab = makeTab('outline', '大纲', outlinePane), thumbsTab = makeTab('thumbs', '缩略图', thumbsPane);
  tabs.append(outlineTab, thumbsTab);
  head.append(tabs, iconButton('chevron-right', '收起侧栏', () => setOpen(false), 'np-ghost'));
  side.append(head, outlinePane, thumbsPane);
  // 工具栏入口：提示随展开状态变化
  const toggle = button('', () => setOpen(side.hidden), { icon: 'panel-right', className: 'np-icon' });
  toggle.setAttribute('aria-label', '侧栏'); tip(toggle, () => (side.hidden ? '显示大纲与缩略图' : '收起侧栏'));
  outlinePane.append(el('div', 'np-pdf-empty', '正在读取大纲…'));

  function persist() { savePrefs({ ...loadPrefs(), tab, width, ...(narrow() ? {} : { open: !side.hidden }) }); }
  function show(key, save = true) {
    tab = key;
    outlineTab.setAttribute('aria-selected', String(key === 'outline')); thumbsTab.setAttribute('aria-selected', String(key === 'thumbs'));
    outlinePane.hidden = key !== 'outline'; thumbsPane.hidden = key !== 'thumbs';
    if (key === 'thumbs' && !side.hidden) buildThumbs();
    revealCurrent();
    if (save) persist();
  }
  function setOpen(open, save = true) {
    side.hidden = !open; resizer.hidden = !open; toggle.setAttribute('aria-pressed', String(open));
    if (open && tab === 'thumbs') buildThumbs();
    if (open) { applyWidth(); revealCurrent(); }
    if (save) persist();
  }
  function revealCurrent() {
    if (side.hidden) return;
    // 切换后等布局生效再定位到当前页
    requestAnimationFrame(() => { if (destroyed) return; if (tab === 'outline') reveal(outlinePane, activeNode?.link); else reveal(thumbsPane, thumbs[currentIndex]?.button); });
  }

  // —— 大纲 ——
  let nodes = [], activeNode = null;
  const ensureTarget = (node) => (node.pending ??= (node.dest == null ? Promise.resolve(null) : resolveDest(doc, node.dest)).catch(() => null).then((target) => { node.target = target; return target; }));
  async function select(node) {
    const target = await ensureTarget(node); if (destroyed || !target) return;
    go(target); if (narrow()) setOpen(false);
  }
  function setExpanded(node, expanded) {
    node.expanded = expanded; node.twisty?.setAttribute('aria-expanded', String(expanded));
    if (node.group) node.group.hidden = !expanded;
    markOutline();
  }
  /** 方向键在可见书签间移动，左右键折叠展开；阻止冒泡，避免触发宿主快捷键。 */
  function onTreeKey(event, node) {
    const links = () => [...outlinePane.querySelectorAll('.np-pdf-ol-link')].filter((b) => b.offsetParent !== null);
    const move = (offset) => { const list = links(), i = list.indexOf(node.link); list[i + offset]?.focus(); };
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'ArrowRight') { if (node.children.length && !node.expanded) setExpanded(node, true); else if (node.expanded) node.children[0]?.link.focus(); }
    else if (event.key === 'ArrowLeft') { if (node.children.length && node.expanded) setExpanded(node, false); else node.parent?.link.focus(); }
    else return;
    event.preventDefault(); event.stopPropagation();
  }
  function renderOutline() {
    const root = el('div'); root.setAttribute('role', 'tree'); root.setAttribute('aria-label', '大纲');
    for (const node of nodes) {
      const item = el('div', 'np-pdf-ol-item'), row = el('div', 'np-pdf-ol-row');
      item.setAttribute('role', 'treeitem'); row.style.paddingLeft = `${node.depth * 14}px`;
      if (node.children.length) {
        node.twisty = el('button', 'np-pdf-ol-twisty'); node.twisty.type = 'button'; node.twisty.tabIndex = -1;
        node.twisty.setAttribute('aria-label', '展开或折叠'); node.twisty.setAttribute('aria-expanded', String(node.expanded));
        node.twisty.append(icon('chevron-right', 14)); node.twisty.addEventListener('click', () => setExpanded(node, !node.expanded));
        row.append(node.twisty);
      } else row.append(el('span', 'np-pdf-ol-spacer'));
      const title = el('span', '', node.title); node.page = el('span', 'np-pdf-ol-page');
      if (node.bold) title.style.fontWeight = '600'; if (node.italic) title.style.fontStyle = 'italic';
      node.link = el('button', 'np-pdf-ol-link'); node.link.type = 'button'; node.link.append(title, node.page);
      if (node.dest == null) node.link.dataset.empty = '';
      node.link.addEventListener('click', () => void select(node)); node.link.addEventListener('keydown', (event) => onTreeKey(event, node));
      row.append(node.link); item.append(row);
      if (node.children.length) { node.group = el('div', 'np-pdf-ol-children'); node.group.setAttribute('role', 'group'); node.group.hidden = !node.expanded; item.append(node.group); }
      (node.parent?.group ?? root).append(item);
    }
    outlinePane.replaceChildren(root);
  }
  function markOutline() {
    const next = visibleNode(currentNode(nodes, currentIndex));
    if (next === activeNode) return;
    activeNode?.link.removeAttribute('aria-current'); activeNode = next; activeNode?.link.setAttribute('aria-current', 'true');
    if (tab === 'outline' && !side.hidden) reveal(outlinePane, activeNode?.link);
  }
  async function loadOutline() {
    let raw = null; try { raw = await doc.getOutline(); } catch { /* 损坏的书签按无大纲处理 */ }
    if (destroyed) return;
    nodes = buildOutline(raw);
    if (!nodes.length) {
      outlinePane.replaceChildren(el('div', 'np-pdf-empty', '此文档没有大纲'));
      // 没有书签时默认改看缩略图，但不覆盖用户保存的偏好
      if (tab === 'outline' && !chosen) show('thumbs', false);
      return;
    }
    renderOutline();
    // 页码在后台逐项解析，分批刷新高亮，不阻塞首屏
    for (let i = 0; i < nodes.length; i++) {
      const target = await ensureTarget(nodes[i]); if (destroyed) return;
      if (target) nodes[i].page.textContent = String(target.index + 1);
      if (i % 20 === 19) markOutline();
    }
    markOutline();
  }

  // —— 缩略图：只渲染可见附近的页，串行排队，离开后释放 Canvas ——
  const thumbs = []; let thumbObserver = null, working = false;
  function buildThumbs() {
    if (thumbObserver || destroyed) return;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const b = el('button', 'np-pdf-thumb'), frame = el('div', 'np-pdf-thumb-frame'), { width: w, height: h } = size(i);
      b.type = 'button'; b.dataset.index = String(i); b.setAttribute('aria-label', `第 ${i + 1} 页`); frame.style.aspectRatio = `${w} / ${h}`;
      b.append(frame, el('span', 'np-pdf-thumb-num', i + 1));
      b.addEventListener('click', () => { go({ index: i, left: null, top: null }); if (narrow()) setOpen(false); });
      thumbs.push({ index: i, button: b, frame, canvas: null, task: null, visible: false, failed: false, width: 0 }); fragment.append(b);
    }
    thumbsPane.append(fragment);
    thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) { const thumb = thumbs[Number(entry.target.dataset.index)]; thumb.visible = entry.isIntersecting; if (!thumb.visible) releaseThumb(thumb); }
      void pump();
    }, { root: thumbsPane, rootMargin: '300px 0px' });
    thumbs.forEach((thumb) => thumbObserver.observe(thumb.button));
    markThumb(true);
  }
  function releaseThumb(thumb) {
    thumb.task?.cancel(); thumb.failed = false;
    if (thumb.canvas) { thumb.canvas.width = 0; thumb.canvas.height = 0; thumb.canvas = null; thumb.frame.replaceChildren(); }
  }
  async function pump() {
    if (working) return; working = true;
    try { for (let thumb; !destroyed && (thumb = thumbs.find((t) => t.visible && !t.canvas && !t.failed));) await paintThumb(thumb); }
    finally { working = false; }
  }
  async function paintThumb(thumb) {
    let page;
    try {
      page = await doc.getPage(thumb.index + 1); if (destroyed || !thumb.visible) return;
      const base = page.getViewport({ scale: 1 }), cssWidth = Math.max(40, thumb.frame.clientWidth || 160), pixel = Math.min(devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: cssWidth * pixel / base.width }), canvas = el('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width)); canvas.height = Math.max(1, Math.round(viewport.height));
      thumb.task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      try { await thumb.task.promise; } finally { thumb.task = null; }
      if (destroyed || !thumb.visible) { canvas.width = 0; canvas.height = 0; return; }
      thumb.frame.style.aspectRatio = `${base.width} / ${base.height}`; thumb.frame.replaceChildren(canvas); thumb.canvas = canvas; thumb.width = cssWidth;
    } catch (error) {
      // 取消属于正常释放；其它错误保留空白页框，避免反复重试
      if (thumb.visible && error?.name !== 'RenderingCancelledException') thumb.failed = true;
    } finally { if (page && !busy(thumb.index)) page.cleanup(); }
  }
  function markThumb(force = false) {
    const node = thumbs[currentIndex]; if (!node) return;
    const previous = thumbsPane.querySelector('.np-pdf-thumb[aria-current=true]');
    if (previous === node.button && !force) return;
    previous?.removeAttribute('aria-current'); node.button.setAttribute('aria-current', 'true');
    if (tab === 'thumbs' && !side.hidden) reveal(thumbsPane, node.button);
  }

  // —— 宽度：拖动左边缘，键盘左右键微调 ——
  function limits() {
    const total = side.parentElement?.clientWidth || innerWidth;
    const max = Math.max(160, Math.min(520, total - 240));
    return { min: Math.min(180, max), max };
  }
  function applyWidth(next = width) {
    const { min, max } = limits();
    if (next != null) { width = Math.round(Math.min(max, Math.max(min, next))); side.style.setProperty('--np-pdf-side-width', `${width}px`); }
    resizer.setAttribute('aria-valuemin', String(min)); resizer.setAttribute('aria-valuemax', String(max)); resizer.setAttribute('aria-valuenow', String(width ?? Math.round(side.getBoundingClientRect().width)));
  }
  let resizing = null;
  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return; event.preventDefault();
    resizing = { id: event.pointerId, x: event.clientX, width: side.getBoundingClientRect().width };
    resizer.setPointerCapture(event.pointerId); resizer.setAttribute('data-resizing', '');
  });
  // 侧栏在右侧，指针向左拖动为加宽
  resizer.addEventListener('pointermove', (event) => { if (resizing?.id === event.pointerId) applyWidth(resizing.width + resizing.x - event.clientX); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) resizer.addEventListener(type, (event) => {
    if (resizing?.id !== event.pointerId) return;
    resizing = null; resizer.removeAttribute('data-resizing');
    if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
    persist();
  });
  resizer.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const { min, max } = limits();
    applyWidth(event.key === 'Home' ? min : event.key === 'End' ? max : side.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 10 : -10));
    persist();
  });
  // 侧栏明显变宽或变窄后重绘可见缩略图，避免放大后发虚
  let resizeTimer = 0;
  const resize = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (destroyed) return;
      for (const thumb of thumbs) if (thumb.canvas && Math.abs(thumb.frame.clientWidth - thumb.width) > thumb.width * .25) releaseThumb(thumb);
      void pump();
    }, 160);
  });
  resize.observe(side);

  show(tab, false);
  setOpen(narrow() ? false : prefs.open ?? true, false);
  void loadOutline();

  return {
    side, resizer, toggle,
    /** 正文滚动时同步高亮，只在页码变化时更新。 */
    setCurrent(index) { if (index === currentIndex) return; currentIndex = index; markThumb(); markOutline(); },
    destroy() { destroyed = true; clearTimeout(resizeTimer); resize.disconnect(); thumbObserver?.disconnect(); thumbs.forEach(releaseThumb); side.remove(); resizer.remove(); toggle.remove(); },
  };
}
