// PDF 原版页面与可选择文字层一起渲染；只挂载视口附近页面，离开后释放 Canvas。
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerCode from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw';
import viewerCss from 'pdfjs-dist/web/pdf_viewer.css?raw';
import assets from 'noteboard:pdf-assets';
import { createView, el, iconButton, zoomControl, pager, separator } from '../shared/view.mjs';

/** 内置字体与 CMap 都来自插件包，离线阅读不请求 CDN。 */
function bytesFor(group, name) {
  const value=assets[group]?.[name];if(!value)throw new Error(`缺少 PDF 资源：${name}`);
  return Uint8Array.from(atob(value),(c)=>c.charCodeAt(0));
}
class CMaps { async fetch({name}) {return {cMapData:bytesFor('cmaps',`${name}.bcmap`),isCompressed:true};} }
class Fonts { async fetch({filename}) {return bytesFor('fonts',filename);} }

const GAP=20, PAD=20;

export async function mount({container,name,bytes,signal,reading}) {
  const view=createView(container,name,reading);
  const workerUrl=URL.createObjectURL(new Blob([workerCode],{type:'text/javascript'}));
  GlobalWorkerOptions.workerSrc=workerUrl;
  // zoom 为绝对比例（1 = 100%）；fit 为真时随窗口宽度自适应，手动缩放后保持用户比例。
  let doc,observer,zoom=1,fit=true,generation=0,repaint=0,current=1;
  const renders=new Map(),pages=[];
  view.style.textContent+=viewerCss+`.np-scroll{background:var(--np-backdrop)}.np-pdf-pages{width:max-content;min-width:100%;padding:${PAD}px}.np-pdf-page{position:relative;background:white;box-shadow:var(--np-paper-shadow);margin:0 auto ${GAP}px;overflow:hidden;max-width:none}.np-pdf-page:last-child{margin-bottom:0}.np-pdf-page canvas{position:absolute;inset:0;width:100%;height:100%}.np-pdf-page .textLayer{position:absolute;inset:0;z-index:1;user-select:text;opacity:1}.np-pdf-page .textLayer ::selection{background:color-mix(in srgb,var(--editor-accent) 40%,transparent)}.np-pdf-error{padding:24px;color:#b91c1c;font-size:12px}@media(max-width:760px){.np-pdf-pages{padding:8px}.np-pdf-page{margin-bottom:10px}}`;
  const list=el('div','np-pdf-pages');view.viewport.append(list);
  const pageControl=pager({go:(n)=>{current=n;const page=pages[n-1]?.element;if(page)view.viewport.scrollTop=page.offsetTop-PAD;}});
  const zoomer=zoomControl({min:.25,max:4,step:.1,target:view.viewport,get:()=>zoom,set:(next,anchor)=>{fit=false;zoom=next;layout(anchor);}});
  view.toolbar.append(pageControl.element,separator(),zoomer.element,iconButton('fit-width','适合宽度',()=>{fit=true;layout();}));

  /** 每页有独立取消令牌；新 Canvas 渲染完成后才替换旧内容，缩放时不闪白。 */
  async function paint(item,token) {
    if(renders.has(item.index)||signal.aborted||token!==generation)return;
    const holder={cancelled:false,task:null};renders.set(item.index,holder);
    const stale=()=>holder.cancelled||signal.aborted||token!==generation;
    try {
      const page=await doc.getPage(item.index+1);if(stale())return;
      const viewport=page.getViewport({scale:item.scale});
      const canvas=el('canvas'),text=el('div','textLayer');
      const pixel=Math.min(devicePixelRatio||1,2,Math.sqrt(2400000/(viewport.width*viewport.height)));
      canvas.width=Math.max(1,Math.floor(viewport.width*pixel));canvas.height=Math.max(1,Math.floor(viewport.height*pixel));
      holder.task=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:pixel===1?null:[pixel,0,0,pixel,0,0]});
      await holder.task.promise;if(stale())return;
      item.element.replaceChildren(canvas,text);
      const content=await page.getTextContent();if(stale())return;
      const layer=new TextLayer({textContentSource:content,container:text,viewport});holder.layer=layer;await layer.render();
    }catch(error){if(!stale()){const message=el('div','np-pdf-error',`此页无法显示：${error.message}`);item.element.replaceChildren(message);}}
  }
  function cancel(item) {const holder=renders.get(item.index);if(holder){holder.cancelled=true;holder.task?.cancel();holder.layer?.cancel();renders.delete(item.index);}}
  function release(item) {cancel(item);item.element.replaceChildren();}
  /** 视口附近才渲染；离开后释放 Canvas 控制内存。 */
  function observe() {
    const token=generation;observer?.disconnect();
    observer=new IntersectionObserver((entries)=>{for(const entry of entries){const item=pages[Number(entry.target.dataset.page)];if(entry.isIntersecting)void paint(item,token);else release(item);}}, {root:view.viewport,rootMargin:'600px 0px'});
    pages.forEach((item)=>observer.observe(item.element));
  }
  /** 立即更新页面尺寸并保持锚点位置不动；重绘延迟到缩放停顿后，连续滚轮缩放保持流畅。 */
  function layout(anchor) {
    if(!pages.length)return;
    const vp=view.viewport,rect=vp.getBoundingClientRect();
    const ax=anchor?anchor.x-rect.left:vp.clientWidth/2,ay=anchor?anchor.y-rect.top:0;
    const contentX=vp.scrollLeft+ax,contentY=vp.scrollTop+ay;
    let target=pages.find((item)=>item.element.offsetTop+item.element.offsetHeight>=contentY)??pages[pages.length-1];
    const fy=(contentY-target.element.offsetTop)/Math.max(1,target.element.offsetHeight),fx=(contentX-target.element.offsetLeft)/Math.max(1,target.element.offsetWidth);
    if(fit){const widest=Math.max(...pages.map((item)=>item.width));zoom=Math.min(1,Math.max(.25,(vp.clientWidth-PAD*2)/widest));}
    generation++;observer?.disconnect();pages.forEach(cancel);
    // PDF.js 的文字层按总缩放量计算字号和选区，必须包含文件自身的 userUnit。
    for(const item of pages){item.scale=zoom;item.element.style.width=`${item.width*zoom}px`;item.element.style.height=`${item.height*zoom}px`;item.element.style.setProperty('--scale-factor',String(zoom));item.element.style.setProperty('--total-scale-factor',String(zoom*item.userUnit));}
    // 锚点位于首页之上的留白时保持原位置，避免初次布局被推下一段。
    if(fy>=0)vp.scrollTop=target.element.offsetTop+fy*target.element.offsetHeight-ay;
    if(anchor)vp.scrollLeft=target.element.offsetLeft+fx*target.element.offsetWidth-ax;
    zoomer.update();
    clearTimeout(repaint);repaint=setTimeout(observe,anchor?140:0);
  }
  // 页码取实际可见页，预加载下一页不会提前跳动页码输入框。
  view.viewport.addEventListener('scroll',()=>{let low=0,high=pages.length-1;while(low<high){const mid=Math.floor((low+high)/2),page=pages[mid].element;if(page.offsetTop+page.offsetHeight<view.viewport.scrollTop+40)low=mid+1;else high=mid;}if(pages.length){current=low+1;pageControl.set(current,pages.length);}},{passive:true});
  const task=getDocument({data:bytes.slice(),isEvalSupported:false,useWasm:false,isOffscreenCanvasSupported:false,CMapReaderFactory:CMaps,StandardFontDataFactory:Fonts,useSystemFonts:true});
  const destroy=()=>{generation++;clearTimeout(repaint);observer?.disconnect();pages.forEach(release);void task.destroy();URL.revokeObjectURL(workerUrl);view.destroy();};
  signal.addEventListener('abort',destroy,{once:true});
  try {
    doc=await task.promise;if(signal.aborted){destroy();return;}
    if(doc.numPages>2000)throw new Error('此文件超过 2000 页，请使用专业 PDF 软件打开');
    pageControl.set(1,doc.numPages);
    // 页面大小先使用各自元信息，避免不同纸张尺寸在滚动时突然跳动。
    for(let i=0;i<doc.numPages;i++){const page=await doc.getPage(i+1);if(signal.aborted)return;const v=page.getViewport({scale:1}),element=el('div','np-pdf-page');element.dataset.page=String(i);element.setAttribute('aria-label',`第 ${i+1} 页`);pages.push({index:i,width:v.width,height:v.height,userUnit:page.userUnit,scale:1,element});list.append(element);}
    layout();
    // 窗口尺寸变化只在自适应模式下重新计算比例，手动缩放保持不变。
    let width=view.viewport.clientWidth;
    const resize=new ResizeObserver(()=>{if(view.viewport.clientWidth===width)return;width=view.viewport.clientWidth;if(fit)layout();});resize.observe(view.viewport);
    return ()=>{resize.disconnect();signal.removeEventListener('abort',destroy);destroy();};
  }catch(error){destroy();throw error;}
}
