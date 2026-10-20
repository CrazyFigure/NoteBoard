// 发布先检查所有已有版本，禁止用相同版本号替换不同代码；目录最后上传，避免半发布状态。
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('./dist/',import.meta.url));
const repo=process.env.GITHUB_REPOSITORY??'CrazyFigure/NoteBoard';
const gh=(args)=>execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','inherit']});
const exists=(()=>{try{gh(['release','view','plugins','--repo',repo]);return true;}catch{return false;}})();
const catalog=JSON.parse(await fs.readFile(path.join(root,'catalog-v2.json'),'utf8'));
const expected=JSON.parse(await fs.readFile(new URL('./versions.json',import.meta.url),'utf8')).length;
if(catalog.plugins.length!==expected)throw new Error(`必须构建全部 ${expected} 个官方插件，防止覆盖目录时遗漏已发布插件`);
const uploads=[];
const assets=exists?JSON.parse(gh(['release','view','plugins','--repo',repo,'--json','assets'])).assets:[];
for(const entry of catalog.plugins){
  const name=`${entry.id}-${entry.version}.nbplugin`,file=path.join(root,name),prior=assets.find((a)=>a.name===name);
  if(prior){
    const data=execFileSync('gh',['api',`repos/${repo}/releases/assets/${prior.apiUrl.split('/').pop()}`,'-H','Accept: application/octet-stream'],{maxBuffer:40*1024*1024});
    if(createHash('sha256').update(data).digest('hex')!==entry.sha256)throw new Error(`${name} 已发布且内容不同，请先提高该插件版本号`);
  }else uploads.push(file);
}
if(!exists)gh(['release','create','plugins','--repo',repo,'--title','NoteBoard 官方插件','--notes','独立版本的 NoteBoard 官方插件：文档查看、电子书阅读与多维表格工作台。','--latest=false']);
for(const file of uploads)gh(['release','upload','plugins',file,'--repo',repo]);
// 旧目录供已发布的旧版本使用，新目录包含全部插件；两者都在插件包上传完成后才覆盖。
gh(['release','upload','plugins',path.join(root,'catalog.json'),path.join(root,'catalog-v2.json'),'--repo',repo,'--clobber']);
process.stdout.write('官方插件目录发布完成\n');
