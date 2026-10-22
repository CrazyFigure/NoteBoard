// 只读 CAD 插件：解析线程、图形上下文和所有 Blob URL 均随文档关闭释放。
import { CadViewer, isWebGLAvailable } from '@flyfish-dev/cad-viewer';
import assets from 'noteboard:cad-assets';
import {createView,el,iconButton,separator} from '../shared/view.mjs';
import { CAD_LIMITS, canvasOptionsForScene } from './scene.mjs';

/** 所有解析资源包含在已校验的插件内，打开图纸不请求远程文件或外部参照。 */
export async function mount({container,name,bytes,signal}) {
  if(signal.aborted)throw new DOMException('已取消','AbortError');
  if(bytes.byteLength>CAD_LIMITS.fileBytes)throw new Error('CAD 预览支持 50 MB 以内的图纸，请使用专业 CAD 软件打开此文件。');
  const view=createView(container,name),urls=[];let viewer,worker,stopped=false;
  const blob=(value,type)=>{const url=URL.createObjectURL(new Blob([value],{type}));urls.push(url);return url;};
  const status=el('span','np-muted','正在后台解析图纸…'),canvasHost=el('div','cad-canvas');
  view.style.textContent+=`.np-scroll{overflow:hidden;display:flex;flex-direction:column}.cad-canvas{flex:1;min-height:0;position:relative;touch-action:none}.cad-canvas canvas{width:100%;height:100%;display:block;touch-action:none}.cad-hint{padding:6px 12px;border-top:1px solid var(--editor-border);font-size:11px;color:var(--editor-text-muted)}`;
  const hint=el('div','cad-hint','滚轮缩放 · 拖动平移 · 图纸只读，外部参照与缺失 SHX 字体可能影响显示');
  view.viewport.append(canvasHost,hint);
  // 只保留图纸浏览操作，图中文字仍由渲染器正常绘制，不再提供独立文字列表。
  view.toolbar.append(status,separator(),iconButton('minus','缩小',()=>viewer?.zoomOut(),'np-ghost'),iconButton('plus','放大',()=>viewer?.zoomIn(),'np-ghost'),iconButton('scan','适合窗口',()=>viewer?.fit(),'np-ghost'));
  // 线程内按实际块引用整理结果；不再克隆模型空间的重复定义或在 UI 线程重复遍历整图。
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
    worker=new Worker(blob(assets.sceneWorker+'\n'+code,'text/javascript'),{type:'module'});
    const result=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{worker.terminate();finish(new Error('图纸解析超过 120 秒，请使用专业 CAD 软件。'));},CAD_LIMITS.parseTimeoutMs);
      // 关闭、超时和 Worker 报错共用收尾，避免尚未完成的加载留下定时器或重复回调。
      let finished=false;
      const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const abort=()=>finish(new DOMException('已取消','AbortError'));signal.addEventListener('abort',abort,{once:true});
      worker.onerror=(event)=>finish(new Error(`图纸解析失败：${event.message}`));
      worker.onmessageerror=()=>finish(new Error('图纸数据传输失败，请使用专业 CAD 软件。'));
      const phases={'wasm-init':'正在初始化图纸引擎…',parse:'正在后台解析图纸…',normalize:'正在整理图纸实体…',prepare:'正在检查图纸复杂度…'};
      worker.onmessage=({data})=>{if(data.type==='progress'&&phases[data.progress?.phase])status.textContent=phases[data.progress.phase];if(data.type==='result')finish(null,data.result);if(data.type==='error')finish(new Error(data.error?.message||'图纸解析失败'));};
      // 转移独占字节缓冲，解析期间不在 UI 线程额外保留图纸副本。
      const buffer=bytes.slice().buffer;
      try {worker.postMessage(isDwg?{type:'load',requestId:1,bytes:buffer,fileName:name,options:{wasmPath:'https://noteboard.invalid/wasm/',keepRaw:false,maxInsertDepth:CAD_LIMITS.insertDepth}}:{bytes:buffer,fileName:name},[buffer]);}
      catch(error) {finish(error);}
    });
    worker.terminate();if(signal.aborted)return destroy;
    const options=canvasOptionsForScene(result.scene,isWebGLAvailable());
    if(result.scene.large)hint.textContent+=' · 大图纸已优化显示，细小文字放大后显示';
    status.textContent='正在生成图纸画面…';
    // 让加载状态有机会刷新，再执行 GPU 场景构建；关闭文档后不得继续创建上下文。
    await new Promise((resolve)=>setTimeout(resolve,0));
    if(signal.aborted)return destroy;
    // 大场景已要求 GPU，创建失败时明确退出，不能自动回退到每帧扫描整图的 Canvas2D。
    viewer=new CadViewer({container:canvasHost,renderer:result.scene.large?'webgl':'auto',loaders:[],autoFit:true,canvasOptions:{...theme(),...options},onViewChange:({zoomPercent})=>{status.textContent=`${Math.round(zoomPercent)}% · ${result.document.entities?.length??0} 个实体`;}});
    // 仅为此查看器的文字 Canvas 替换上游固定的系统回退字体，SHX 矢量字形保持原样。
    // 缓存 CSS 字体栈，避免每帧上千文字标签重复读取布局；不修改全局 Canvas 原型。
    updateFonts();
    const fontProperty=Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype,'font');
    if(fontProperty?.get&&fontProperty.set)for(const canvas of canvasHost.querySelectorAll('canvas')){
      const context=canvas.getContext('2d');if(!context)continue;
      Object.defineProperty(context,'font',{get:()=>fontProperty.get.call(context),set:(value)=>{fontProperty.set.call(context,String(value).replace('ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',textFont));}});
    }
    // setDocument 已执行首次适合窗口，避免再次扫描全部实体和嵌套块。
    viewer.setDocument(result.document,name);
    return destroy;
  } catch(error) {destroy();throw error;}
}
