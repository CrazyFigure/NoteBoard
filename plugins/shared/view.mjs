// 插件使用 Shadow DOM 隔离样式，同时继承 NoteBoard 的主题、字体和字号。
export const IS_MAC = /Mac|iPhone|iPad/i.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
/** 修饰键按平台显示，提示文字与实际按键保持一致。 */
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

export function createView(container, name) {
  const root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
  root.replaceChildren();
  const style = document.createElement('style');
  style.textContent = `
    :host{--np-backdrop:color-mix(in srgb,var(--editor-text) 7%,var(--editor-surface));--np-paper-shadow:0 1px 3px rgba(0,0,0,.12),0 0 0 1px rgba(0,0,0,.05);display:block;position:relative;height:100%;min-height:0;color:var(--editor-text);font:var(--ui-font-size,13px) var(--ui-font-family,sans-serif);user-select:text}
    *{box-sizing:border-box}button,input,select{font:inherit;color:inherit}
    button{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;cursor:pointer;border:1px solid var(--control-border);border-radius:6px;padding:0 10px;background:var(--editor-bg);white-space:nowrap;transition:background .12s,transform .12s,border-color .12s}
    button:hover{background:var(--toolbar-hover)}button:active{background:var(--toolbar-active);transform:translateY(1px)}button:disabled{opacity:.45;cursor:default;transform:none}
    button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--editor-accent);outline-offset:1px}
    button[aria-pressed=true]{color:var(--editor-accent);border-color:color-mix(in srgb,var(--editor-accent) 55%,transparent);background:color-mix(in srgb,var(--editor-accent) 10%,var(--editor-bg))}
    button.np-icon{width:28px;padding:0;flex-shrink:0}button.np-ghost{border-color:transparent;background:transparent}button.np-ghost:hover{background:var(--toolbar-hover)}button.np-ghost:active{background:var(--toolbar-active)}
    button svg,.np-select svg{flex-shrink:0}
    input::-webkit-outer-spin-button,input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}input[type=number]{-moz-appearance:textfield}
    .np-layout{height:100%;display:flex;flex-direction:column;background:var(--editor-bg);min-height:0}
    .np-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:44px;padding:7px 12px;border-bottom:1px solid var(--editor-border);background:var(--editor-surface);flex-shrink:0;user-select:none}
    .np-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%;margin-right:auto;font-weight:500}.np-muted{color:var(--editor-text-muted);font-size:12px;font-variant-numeric:tabular-nums}.np-scroll{flex:1;min-height:0;overflow:auto;position:relative}
    .np-group{display:inline-flex;align-items:center;gap:2px}.np-sep{width:1px;height:18px;background:var(--editor-border);margin:0 4px;flex-shrink:0}
    .np-field{height:28px;width:52px;text-align:center;background:var(--editor-bg);border:1px solid var(--control-border);border-radius:6px;padding:0 4px;font-variant-numeric:tabular-nums;transition:border-color .12s}.np-field:hover{border-color:var(--editor-border-focus,var(--editor-accent))}.np-field:focus{outline:none;border-color:var(--editor-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--editor-accent) 22%,transparent)}
    .np-tip{position:fixed;z-index:1000;pointer-events:none;padding:5px 9px;border-radius:6px;border:1px solid var(--editor-border);background:var(--editor-bg);color:var(--editor-text);box-shadow:var(--shadow-md,0 4px 12px rgba(0,0,0,.12));font-size:12px;line-height:1.4;white-space:nowrap;opacity:0;transform:translateY(-2px);transition:opacity .1s,transform .1s}.np-tip.show{opacity:1;transform:none}
    .np-select{justify-content:space-between;gap:8px;min-width:120px;max-width:100%;padding:0 8px 0 10px;text-align:left}.np-select>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.np-select>svg{color:var(--editor-text-muted);transition:transform .15s}.np-select[aria-expanded=true]{border-color:var(--editor-accent)}.np-select[aria-expanded=true]>svg{transform:rotate(180deg)}
    .np-menu{position:fixed;z-index:1001;min-width:140px;max-width:min(360px,calc(100vw - 16px));max-height:300px;overflow:auto;padding:4px;border:1px solid var(--editor-border);border-radius:8px;background:var(--editor-bg);box-shadow:var(--shadow-lg,0 10px 30px rgba(0,0,0,.16));animation:np-menu-in .12s ease-out}
    .np-option{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.np-option>svg{visibility:hidden;color:var(--editor-accent)}.np-option[aria-selected=true]{color:var(--editor-accent)}.np-option[aria-selected=true]>svg{visibility:visible}.np-option.active,.np-option:hover{background:var(--toolbar-hover)}.np-option:active{background:var(--toolbar-active)}
    @keyframes np-menu-in{from{opacity:0;transform:translateY(-3px)}}
    @media(max-width:760px){.np-toolbar{padding:6px 8px;gap:4px}.np-name{max-width:100%;width:100%}button{height:40px;min-width:40px}button.np-icon{width:40px}.np-field{height:40px;font-size:16px}}
  `;
  root.append(style);
  const layout = el('section', 'np-layout'), toolbar = el('header', 'np-toolbar'), viewport = el('div', 'np-scroll');
  const title = el('span', 'np-name', name); toolbar.append(title);
  layout.append(toolbar, viewport); root.append(layout);
  return { root, toolbar, viewport, style, destroy: () => root.replaceChildren() };
}

/** 所有用户文本均通过 textContent 写入，不作为 HTML 执行。 */
export function el(tag, className = '', text = '') {
  const element = document.createElement(tag); element.className = className; element.textContent = String(text); return element;
}

// lucide 图标路径（ISC 许可），只内联插件实际使用的几种。
const ICONS = {
  'chevron-down': 'm6 9 6 6 6-6', 'chevron-up': 'm18 15-6-6-6 6', 'chevron-left': 'm15 18-6-6 6-6', 'chevron-right': 'm9 18 6-6-6-6',
  minus: 'M5 12h14', plus: 'M5 12h14M12 5v14', x: 'M18 6 6 18M6 6l12 12', check: 'M20 6 9 17l-5-5',
  copy: 'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2zM4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2',
  'fit-width': 'M21 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2M21 17v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2M7 12h10M10 9l-3 3 3 3M14 9l3 3-3 3',
  scan: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2',
  text: 'M4 7V4h16v3M9 20h6M12 4v16', book: 'M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
  refresh: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5',
  grip: 'M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01', settings: 'M20 7h-9M14 17H5M17 17a3 3 0 1 0 6 0 3 3 0 1 0-6 0M7 7a3 3 0 1 0-6 0 3 3 0 1 0 6 0',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
};

/** 内联 SVG 图标，颜色跟随 currentColor。 */
export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('stroke-width', name === 'grip' ? '3' : '2');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', ICONS[name] ?? ''); svg.append(path);
  return svg;
}

/** 原生按钮保留键盘与触屏入口；可选图标与提示。 */
export function button(label, action, options = {}) {
  const b = el('button', options.className ?? ''); b.type = 'button';
  if (options.icon) b.append(icon(options.icon, options.iconSize ?? 15));
  if (label) b.append(document.createTextNode(label));
  b.addEventListener('click', action);
  if (options.tip) tip(b, options.tip);
  return b;
}

/** 仅图标按钮：必须带提示与无障碍名称。 */
export function iconButton(name, label, action, className = '') {
  const b = button('', action, { icon: name, className: `np-icon ${className}`.trim() });
  b.setAttribute('aria-label', label); tip(b, label); return b;
}

export const separator = () => el('span', 'np-sep');

/** Shadow DOM 内的自定义提示，100ms 延迟，替代原生 title。 */
export function tip(target, text) {
  let timer = 0, node = null;
  const hide = () => { clearTimeout(timer); node?.remove(); node = null; };
  const show = () => {
    const root = target.getRootNode(); if (!(root instanceof ShadowRoot) || !target.isConnected) return;
    node = el('div', 'np-tip', typeof text === 'function' ? text() : text); node.setAttribute('role', 'tooltip'); root.append(node);
    const rect = target.getBoundingClientRect(), box = node.getBoundingClientRect();
    let top = rect.bottom + 6; if (top + box.height > innerHeight - 4) top = rect.top - box.height - 6;
    const left = Math.max(4, Math.min(innerWidth - box.width - 4, rect.left + rect.width / 2 - box.width / 2));
    place(node, left, top); requestAnimationFrame(() => node?.classList.add('show'));
  };
  target.addEventListener('pointerenter', (event) => { if (event.pointerType !== 'mouse') return; clearTimeout(timer); timer = setTimeout(show, 100); });
  for (const type of ['pointerleave', 'pointerdown', 'blur']) target.addEventListener(type, hide);
  target.addEventListener('focus', () => { if (target.matches(':focus-visible')) { clearTimeout(timer); timer = setTimeout(show, 100); } });
  return target;
}

/** fixed 元素在有 transform 的祖先中会偏移；放置后按实测位置校正。 */
function place(node, left, top) {
  node.style.left = `${left}px`; node.style.top = `${top}px`;
  const rect = node.getBoundingClientRect();
  if (Math.abs(rect.left - left) > .5 || Math.abs(rect.top - top) > .5) { node.style.left = `${2 * left - rect.left}px`; node.style.top = `${2 * top - rect.top}px`; }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * 缩放控件：「− 百分比 +」，百分比可直接输入；
 * 在 target 上绑定 Ctrl/⌘ + 滚轮（含触控板捏合）与触屏双指捏合，anchor 为指针位置。
 */
export function zoomControl({ min, max, step, get, set, target }) {
  const group = el('span', 'np-group');
  const input = el('input', 'np-field'); input.type = 'text'; input.inputMode = 'numeric'; input.setAttribute('aria-label', '缩放比例');
  tip(input, `缩放比例 · ${MOD} + 滚轮缩放`);
  const apply = (value, anchor) => { set(clamp(value, min, max), anchor); update(); };
  const stepBy = (direction) => { const current = get(); apply(Math.round((current + direction * step) / step) * step || current + direction * step); };
  const commit = () => { const n = parseFloat(input.value.replace(/[^\d.]/g, '')); if (Number.isFinite(n) && n > 0) apply(n / 100); else update(); };
  input.addEventListener('focus', () => input.select());
  input.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Enter') { commit(); input.blur(); } if (event.key === 'Escape') { update(); input.blur(); } });
  input.addEventListener('blur', commit);
  group.append(iconButton('minus', `缩小（${MOD} + 滚轮）`, () => stepBy(-1), 'np-ghost'), input, iconButton('plus', `放大（${MOD} + 滚轮）`, () => stepBy(1), 'np-ghost'));
  function update() { if (group.getRootNode().activeElement !== input) input.value = `${Math.round(get() * 100)}%`; }
  if (target) {
    // 触控板捏合在各平台都以 ctrlKey 滚轮事件上报；Mac 额外允许 ⌘ + 滚轮。
    target.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      apply(get() * Math.exp(-clamp(delta, -60, 60) * .0035), { x: event.clientX, y: event.clientY });
    }, { passive: false });
    // 双指捏合：两指距离比例换算缩放，中心点为锚点；单指仍走原生滚动。
    const touches = new Map(); let pinch = null;
    target.style.touchAction = 'pan-x pan-y';
    target.addEventListener('pointerdown', (event) => { if (event.pointerType !== 'touch') return; touches.set(event.pointerId, event); if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, zoom: get() }; } });
    target.addEventListener('pointermove', (event) => {
      if (!touches.has(event.pointerId)) return; touches.set(event.pointerId, event);
      if (!pinch || touches.size !== 2) return;
      const [a, b] = [...touches.values()], distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      apply(pinch.zoom * distance / pinch.distance, { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    });
    for (const type of ['pointerup', 'pointercancel']) target.addEventListener(type, (event) => { touches.delete(event.pointerId); if (touches.size < 2) pinch = null; });
  }
  update();
  return { element: group, update, input };
}

/** 页码控件：文本输入（无上下箭头、滚轮不改值）+ 独立的上一页/下一页按钮。 */
export function pager({ go, vertical = true }) {
  const group = el('span', 'np-group'), input = el('input', 'np-field'), total = el('span', 'np-muted', '/ 0');
  input.type = 'text'; input.inputMode = 'numeric'; input.setAttribute('aria-label', '页码'); tip(input, '输入页码后回车跳转');
  let count = 0, current = 1;
  const jump = (n) => { if (!count) return; current = clamp(Math.round(n), 1, count); input.value = String(current); go(current); };
  const prev = iconButton(vertical ? 'chevron-up' : 'chevron-left', '上一页', () => jump(current - 1), 'np-ghost');
  const next = iconButton(vertical ? 'chevron-down' : 'chevron-right', '下一页', () => jump(current + 1), 'np-ghost');
  input.addEventListener('focus', () => input.select());
  input.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Enter') { const n = parseInt(input.value, 10); if (Number.isFinite(n)) jump(n); else input.value = String(current); input.blur(); } if (event.key === 'Escape') { input.value = String(current); input.blur(); } });
  input.addEventListener('blur', () => { const n = parseInt(input.value, 10); if (Number.isFinite(n) && n !== current) jump(n); else input.value = String(current); });
  total.style.margin = '0 4px';
  group.append(prev, input, total, next);
  return {
    element: group,
    /** 滚动等外部变化同步页码；输入中不覆盖用户正在键入的数字。 */
    set(page, pages = count) { count = pages; current = clamp(page, 1, Math.max(1, count)); total.textContent = `/ ${count}`; if (group.getRootNode().activeElement !== input) input.value = String(current); prev.disabled = current <= 1; next.disabled = current >= count; },
  };
}

/** 自绘下拉框，替代跟随系统样式的原生 select；弹层 fixed 定位，空间不足时向上展开。 */
export function dropdown({ options, value, onChange, ariaLabel = '', className = '' }) {
  const trigger = el('button', `np-select ${className}`.trim()); trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false'); if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);
  const label = el('span'); trigger.append(label, icon('chevron-down', 14));
  let current = String(value ?? ''), menu = null, active = -1;
  const sync = () => { label.textContent = options.find(([key]) => String(key) === current)?.[1] ?? options[0]?.[1] ?? ''; };
  let scope = null;
  const close = (focus = false) => { if (!menu) return; menu.remove(); menu = null; trigger.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); scope?.removeEventListener('scroll', scrolled, true); removeEventListener('resize', closeQuietly); if (focus) trigger.focus(); };
  const closeQuietly = () => close();
  // fixed 弹层不跟随容器滚动；外层滚动或窗口变化时直接收起。
  const scrolled = (event) => { if (event.target !== menu) close(); };
  const outside = (event) => { if (!event.composedPath().some((node) => node === menu || node === trigger)) close(); };
  const choose = (index) => { const option = options[index]; if (!option) return; const next = String(option[0]); close(true); if (next !== current) { current = next; sync(); onChange(next); } };
  const highlight = (index) => { active = clamp(index, 0, options.length - 1); menu?.querySelectorAll('.np-option').forEach((node, i) => node.classList.toggle('active', i === active)); menu?.children[active]?.scrollIntoView({ block: 'nearest' }); };
  const open = () => {
    const root = trigger.getRootNode(); if (!(root instanceof ShadowRoot)) return;
    menu = el('div', 'np-menu'); menu.setAttribute('role', 'listbox');
    options.forEach(([key, text], index) => {
      const option = el('div', 'np-option'); option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(String(key) === current));
      option.append(icon('check', 14), el('span', '', text));
      option.addEventListener('pointerenter', () => highlight(index)); option.addEventListener('click', () => choose(index));
      menu.append(option);
    });
    root.append(menu);
    const rect = trigger.getBoundingClientRect(); menu.style.minWidth = `${rect.width}px`;
    const height = menu.getBoundingClientRect().height, below = innerHeight - rect.bottom - 8;
    const top = height > below && rect.top > below ? rect.top - height - 4 : rect.bottom + 4;
    place(menu, Math.max(8, Math.min(innerWidth - menu.getBoundingClientRect().width - 8, rect.left)), top);
    trigger.setAttribute('aria-expanded', 'true'); highlight(Math.max(0, options.findIndex(([key]) => String(key) === current)));
    document.addEventListener('pointerdown', outside, true);
    scope = root; root.addEventListener('scroll', scrolled, true); addEventListener('resize', closeQuietly);
  };
  trigger.addEventListener('click', () => (menu ? close() : open()));
  trigger.addEventListener('keydown', (event) => {
    if (!menu && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); open(); return; }
    if (!menu) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); highlight(active + (event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); }
    else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); }
  });
  trigger.addEventListener('blur', () => setTimeout(() => { if (menu && trigger.getRootNode().activeElement !== trigger) close(); }, 0));
  sync();
  Object.defineProperty(trigger, 'value', { get: () => current, set: (next) => { current = String(next ?? ''); sync(); } });
  trigger.close = close;
  return trigger;
}

/** 支持 HTTPS 与内网 HTTP 的复制，失败时给出明确反馈。 */
export async function copyText(text, notify) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const input = document.createElement('textarea'); input.value = text;
      input.style.cssText = 'position:fixed;left:-10000px;top:0'; document.body.append(input);
      try { input.select(); if (!document.execCommand('copy')) throw new Error('复制未获允许'); }
      finally { input.remove(); }
    }
    notify('已复制');
  } catch { notify('复制失败，请选择文字后使用系统复制'); }
}

/** 禁止解析器生成的链接执行脚本或自动导航当前应用。 */
export function guardLinks(root, notify) {
  root.addEventListener('click', (event) => {
    const link = event.composedPath().find((node) => node instanceof Element && node.matches('a'));
    if (!link) return;
    const href = link.getAttribute('href') ?? link.getAttribute('xlink:href') ?? '';
    event.preventDefault();
    if (/^https?:\/\//i.test(href)) void copyText(href, notify);
  });
}

/** 文档优先使用原字体，缺失时回退到应用选择的正文字体，不强行重排原版式。 */
export function applyFontFallback(root){
  for(const element of root.querySelectorAll('[style*="font-family"],[font-family]')){
    const family=element.style.fontFamily||element.getAttribute('font-family');
    if(!family||family.includes('var(')||/^(inherit|initial|unset)$/i.test(family))continue;
    const explicit=family.split(',').map((name)=>name.trim()).filter((name)=>!/^(serif|sans-serif|monospace|system-ui)$/i.test(name)).join(',');
    element.style.fontFamily=`${explicit?`${explicit},`:''}var(--content-font-family,var(--ui-font-family))`;
  }
}
