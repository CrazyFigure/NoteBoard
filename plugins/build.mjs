// 官方插件单独构建为自包含模块；发布目录与主程序包隔离，支持独立版本更新。
import { build } from 'esbuild';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {cspCompatibleRuntime} from './cad/cspRuntime.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const out=path.join(root,'dist');
const metadata=JSON.parse(await fs.readFile(path.join(root,'versions.json'),'utf8'));
const requested=process.argv.slice(2);
await fs.mkdir(out,{recursive:true});

/** 保留直接及传递依赖的许可证原文，随插件分发并可在设置页查看。 */
async function notices(inputs) {
  const items=[];
  const visited=new Set();
  for(const input of inputs.sort()) {
    // 虚拟原始资源复用所属包的许可，不把加载器命名空间误当成本机路径。
    if(input.startsWith('raw:')||input.startsWith('pdf-assets:')||input.startsWith('cad-assets:'))continue;
    if(!input.replaceAll('\\','/').includes('node_modules/'))continue;
    let folder=path.dirname(path.resolve(root,input));
    while(folder!==path.dirname(folder)){
      const pkg=JSON.parse(await fs.readFile(path.join(folder,'package.json'),'utf8').catch(()=>'{}'));
      if(pkg.name){
        const key=`${pkg.name}@${pkg.version}`;if(visited.has(key))break;visited.add(key);
        const files=await fs.readdir(folder),texts=[];
        for(const f of files.filter((f)=>/^(license|copying|notice)([._-]|$)/i.test(f)).sort()){const value=await fs.readFile(path.join(folder,f),'utf8').catch(()=>null);if(value)texts.push(value);}
        if(!texts.length)throw new Error(`缺少第三方许可：${key}`);
        items.push({name:key,text:texts.join('\n')});break;
      }
      folder=path.dirname(folder);
    }
  }
  const ownLicense=await fs.readFile(path.join(root,'../LICENSE'),'utf8');
  return ['NoteBoard 官方插件源码：GPL-3.0-only。第三方组件遵循下列各自许可。',ownLicense,...items.sort((a,b)=>a.name.localeCompare(b.name)).map((item)=>`\n${item.name}\n${item.text}`)].join('\n');
}
const assets={cmaps:{},fonts:{}};
for(const [key,dir] of [['cmaps','cmaps'],['fonts','standard_fonts']]) {
  for(const name of await fs.readdir(path.join(root,'node_modules/pdfjs-dist',dir))) if(!/license/i.test(name))assets[key][name]=(await fs.readFile(path.join(root,'node_modules/pdfjs-dist',dir,name))).toString('base64');
}
const entries=[];
// CAD 独立线程与 WASM 只嵌入 CAD 包，不进入主程序或其它插件。
const cadRoot=path.join(root,'node_modules/@flyfish-dev/cad-viewer');
const dxfWorker=await build({entryPoints:[path.join(root,'cad/dxf-worker.mjs')],bundle:true,write:false,metafile:true,format:'esm',platform:'browser',target:'chrome105',minify:true});
// 校验与场景精简先打包成闭包，随后放在解析 Worker 前，两个格式共用同一份预算。
const sceneWorker=await build({entryPoints:[path.join(root,'cad/scene-worker.mjs')],bundle:true,write:false,format:'iife',platform:'browser',target:'chrome105',minify:true});
const cadAssets={worker:await fs.readFile(path.join(cadRoot,'dist/wasm/dwg-worker.js'),'utf8'),module:cspCompatibleRuntime(await fs.readFile(path.join(cadRoot,'dist/wasm/libredwg-web.js'),'utf8')),wasm:(await fs.readFile(path.join(cadRoot,'dist/wasm/libredwg-web.wasm'))).toString('base64'),dxfWorker:dxfWorker.outputFiles[0].text,sceneWorker:sceneWorker.outputFiles[0].text};
for(const item of metadata) {
  const name=`${item.id}-${item.version}.nbplugin`;
  if(!requested.length||requested.includes(item.id)) {
    const result=await build({entryPoints:[path.join(root,item.id,'index.mjs')],bundle:true,write:false,metafile:true,format:'esm',platform:'browser',target:'chrome105',minify:true,legalComments:'inline',plugins:[{
      name:'plugin-inline-assets',setup(builder){
        builder.onResolve({filter:/\?raw$/},(args)=>({path:path.resolve(root,'node_modules',args.path.slice(0,-4)),namespace:'raw'}));
        builder.onLoad({filter:/.*/,namespace:'raw'},async(args)=>({contents:await fs.readFile(args.path,'utf8'),loader:'text'}));
        builder.onResolve({filter:/^noteboard:pdf-assets$/},()=>({path:'assets',namespace:'pdf-assets'}));
        builder.onLoad({filter:/.*/,namespace:'pdf-assets'},()=>({contents:`export default ${JSON.stringify(assets)}`,loader:'js'}));
        builder.onResolve({filter:/^noteboard:cad-assets$/},()=>({path:'assets',namespace:'cad-assets'}));
        builder.onLoad({filter:/.*/,namespace:'cad-assets'},()=>({contents:`export default ${JSON.stringify(cadAssets)}`,loader:'js'}));
      }
    }]});
    const code=result.outputFiles[0].text;
    let licenses=await notices(Object.keys(result.metafile.inputs));
    if(item.id==='cad') {
      licenses='CAD 插件整体遵循 AGPL-3.0-only，完整源码及锁定依赖见 https://github.com/CrazyFigure/NoteBoard/tree/main/plugins/cad\n'+licenses;
      // 原始 Worker 中的 LibreDWG 代码不出现在 esbuild 输入列表，显式附带其许可。
      licenses+='\n'+await notices([...Object.keys(dxfWorker.metafile.inputs),'node_modules/@flyfish-dev/cad-viewer/package.json']);
      licenses+='\nLibreDWG / @mlightcad/libredwg-web 0.7.9 · GPL-3.0-only\n源码：https://github.com/mlightcad/libredwg-web\n'+await fs.readFile(path.join(root,'../LICENSE'),'utf8');
    }
    if(item.id==='pdf')for(const dir of ['cmaps','standard_fonts'])for(const name of await fs.readdir(path.join(root,'node_modules/pdfjs-dist',dir)))if(/license/i.test(name))licenses+=`\nPDF ${dir}/${name}\n${await fs.readFile(path.join(root,'node_modules/pdfjs-dist',dir,name),'utf8')}`;
    const manifest={...item,apiVersion:1,minAppVersion:'0.5.8',codeSha256:createHash('sha256').update(code).digest('hex'),licenses};
    await fs.writeFile(path.join(out,name),JSON.stringify({manifest,code}));
    process.stdout.write(`${item.id} v${item.version} · ${Math.round(Buffer.byteLength(code)/1024)} KiB\n`);
  }
  const bytes=await fs.readFile(path.join(out,name)).catch(()=>null);if(!bytes)continue;
  const pkg=JSON.parse(bytes.toString('utf8'));
  entries.push({...pkg.manifest,licenses:undefined,url:`https://github.com/CrazyFigure/NoteBoard/releases/download/plugins/${name}`,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});
}
// 0.5.9 及更早版本拒绝条目数超过已知插件数的目录，旧目录只保留最初六个插件；新版本读取 catalog-v2.json。
const LEGACY=['word','excel','powerpoint','pdf','cad','workbench'];
await fs.writeFile(path.join(out,'catalog.json'),JSON.stringify({schemaVersion:1,plugins:entries.filter((entry)=>LEGACY.includes(entry.id))},null,2));
await fs.writeFile(path.join(out,'catalog-v2.json'),JSON.stringify({schemaVersion:1,plugins:entries},null,2));
