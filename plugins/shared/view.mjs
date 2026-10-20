// 插件使用 Shadow DOM 隔离样式，同时继承 NoteBoard 的主题、字体和字号。
export function createView(container, name) {
  const root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
  root.replaceChildren();
  const style = document.createElement('style');
  style.textContent = `
    :host{display:block;position:relative;height:100%;min-height:0;color:var(--editor-text);font:var(--ui-font-size,13px) var(--ui-font-family,sans-serif);user-select:text}
    *{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button{cursor:pointer;border:1px solid var(--control-border);border-radius:6px;padding:5px 9px;background:var(--editor-bg);transition:background .12s,transform .12s}button:hover{background:var(--toolbar-hover)}button:active{background:var(--toolbar-active);transform:translateY(1px)}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--editor-accent);outline-offset:2px}
    .np-layout{height:100%;display:flex;flex-direction:column;background:var(--editor-bg);min-height:0}
    .np-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 14px;border-bottom:1px solid var(--editor-border);background:var(--editor-surface);flex-shrink:0;user-select:none}
    .np-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%;margin-right:auto}.np-muted{color:var(--editor-text-muted);font-size:12px}.np-scroll{flex:1;min-height:0;overflow:auto;position:relative}.np-toolbar input{width:64px;background:var(--editor-bg);border:1px solid var(--control-border);border-radius:5px;padding:5px}.np-toolbar select{background:var(--editor-bg);border:1px solid var(--control-border);border-radius:5px;padding:5px;max-width:180px}
    @media(max-width:760px){.np-toolbar{padding:8px;gap:6px}.np-name{max-width:100%;width:100%}button{min-height:40px}.np-toolbar select,.np-toolbar input{min-height:40px;font-size:16px}}
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

/** 原生按钮保留键盘与触屏入口。 */
export function button(label, action) {
  const b = el('button', '', label); b.type = 'button'; b.addEventListener('click', action); return b;
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
