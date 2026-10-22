// 发布先检查所有已有版本，禁止用相同版本号替换不同代码（此类插件保留线上原包）；目录最后上传，避免半发布状态。
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('./dist/',import.meta.url));
const repo=process.env.GITHUB_REPOSITORY??'CrazyFigure/NoteBoard';
const gh=(args)=>execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','inherit']});
const exists=(()=>{try{gh(['release','view','plugins','--repo',repo]);return true;}catch{return false;}})();
const catalog=JSON.parse(await fs.readFile(path.join(root,'catalog-v2.json'),'utf8'));
const expected=JSON.parse(await fs.readFile(new URL('./versions.json',import.meta.url),'utf8')).length;
if(catalog.plugins.length!==expected)throw new Error(`必须构建全部 ${expected} 个官方插件，防止覆盖目录时遗漏已发布插件`);
const uploads=[],kept=[];
const assets=exists?JSON.parse(gh(['release','view','plugins','--repo',repo,'--json','assets'])).assets:[];
for(const [index,entry] of catalog.plugins.entries()){
  const name=`${entry.id}-${entry.version}.nbplugin`,file=path.join(root,name),prior=assets.find((a)=>a.name===name);
  if(prior){
    const data=execFileSync('gh',['api',`repos/${repo}/releases/assets/${prior.apiUrl.split('/').pop()}`,'-H','Accept: application/octet-stream'],{maxBuffer:40*1024*1024});
    const sha256=createHash('sha256').update(data).digest('hex');
    // 共享代码改动会让未升版本的插件重新打包出不同内容；同版本仍不替换，目录改指向线上原包，只发布升了版本的插件。
    if(sha256!==entry.sha256){
      const {manifest}=JSON.parse(data.toString('utf8'));
      catalog.plugins[index]={...manifest,licenses:undefined,url:entry.url,sha256,size:data.length};
      kept.push(name);
    }
  }else uploads.push(file);
}
if(kept.length){
  // 旧目录只是新目录的子集，按 id 同步替换，两份目录与线上实际文件保持一致。
  const legacy=JSON.parse(await fs.readFile(path.join(root,'catalog.json'),'utf8'));
  legacy.plugins=legacy.plugins.map((entry)=>catalog.plugins.find((item)=>item.id===entry.id)??entry);
  await fs.writeFile(path.join(root,'catalog.json'),JSON.stringify(legacy,null,2));
  await fs.writeFile(path.join(root,'catalog-v2.json'),JSON.stringify(catalog,null,2));
  // 未升版本却有改动时在 Actions 页面提示，避免本应发布的修改被静默跳过。
  process.stdout.write(`::warning::以下插件内容有变化但版本号未提高，已保留线上原包：${kept.join('、')}\n`);
}
// 说明按本次目录重新生成，每次发布都覆盖，保证表格中的版本号与实际可下载版本一致。
const cell=(text)=>String(text??'').replaceAll('|','\\|').replaceAll('\n',' ');
// 取所有插件中最高的最低应用版本，提示用户需先升级到该版本。
const minApp=catalog.plugins.map((p)=>p.minAppVersion).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1);
const notes=[
  '适用于 NoteBoard 的独立版本官方插件。在软件「设置 → 插件」中下载，安装后勾选启用即可使用；后续可在同一页面检查更新。',
  '',
  '| 插件 | 当前版本 | 功能 | 本版更新 |',
  '| --- | --- | --- | --- |',
  ...catalog.plugins.map((p)=>`| ${cell(p.name)} | ${cell(p.version)} | ${cell(p.description)} | ${cell(p.changelog)} |`),
  '',
  `插件按需加载，更新后自动清理旧版程序并保留用户数据；需 NoteBoard ${minApp} 及以上版本。页面中较早版本的插件包仅为兼容保留，请以上表版本为准。`,
  '',
  `推荐字体同样在插件页下载，来自[官方字体包](https://github.com/${repo}/releases/tag/fonts-v1.0.0)。插件与第三方组件的完整许可证随包附带，[源码与锁定依赖](https://github.com/${repo}/tree/main/plugins)在本仓库维护。`,
  '',
].join('\n');
const notesFile=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'nb-plugins-')),'notes.md');
await fs.writeFile(notesFile,notes);
if(!exists)gh(['release','create','plugins','--repo',repo,'--title','NoteBoard 官方插件','--notes-file',notesFile,'--latest=false']);
for(const file of uploads)gh(['release','upload','plugins',file,'--repo',repo]);
// 旧目录供已发布的旧版本使用，新目录包含全部插件；两者都在插件包上传完成后才覆盖。
gh(['release','upload','plugins',path.join(root,'catalog.json'),path.join(root,'catalog-v2.json'),'--repo',repo,'--clobber']);
gh(['release','edit','plugins','--repo',repo,'--notes-file',notesFile]);
process.stdout.write('官方插件目录发布完成\n');
