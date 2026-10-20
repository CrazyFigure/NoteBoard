// 使用真实磁盘与可控下载源验证启用开关、旧版清理、损坏修复和用户数据保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPlugins, validatePackage, compareVersions } from '../plugins.mjs';
import {classify} from '../files.mjs';
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');
test('网页查看格式与主程序映射一致，新增 CAD 不误走文本解码',async()=>{
  const kinds=JSON.parse(await fs.readFile(new URL('../../src/core/docKind.json',import.meta.url),'utf8'));
  for(const [ext,kind]of Object.entries(kinds))if(kind==='preview')assert.equal(classify(`document.${ext}`)[0],'preview');
});
function pkg(version='1.0.0',code='export async function mount(){}'){
  return {manifest:{id:'pdf',name:'PDF',version,apiVersion:1,minAppVersion:'0.5.8',codeSha256:hash(code),licenses:'Apache-2.0',changelog:'test'},code};
}

test('拒绝损坏、未来宿主与伪造官方标识',()=>{
  assert.equal(compareVersions('1.10.0','1.9.0'),1);
  assert.throws(()=>compareVersions('../1.0.0','1.0.0'));
  const value=pkg();assert.equal(validatePackage(value,'pdf','0.5.8'),value);
  assert.throws(()=>validatePackage({...value,code:'changed'},'pdf','0.5.8'));
  assert.throws(()=>validatePackage(value,'../pdf','0.5.8'));
  assert.throws(()=>validatePackage({...value,manifest:{...value.manifest,minAppVersion:'99.0.0'}},'pdf','0.5.8'));
});

test('新装默认禁用，升级保留开关并删除旧版，失败保留可用版本',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'noteboard-plugin-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const userFile=path.join(dir,'notes.bitable');await fs.writeFile(userFile,'用户数据');
  let value=pkg(),badHash=false;
  const command=await createPlugins(dir,'0.5.8',{downloadBytes:async(url)=>{
    const bytes=Buffer.from(JSON.stringify(value));
    if(url.endsWith('catalog-v2.json'))return Buffer.from(JSON.stringify({schemaVersion:1,plugins:[{...value.manifest,url:'https://github.com/CrazyFigure/NoteBoard/releases/download/plugins/pdf.nbplugin',sha256:badHash?'0'.repeat(64):hash(bytes)}]}));
    return bytes;
  }});
  await command('plugin_install',{id:'pdf'});
  assert.equal((await command('plugin_list',{}))[0].enabled,false);
  await assert.rejects(command('plugin_load',{id:'pdf'}),/启用/);
  await command('plugin_toggle',{id:'pdf',enabled:true});
  assert.equal((await command('plugin_load',{id:'pdf'})).manifest.version,'1.0.0');
  value=pkg('1.1.0','new code');badHash=true;
  await assert.rejects(command('plugin_install',{id:'pdf'}),/校验/);
  assert.equal((await command('plugin_load',{id:'pdf'})).manifest.version,'1.0.0');
  badHash=false;await command('plugin_install',{id:'pdf'});
  assert.equal((await command('plugin_load',{id:'pdf'})).manifest.version,'1.1.0');
  await assert.rejects(fs.access(path.join(dir,'plugins','pdf-1.0.0.nbplugin')));
  await command('plugin_toggle',{id:'pdf',enabled:false});
  await command('plugin_install',{id:'pdf'});
  assert.equal((await command('plugin_list',{}))[0].enabled,false);
  await assert.rejects(command('plugin_load',{id:'pdf'}),/启用/);
  await command('plugin_toggle',{id:'pdf',enabled:true});
  await command('plugin_install',{id:'pdf'});
  await fs.writeFile(path.join(dir,'plugins','pdf-1.1.0.nbplugin'),'corrupt');
  assert.equal((await command('plugin_list',{}))[0].invalid,true);
  await command('plugin_install',{id:'pdf'});
  assert.equal((await command('plugin_load',{id:'pdf'})).manifest.version,'1.1.0');
  await command('plugin_remove',{id:'pdf'});
  assert.deepEqual(await command('plugin_list',{}),[]);
  assert.equal(await fs.readFile(userFile,'utf8'),'用户数据');
});
