// 用真实侧栏 DOM 验证离屏回收与迟到任务；引擎替身只避免测试依赖图像栅格化。
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';

test('PPT 缩略图离屏释放、重新进入可重建，关闭后迟到的缩略图不能回填',async()=>{
  const dom=new JSDOM('<div id="host"></div>',{pretendToBeVisual:true}),observers=[];
  const created=[],revoked=[];let resolveBlob;
  const saved=new Map();
  const globals={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,innerWidth:1000,innerHeight:800,HTMLInputElement:dom.window.HTMLInputElement,
    IntersectionObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}},
    ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:()=>0,cancelAnimationFrame:()=>{}};
  dom.window.Element.prototype.scrollIntoView=function(){};
  for(const [key,value] of Object.entries(globals)){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
  URL.createObjectURL=()=>{const url=`blob:test-${created.length}`;created.push(url);return url;};URL.revokeObjectURL=(url)=>revoked.push(url);
  try{
    const result=await build({entryPoints:['powerpoint/index.mjs'],absWorkingDir:fileURLToPath(new URL('..',import.meta.url)),bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'mock-engine',setup(builder){
      builder.onResolve({filter:/^@web-ppt\//},({path})=>({path,namespace:'engine'}));
      builder.onLoad({filter:/.*/,namespace:'engine'},({path})=>({contents:path.endsWith('/core')?'export async function parse(){return {width:100,height:60,dispose(){}}}':`export class Viewer{constructor(){this.index=0;this.count=3;globalThis.__thumbViewer=this;}text(){return 'text';}setZoom(){}goTo(n){this.index=n;}destroy(){this.destroyed=true;}exportPng(){return globalThis.__thumbBlob();}}`,loader:'js'}));
    }}]});
    const {mount}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
    globalThis.__thumbBlob=async()=>new Blob(['png']);
    const host=dom.window.document.getElementById('host'),dispose=await mount({container:host,name:'sample.ppt',bytes:new Uint8Array(),signal:new AbortController().signal,notify:()=>{}});
    const first=host.shadowRoot.querySelector('.np-thumb'),observer=observers[0],tick=()=>new Promise((resolve)=>setImmediate(resolve));
    observer.callback([{target:first,isIntersecting:true}]);await tick();
    assert.equal(first.querySelectorAll('img').length,1);assert.equal(created.length,1);
    observer.callback([{target:first,isIntersecting:false}]);
    assert.equal(first.querySelectorAll('img').length,0);assert.deepEqual(revoked,[created[0]]);
    observer.callback([{target:first,isIntersecting:true}]);await tick();assert.equal(created.length,2);
    globalThis.__thumbBlob=()=>new Promise((resolve)=>{resolveBlob=resolve;});
    const second=host.shadowRoot.querySelectorAll('.np-thumb')[1];observer.callback([{target:second,isIntersecting:true}]);await tick();
    dispose();resolveBlob(new Blob(['late']));await tick();
    assert.equal(created.length,2);assert.equal(revoked.length,2);assert.equal(host.shadowRoot.childNodes.length,0);assert.equal(observer.disconnected,true);
  }finally{
    URL.createObjectURL=create;URL.revokeObjectURL=revoke;delete globalThis.__thumbBlob;delete globalThis.__thumbViewer;
    for(const [key,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
    dom.window.close();
  }
});
