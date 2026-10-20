// PDF 原版页面与可选择文字层一起渲染；只挂载视口附近页面，离开后释放 Canvas。
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerCode from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw';
import viewerCss from 'pdfjs-dist/web/pdf_viewer.css?raw';
import assets from 'noteboard:pdf-assets';
import { createView, el, button } from '../shared/view.mjs';

/** 内置字体与 CMap 都来自插件包，离线阅读不请求 CDN。 */
function bytesFor(group, name) {
  const value=assets[group]?.[name];if(!value)throw new Error(`缺少 PDF 资源：${name}`);
  return Uint8Array.from(atob(value),(c)=>c.charCodeAt(0));
}
class CMaps { async fetch({name}) {return {cMapData:bytesFor('cmaps',`${name}.bcmap`),isCompressed:true};} }
class Fonts { async fetch({filename}) {return bytesFor('fonts',filename);} }

export async function mount({container,name,bytes,signal}) {
  const view=createView(container,name);
  const workerUrl=URL.createObjectURL(new Blob([workerCode],{type:'text/javascript'}));
  GlobalWorkerOptions.workerSrc=workerUrl;
  let doc,observer,scale=1,generation=0;
  const renders=new Map(),pages=[];
  view.style.textContent+=viewerCss+`.np-scroll{background:var(--editor-surface);padding:20px}.np-pdf-page{position:relative;background:white;box-shadow:var(--shadow-sm);margin:0 auto 20px;overflow:hidden;max-width:none}.np-pdf-page canvas{position:absolute;inset:0;width:100%;height:100%}.np-pdf-page .textLayer{position:absolute;inset:0;z-index:1;user-select:text;opacity:1}.np-pdf-page .textLayer ::selection{background:color-mix(in srgb,var(--editor-accent) 40%,transparent)}@media(max-width:760px){.np-scroll{padding:8px}.np-pdf-page{margin-bottom:10px}}`;
  const pageInput=el('input');pageInput.type='number';pageInput.min='1';pageInput.value='1';pageInput.setAttribute('aria-label','页码');
  const count=el('span','np-muted'),zoom=el('span','np-muted','100%');
  view.toolbar.append(pageInput,count,button('−',()=>{scale=Math.max(.4,scale-.2);void layout();}),zoom,button('＋',()=>{scale=Math.min(3,scale+.2);void layout();}));
  pageInput.addEventListener('change',()=>{const n=Math.max(1,Math.min(pages.length,Number(pageInput.value)||1));pageInput.value=String(n);pages[n-1]?.element.scrollIntoView({block:'start'});});
  /** 每页有独立取消令牌；缩放或卸载后迟到的任务不得恢复旧 Canvas。 */
  async function paint(item,token) {
    if(renders.has(item.index)||signal.aborted||token!==generation)return;
    const holder={cancelled:false,task:null};renders.set(item.index,holder);
    try {
      const page=await doc.getPage(item.index+1);if(holder.cancelled||signal.aborted||token!==generation)return;
      const viewport=page.getViewport({scale:item.scale});
      const canvas=el('canvas'),text=el('div','textLayer');
      const pixel=Math.min(devicePixelRatio||1,2,Math.sqrt(2400000/(viewport.width*viewport.height)));
      canvas.width=Math.max(1,Math.floor(viewport.width*pixel));canvas.height=Math.max(1,Math.floor(viewport.height*pixel));
      item.element.replaceChildren(canvas,text);
      holder.task=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:pixel===1?null:[pixel,0,0,pixel,0,0]});
      await holder.task.promise;if(holder.cancelled||signal.aborted||token!==generation)return;
      const content=await page.getTextContent();if(holder.cancelled||signal.aborted||token!==generation)return;
      const layer=new TextLayer({textContentSource:content,container:text,viewport});holder.layer=layer;await layer.render();
    }catch(error){if(!holder.cancelled&&!signal.aborted&&token===generation)item.element.textContent=`此页无法显示：${error.message}`;}
  }
  function release(item) {const holder=renders.get(item.index);if(holder){holder.cancelled=true;holder.task?.cancel();holder.layer?.cancel();renders.delete(item.index);}item.element.replaceChildren();}
  async function layout() {
    const token=++generation;observer?.disconnect();pages.forEach(release);
    const available=Math.max(160,view.viewport.clientWidth-40);
    // PDF.js 的文字层按总缩放量计算字号和选区，必须包含文件自身的 userUnit。
    for(const item of pages){item.scale=Math.min(1,available/item.width)*scale;item.element.style.width=`${item.width*item.scale}px`;item.element.style.height=`${item.height*item.scale}px`;item.element.style.setProperty('--scale-factor',String(item.scale));item.element.style.setProperty('--total-scale-factor',String(item.scale*item.userUnit));}
    zoom.textContent=`${Math.round((pages[0]?.scale??scale)*100)}%`;
    observer=new IntersectionObserver((entries)=>{for(const entry of entries){const item=pages[Number(entry.target.dataset.page)];if(entry.isIntersecting)void paint(item,token);else release(item);}}, {root:view.viewport,rootMargin:'600px 0px'});
    pages.forEach((item)=>observer.observe(item.element));
  }
  // 页码取实际可见页，预加载下一页不会提前跳动页码输入框。
  view.viewport.addEventListener('scroll',()=>{if(view.root.activeElement===pageInput)return;let low=0,high=pages.length-1;while(low<high){const mid=Math.floor((low+high)/2),page=pages[mid].element;if(page.offsetTop+page.offsetHeight<view.viewport.scrollTop+40)low=mid+1;else high=mid;}if(pages.length)pageInput.value=String(low+1);},{passive:true});
  const task=getDocument({data:bytes.slice(),isEvalSupported:false,useWasm:false,isOffscreenCanvasSupported:false,CMapReaderFactory:CMaps,StandardFontDataFactory:Fonts,useSystemFonts:true});
  const destroy=()=>{generation++;observer?.disconnect();pages.forEach(release);void task.destroy();URL.revokeObjectURL(workerUrl);view.destroy();};
  signal.addEventListener('abort',destroy,{once:true});
  try {
    doc=await task.promise;if(signal.aborted){destroy();return;}
    if(doc.numPages>2000)throw new Error('此文件超过 2000 页，请使用专业 PDF 软件打开');
    count.textContent=`/ ${doc.numPages}`;pageInput.max=String(doc.numPages);
    // 页面大小先使用各自元信息，避免不同纸张尺寸在滚动时突然跳动。
    for(let i=0;i<doc.numPages;i++){const page=await doc.getPage(i+1);if(signal.aborted)return;const v=page.getViewport({scale:1}),element=el('div','np-pdf-page');element.dataset.page=String(i);element.setAttribute('aria-label',`第 ${i+1} 页`);pages.push({index:i,width:v.width,height:v.height,userUnit:page.userUnit,scale:1,element});view.viewport.append(element);}
    await layout();
    const resize=new ResizeObserver(()=>void layout());resize.observe(view.viewport);
    return ()=>{resize.disconnect();signal.removeEventListener('abort',destroy);destroy();};
  }catch(error){destroy();throw error;}
}
