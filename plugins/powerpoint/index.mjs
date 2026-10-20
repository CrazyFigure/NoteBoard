// PowerPoint 查看：同一 MIT 引擎处理 PPT 与 PPTX；默认关闭动画，保留可选文字。
import { parse } from '@web-ppt/core';
import { Viewer } from '@web-ppt/viewer-core';
import { createView, el, button, copyText, guardLinks, applyFontFallback } from '../shared/view.mjs';
import { cleanOpenXml } from '../shared/openXml.mjs';

export async function mount({ container, name, bytes, signal, notify }) {
  const presentation = await parse(/\.pptx$/i.test(name)?await cleanOpenXml(bytes):bytes);
  if (signal.aborted) { presentation.dispose?.(); return; }
  const view = createView(container, name);
  view.style.textContent += `.np-slides{display:flex;height:100%;min-height:0}.np-thumbs{width:132px;flex-shrink:0;overflow:auto;padding:10px;border-right:1px solid var(--editor-border);background:var(--editor-surface)}.np-thumbs button{display:block;width:100%;margin-bottom:8px;text-align:left}.np-thumbs button[aria-current="true"]{border-color:var(--editor-accent);background:var(--toolbar-active)}.np-stage{flex:1;min-width:0;overflow:auto;padding:24px;background:var(--editor-surface)}.np-stage>svg{max-width:100%;height:auto;display:block;margin:auto}.np-stage svg text,.np-stage foreignObject{user-select:text}.np-outline{white-space:pre-wrap;padding:24px;font-family:var(--content-font-family,var(--ui-font-family));line-height:1.8}@media(max-width:760px){.np-thumbs{width:66px;padding:6px}.np-stage{padding:10px}}`;
  const layout=el('div','np-slides'),thumbs=el('nav','np-thumbs'),stage=el('div','np-stage'),canvas=el('div');stage.append(canvas);layout.append(thumbs,stage);view.viewport.append(layout);
  const viewer=new Viewer(canvas,presentation,{animate:false,autoAdvance:false,textMode:'auto',media:'badge'});
  // 外部链接仅复制地址，避免文档中的任意协议直接启动其它程序。
  viewer.onLinkClick=(href)=>{if(/^https?:\/\//i.test(href))void copyText(href,notify);return true;};
  guardLinks(view.root,notify);
  const page=el('span','np-muted');
  const textPanel=el('div','np-outline');textPanel.hidden=true;stage.append(textPanel);
  const controls=[];
  function update(){page.textContent=`${viewer.index+1} / ${viewer.count}`;textPanel.textContent=viewer.text(viewer.index);controls.forEach((b,i)=>b.setAttribute('aria-current',String(i===viewer.index)));applyFontFallback(canvas);}
  view.toolbar.append(button('上一页',()=>viewer.prev()),page,button('下一页',()=>viewer.next()),button('文字',()=>{textPanel.hidden=!textPanel.hidden;canvas.hidden=!textPanel.hidden;}),button('复制本页文字',()=>void copyText(viewer.text(viewer.index),notify)));
  for(let i=0;i<viewer.count;i++){const b=button(`第 ${i+1} 页`,()=>viewer.goTo(i));controls.push(b);thumbs.append(b);}
  viewer.onChange=update;update();
  return ()=>{viewer.destroy();presentation.dispose?.();view.destroy();};
}
