// PDF 原版页面与可选择文字层一起渲染；只挂载视口附近页面，离开后释放 Canvas。
import { getDocument, GlobalWorkerOptions, TextLayer, PDFDataRangeTransport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerCode from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw';
import viewerCss from 'pdfjs-dist/web/pdf_viewer.css?raw';
import assets from 'noteboard:pdf-assets';
import { createView, el, iconButton, zoomControl, pager, separator } from '../shared/view.mjs';
import { createRangeTransport, RANGE_CHUNK_BYTES } from './range.mjs';

// 宿主通过能力声明选择分块源；旧宿主和 NOTE 内嵌 PDF 继续传入 bytes。
export const supportsRangeRead = true;

/** 内置字体与 CMap 都来自插件包，离线阅读不请求 CDN。 */
function bytesFor(group, name) {
  const value=assets[group]?.[name];if(!value)throw new Error(`缺少 PDF 资源：${name}`);
  return Uint8Array.from(atob(value),(c)=>c.charCodeAt(0));
}
class CMaps { async fetch({name}) {return {cMapData:bytesFor('cmaps',`${name}.bcmap`),isCompressed:true};} }
class Fonts { async fetch({filename}) {return bytesFor('fonts',filename);} }

const GAP=20, PAD=20;

export async function mount({container,name,bytes,source,signal,reading}) {
  const view=createView(container,name,reading);
  const workerUrl=URL.createObjectURL(new Blob([workerCode],{type:'text/javascript'}));
  GlobalWorkerOptions.workerSrc=workerUrl;
  // zoom 为绝对比例（1 = 100%）；fit 为真时随窗口宽度自适应，手动缩放后保持用户比例。
  let doc,observer,zoom=1,fit=true,generation=0,repaint=0,resizeFrame=0,current=1;
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
      const page=await doc.getPage(item.index+1);holder.page=page;if(stale())return;
      // 只读取附近页面的真实尺寸，远处页面沿用首页占位；保持当前阅读位置稳定。
      const base=page.getViewport({scale:1}),top=item.element.offsetTop,before=item.element.offsetHeight;
      item.width=base.width;item.height=base.height;item.userUnit=page.userUnit;
      // 新出现的宽纸张仍遵守“适合宽度”；只在确需缩小时重算，避免反复重绘。
      if(fit&&zoom>.25&&item.width*zoom>view.viewport.clientWidth-PAD*2+1){layout();return;}
      sizePage(item);
      if(top+before<=view.viewport.scrollTop)view.viewport.scrollTop+=item.element.offsetHeight-before;
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
    finally {if(stale())holder.page?.cleanup();}
  }
  function cancel(item) {const holder=renders.get(item.index);if(holder){holder.cancelled=true;holder.task?.cancel();holder.layer?.cancel();holder.page?.cleanup();renders.delete(item.index);}}
  // 显式清空位图，避免离开视口的 Canvas 等待 GC 才归还显存与内存。
  function release(item) {cancel(item);for(const canvas of item.element.querySelectorAll('canvas')){canvas.width=0;canvas.height=0;}item.element.replaceChildren();}
  /** PDF.js 的文字层缩放包含文件自身的 userUnit，与占位或实际页面尺寸同步。 */
  function sizePage(item) {item.scale=zoom;item.element.style.width=`${item.width*zoom}px`;item.element.style.height=`${item.height*zoom}px`;item.element.style.setProperty('--scale-factor',String(zoom));item.element.style.setProperty('--total-scale-factor',String(zoom*item.userUnit));}
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
    pages.forEach(sizePage);
    // 锚点位于首页之上的留白时保持原位置，避免初次布局被推下一段。
    if(fy>=0)vp.scrollTop=target.element.offsetTop+fy*target.element.offsetHeight-ay;
    if(anchor)vp.scrollLeft=target.element.offsetLeft+fx*target.element.offsetWidth-ax;
    zoomer.update();
    clearTimeout(repaint);repaint=setTimeout(observe,anchor?140:0);
  }
  // 页码取实际可见页，预加载下一页不会提前跳动页码输入框。
  view.viewport.addEventListener('scroll',()=>{let low=0,high=pages.length-1;while(low<high){const mid=Math.floor((low+high)/2),page=pages[mid].element;if(page.offsetTop+page.offsetHeight<view.viewport.scrollTop+40)low=mid+1;else high=mid;}if(pages.length){current=low+1;pageControl.set(current,pages.length);}},{passive:true});
  let rejectRange;
  const rangeFailure=new Promise((_,reject)=>{rejectRange=reject;});
  const range=source?createRangeTransport(PDFDataRangeTransport,source,signal,(error)=>{
    rejectRange(error);
    // 首屏之后的读取失败同样终止解析并给出反馈，不能让某页永久等待。
    if(doc){generation++;clearTimeout(repaint);cancelAnimationFrame(resizeFrame);observer?.disconnect();resize?.disconnect();pages.forEach(release);view.viewport.replaceChildren(el('div','np-pdf-error',`PDF 读取失败：${error.message}`));void task.destroy();}
  }):null;
  // 旧宿主与笔记附件保留字节所有权；新版分块源不再复制整份文件。
  const task=getDocument({...(range?{range,length:source.size,rangeChunkSize:RANGE_CHUNK_BYTES,disableAutoFetch:true,disableStream:true}:{data:bytes.slice()}),isEvalSupported:false,useWasm:false,isOffscreenCanvasSupported:false,CMapReaderFactory:CMaps,StandardFontDataFactory:Fonts,useSystemFonts:true});
  let destroyed=false,resize;
  const destroy=()=>{if(destroyed)return;destroyed=true;generation++;clearTimeout(repaint);cancelAnimationFrame(resizeFrame);observer?.disconnect();resize?.disconnect();range?.abort();pages.forEach(release);void task.destroy();URL.revokeObjectURL(workerUrl);view.destroy();};
  signal.addEventListener('abort',destroy,{once:true});
  try {
    doc=await Promise.race([task.promise,rangeFailure]);if(signal.aborted){destroy();return;}
    if(doc.numPages>2000)throw new Error('此文件超过 2000 页，请使用专业 PDF 软件打开');
    pageControl.set(1,doc.numPages);
    // 首页尺寸用于轻量占位，不在打开时解析全部页面；真实尺寸在进入视口时更新。
    const first=await doc.getPage(1),v=first.getViewport({scale:1});if(signal.aborted)return;
    const fragment=document.createDocumentFragment();
    for(let i=0;i<doc.numPages;i++){const element=el('div','np-pdf-page');element.dataset.page=String(i);element.setAttribute('aria-label',`第 ${i+1} 页`);pages.push({index:i,width:v.width,height:v.height,userUnit:first.userUnit,scale:1,element});fragment.append(element);}
    list.append(fragment);
    layout();
    // 窗口尺寸变化只在自适应模式下重新计算比例，手动缩放保持不变。
    let width=view.viewport.clientWidth;
    // 下一帧再更新页面，避免滚动条宽度变化在 ResizeObserver 回调内形成布局循环。
    resize=new ResizeObserver(()=>{if(view.viewport.clientWidth===width)return;width=view.viewport.clientWidth;cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{if(fit&&!destroyed)layout();});});resize.observe(view.viewport);
    return ()=>{signal.removeEventListener('abort',destroy);destroy();};
  }catch(error){destroy();throw error;}
}
