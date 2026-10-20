// PowerPoint 查看：同一 MIT 引擎处理 PPT 与 PPTX；默认关闭动画，保留可选文字。
import { parse } from '@web-ppt/core';
import { Viewer } from '@web-ppt/viewer-core';
import { createView, el, button, copyText, guardLinks, applyFontFallback, zoomControl, pager, separator } from '../shared/view.mjs';
import { cleanOpenXml } from '../shared/openXml.mjs';

export async function mount({ container, name, bytes, signal, notify }) {
  const presentation = await parse(/\.pptx$/i.test(name)?await cleanOpenXml(bytes):bytes);
  if (signal.aborted) { presentation.dispose?.(); return; }
  const view = createView(container, name);
  view.style.textContent += `.np-slides{display:flex;height:100%;min-height:0}
    .np-thumbs{width:176px;flex-shrink:0;overflow:auto;padding:12px 10px;border-right:1px solid var(--editor-border);background:var(--editor-surface);display:flex;flex-direction:column;gap:10px}
    .np-thumb{display:grid;grid-template-columns:18px 1fr;align-items:start;gap:6px;height:auto;padding:0;border:0;background:transparent;text-align:left}
    .np-thumb:hover,.np-thumb:active{background:transparent}.np-thumb>span{color:var(--editor-text-muted);font-size:11px;text-align:right;padding-top:2px;font-variant-numeric:tabular-nums}
    .np-thumb>div{aspect-ratio:16/9;border-radius:4px;border:1px solid var(--editor-border);background:var(--editor-bg);overflow:hidden;transition:border-color .12s,box-shadow .12s}
    .np-thumb>div img{display:block;width:100%;height:100%;object-fit:contain}
    .np-thumb:hover>div{border-color:var(--control-border);box-shadow:var(--shadow-sm)}
    .np-thumb[aria-current=true]>div{border-color:var(--editor-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--editor-accent) 30%,transparent)}.np-thumb[aria-current=true]>span{color:var(--editor-accent);font-weight:600}
    .np-stage{flex:1;min-width:0;overflow:auto;padding:24px;background:var(--np-backdrop);outline:none}.np-canvas{position:relative;width:100%;height:100%;min-height:120px}.np-canvas svg{box-shadow:var(--np-paper-shadow);background:white}.np-stage svg text,.np-stage foreignObject{user-select:text}
    .np-outline{white-space:pre-wrap;padding:28px 32px;max-width:860px;margin:auto;font-family:var(--content-font-family,var(--ui-font-family));line-height:1.8;background:var(--editor-bg);border:1px solid var(--editor-border);border-radius:8px;user-select:text}
    @media(max-width:760px){.np-thumbs{width:84px;padding:8px 6px}.np-thumb{grid-template-columns:1fr}.np-thumb>span{display:none}.np-stage{padding:10px}}`;
  const layout=el('div','np-slides'),thumbs=el('nav','np-thumbs'),stage=el('div','np-stage'),canvas=el('div','np-canvas');
  thumbs.setAttribute('aria-label','幻灯片');stage.tabIndex=0;stage.append(canvas);layout.append(thumbs,stage);view.viewport.append(layout);
  const viewer=new Viewer(canvas,presentation,{animate:false,autoAdvance:false,textMode:'auto',media:'badge'});
  // 外部链接仅复制地址，避免文档中的任意协议直接启动其它程序。
  viewer.onLinkClick=(href)=>{if(/^https?:\/\//i.test(href))void copyText(href,notify);return true;};
  guardLinks(view.root,notify);
  const textPanel=el('div','np-outline');textPanel.hidden=true;stage.append(textPanel);
  const pageControl=pager({vertical:false,go:(n)=>viewer.goTo(n-1)});
  // 引擎的 1 倍表示铺满容器；这里以「适合窗口」为 100%，放大时按像素尺寸撑开画布以便滚动查看。
  let relative=1;
  function applyZoom(anchor){
    const pad=window.innerWidth<=760?20:48,width=Math.max(1,stage.clientWidth-pad),height=Math.max(1,stage.clientHeight-pad);
    const rect=stage.getBoundingClientRect(),ax=anchor?anchor.x-rect.left:stage.clientWidth/2,ay=anchor?anchor.y-rect.top:stage.clientHeight/2;
    const fx=(stage.scrollLeft+ax)/Math.max(1,stage.scrollWidth),fy=(stage.scrollTop+ay)/Math.max(1,stage.scrollHeight);
    const scale=Math.min(width/presentation.width,height/presentation.height)*relative;
    canvas.style.width=relative===1?'100%':`${Math.max(width,presentation.width*scale)}px`;canvas.style.height=relative===1?'100%':`${Math.max(height,presentation.height*scale)}px`;
    viewer.setZoom(relative===1?1:scale);
    stage.scrollLeft=fx*stage.scrollWidth-ax;stage.scrollTop=fy*stage.scrollHeight-ay;
  }
  const zoomer=zoomControl({min:.5,max:4,step:.1,target:stage,get:()=>relative,set:(z,anchor)=>{relative=Math.abs(z-1)<.001?1:z;applyZoom(anchor);}});
  const outline=button('文字',()=>{const on=textPanel.hidden;textPanel.hidden=!on;canvas.hidden=on;outline.setAttribute('aria-pressed',String(on));},{icon:'text',tip:'只看本页文字'});outline.setAttribute('aria-pressed','false');
  view.toolbar.append(pageControl.element,separator(),zoomer.element,separator(),outline,button('复制本页',()=>void copyText(viewer.text(viewer.index),notify),{icon:'copy',tip:'复制本页文字'}));
  const controls=[],urls=[];let destroyed=false,queue=Promise.resolve();
  function update(){
    pageControl.set(viewer.index+1,viewer.count);textPanel.textContent=viewer.text(viewer.index)||'本页没有文字';
    controls.forEach((b,i)=>b.setAttribute('aria-current',String(i===viewer.index)));controls[viewer.index]?.scrollIntoView({block:'nearest'});
    applyFontFallback(canvas);zoomer.update();
  }
  // 缩略图在进入侧栏可视区域时才逐张生成，避免大文件一次栅格化全部页面。
  const thumbObserver=new IntersectionObserver((entries)=>{for(const entry of entries){if(!entry.isIntersecting)continue;thumbObserver.unobserve(entry.target);const index=Number(entry.target.dataset.index),frame=entry.target.querySelector('div');
    queue=queue.then(async()=>{if(destroyed)return;try{const blob=await viewer.exportPng(.3,index);if(destroyed)return;const url=URL.createObjectURL(blob);urls.push(url);const img=el('img');img.alt='';img.src=url;frame.replaceChildren(img);}catch{/* 缩略图失败时保留空白框，不影响主视图 */}});
  }},{root:thumbs,rootMargin:'200px 0px'});
  for(let i=0;i<viewer.count;i++){const b=button('',()=>{viewer.goTo(i);stage.focus({preventScroll:true});},{className:'np-thumb'});b.dataset.index=String(i);b.setAttribute('aria-label',`第 ${i+1} 页`);b.append(el('span','',i+1),el('div'));controls.push(b);thumbs.append(b);thumbObserver.observe(b);}
  // 方向键与翻页键切换幻灯片；输入框内的按键不拦截。
  view.root.addEventListener('keydown',(event)=>{
    if(event.target instanceof HTMLInputElement||event.ctrlKey||event.metaKey||event.altKey)return;
    const moves={ArrowLeft:-1,ArrowUp:-1,PageUp:-1,ArrowRight:1,ArrowDown:1,PageDown:1};
    if(event.key==='Home'||event.key==='End'){event.preventDefault();viewer.goTo(event.key==='Home'?0:viewer.count-1);return;}
    const move=moves[event.key];if(move==null)return;event.preventDefault();event.stopPropagation();if(move<0)viewer.prev();else viewer.next();
  });
  viewer.onChange=update;update();
  const resize=new ResizeObserver(()=>applyZoom());resize.observe(stage);
  return ()=>{destroyed=true;resize.disconnect();thumbObserver.disconnect();urls.forEach((url)=>URL.revokeObjectURL(url));viewer.destroy();presentation.dispose?.();view.destroy();};
}
