// 只读 CAD 插件：解析线程、图形上下文和所有 Blob URL 均随文档关闭释放。
import { CadViewer } from '@flyfish-dev/cad-viewer';
import assets from 'noteboard:cad-assets';
import {createView,el,button,copyText} from '../shared/view.mjs';

/** 给解析结果设置预算，避免几何展开导致主线程明显卡顿；复杂图纸交由专业工具。 */
export function validateScene(doc) {
  const blocks=Object.values(doc.blocks??{}),entities=[...(doc.entities??[]),...blocks.flatMap((b)=>b.entities??[])];
  if(blocks.length>2000||entities.length>25000)throw new Error('图纸超过轻量查看范围（2.5 万个实体），请使用专业 CAD 软件。');
  let points=0;
  for(const e of entities){points+=(e.vertices?.length??0)+(e.points?.length??0)+(e.path?.length??0);if(points>200000)throw new Error('图纸几何数据较复杂，请使用专业 CAD 软件。');}
  // INSERT 可重复引用整个块；按实际展开次数预算，不能只检查源实体数。
  let expanded=0;
  const visit=(items,depth)=>{if(depth>12)throw new Error('图纸块嵌套超过查看范围');for(const e of items){if(++expanded>50000)throw new Error('图纸块展开后过于复杂，请使用专业 CAD 软件。');if(e.blockName&&doc.blocks?.[e.blockName]){const copies=Math.max(1,e.insertRowCount||1)*Math.max(1,e.insertColumnCount||1);if(copies>1000)throw new Error('图纸阵列超过查看范围');for(let i=0;i<copies;i++)visit(doc.blocks[e.blockName].entities??[],depth+1);}}};
  visit(doc.entities??[],0);
  return entities;
}

/** 所有解析资源包含在已校验的插件内，打开图纸不请求远程文件或外部参照。 */
export async function mount({container,name,bytes,signal,notify}) {
  if(bytes.byteLength>16*1024*1024)throw new Error('轻量 CAD 查看支持 16 MB 以内的图纸，请使用专业 CAD 软件打开此文件。');
  const view=createView(container,name),urls=[];let viewer,worker,stopped=false;
  const blob=(value,type)=>{const url=URL.createObjectURL(new Blob([value],{type}));urls.push(url);return url;};
  const status=el('span','np-muted','正在后台解析图纸…'),canvasHost=el('div','cad-canvas'),text=el('div','cad-text');
  view.style.textContent+=`.np-scroll{overflow:hidden;display:flex;flex-direction:column}.cad-canvas{flex:1;min-height:0;position:relative;touch-action:none}.cad-canvas canvas{width:100%;height:100%;display:block;touch-action:none}.cad-text{display:none;flex:1;min-height:0;overflow:auto;padding:18px;font-family:var(--content-font-family,var(--ui-font-family));line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}.cad-text.show{display:block}.cad-hint{padding:6px 12px;border-top:1px solid var(--editor-border);font-size:11px;color:var(--editor-text-muted)}.cad-source{color:inherit;margin-left:auto}`;
  view.viewport.append(canvasHost,text,el('div','cad-hint','滚轮缩放 · 拖动平移 · 图纸只读，外部参照与缺失 SHX 字体可能影响显示'));
  const source=el('a','cad-source','开源代码');source.href='https://github.com/flyfish-dev/cad-viewer';source.target='_blank';source.rel='noopener noreferrer';
  let allText='';
  view.toolbar.append(button('适合窗口',()=>viewer?.fit()),button('−',()=>viewer?.zoomOut()),button('+',()=>viewer?.zoomIn()),button('图纸 / 文字',()=>{const show=text.classList.toggle('show');canvasHost.hidden=show;canvasHost.style.display=show?'none':'';if(!show)viewer?.resize();}),button('复制图中文字',()=>void copyText(allText,notify)),status,source);
  // 线程中先限制实体数量，再把解析结果传回主线程；避免超大结构化克隆。
  const guard=`const send=self.postMessage.bind(self);self.postMessage=(m,...rest)=>{if(m.type==='result'){try{(${validateScene.toString()})(m.result.document)}catch(e){send({type:'error',requestId:m.requestId,error:{message:e.message}});return}}send(m,...rest)};\n`;
  const isDwg=/\.dwg$/i.test(name);
  let code=assets.dxfWorker;
  if(isDwg){
    const wasm=blob(Uint8Array.from(atob(assets.wasm),(c)=>c.charCodeAt(0)),'application/wasm');
    const module=blob(assets.module,'text/javascript');
    // 上游运行时通过 locateFile 解析这两个固定名，映射到包内 Blob，完全离线。
    code=assets.worker.replaceAll('"libredwg-web.wasm"',JSON.stringify(wasm)).replaceAll('"libredwg-web.js"',JSON.stringify(module));
  }
  const destroy=()=>{if(stopped)return;stopped=true;worker?.terminate();viewer?.destroy();observer.disconnect();urls.forEach((url)=>URL.revokeObjectURL(url));view.destroy();};
  const theme=()=>{const style=getComputedStyle(container);return {background:style.getPropertyValue('--editor-bg').trim()||'#fff',foreground:style.getPropertyValue('--editor-text').trim()||'#333'};};
  let textFont='';
  const updateFonts=()=>{const style=getComputedStyle(container);textFont=style.getPropertyValue('--content-font-family').trim()||style.getPropertyValue('--ui-font-family').trim()||'system-ui, sans-serif';};
  const observer=new MutationObserver(()=>{updateFonts();viewer?.setCanvasOptions(theme());});observer.observe(document.documentElement,{attributes:true,attributeFilter:['style','class','data-theme']});
  signal.addEventListener('abort',destroy,{once:true});
  try {
    worker=new Worker(blob(guard+code,'text/javascript'),{type:'module'});
    const result=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{worker.terminate();reject(new Error('图纸解析超时，请使用专业 CAD 软件。'));},45000);
      const finish=(error,value)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const abort=()=>finish(new DOMException('已取消','AbortError'));signal.addEventListener('abort',abort,{once:true});
      worker.onerror=(event)=>finish(new Error(`图纸解析失败：${event.message}`));
      worker.onmessage=({data})=>{if(data.type==='result')finish(null,data.result);if(data.type==='error')finish(new Error(data.error?.message||'图纸解析失败'));};
      // 转移独占字节缓冲，解析期间不在 UI 线程额外保留图纸副本。
      const buffer=bytes.slice().buffer;
      worker.postMessage(isDwg?{type:'load',requestId:1,bytes:buffer,fileName:name,options:{wasmPath:'https://noteboard.invalid/wasm/',keepRaw:false,maxInsertDepth:12}}:{bytes:buffer,fileName:name},[buffer]);
    });
    worker.terminate();if(signal.aborted)return destroy;
    const entities=validateScene(result.document);
    // 字数也设上限，文字面板使用 textContent，禁止 CAD 内容成为 HTML。
    allText=entities.map((e)=>e.text??e.value??'').filter((value)=>typeof value==='string'&&value).join('\n').slice(0,500000);text.textContent=allText||'图纸中没有可复制的文字';
    viewer=new CadViewer({container:canvasHost,renderer:'auto',loaders:[],canvasOptions:{...theme(),maxInsertDepth:12,maxCurveSegments:96,maxVisibleTextLabels:1200,antialias:false,powerPreference:'low-power',enableSpatialIndex:true},onViewChange:({zoomPercent})=>{status.textContent=`${Math.round(zoomPercent)}% · ${result.document.entities?.length??0} 个实体`;}});
    // 仅为此查看器的文字 Canvas 替换上游固定的系统回退字体，SHX 矢量字形保持原样。
    // 缓存 CSS 字体栈，避免每帧上千文字标签重复读取布局；不修改全局 Canvas 原型。
    updateFonts();
    const fontProperty=Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype,'font');
    if(fontProperty?.get&&fontProperty.set)for(const canvas of canvasHost.querySelectorAll('canvas')){
      const context=canvas.getContext('2d');if(!context)continue;
      Object.defineProperty(context,'font',{get:()=>fontProperty.get.call(context),set:(value)=>{fontProperty.set.call(context,String(value).replace('ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',textFont));}});
    }
    viewer.setDocument(result.document,name);viewer.fit();
    return destroy;
  } catch(error) {destroy();throw error;}
}
