// 网页字体必须与原生清单一致，归档和访问路径不能绕过固定名称校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFonts, extractFontFiles } from '../fonts.mjs';

test('网页字体清单与已有原生字体包一致，兼容历史文件',async()=>{
  const native=await fs.readFile(new URL('../../src-tauri/src/font_pack.rs',import.meta.url),'utf8');
  const specs=JSON.parse(await fs.readFile(new URL('../font-files.json',import.meta.url),'utf8'));
  assert.equal(specs.length,6);
  for(const spec of specs){assert.ok(native.includes(spec.name));assert.ok(native.includes(spec.sha256));assert.ok(native.includes(spec.size.toLocaleString('en-US').replaceAll(',','_')));}
});

test('网页字体未下载不伪装可用，拒绝任意路径与损坏归档',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'noteboard-font-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let downloads=0;
  const service=await createFonts(dir,{download:async()=>{downloads++;return {ok:true,headers:new Map(),body:[Buffer.from('bad')]};}});
  assert.equal((await service.status()).state,'missing');assert.equal(downloads,0);
  await assert.rejects(service.asset('../state.json'),/不存在/);
  await assert.rejects(service.download(),/格式无效/);assert.equal((await service.status()).state,'missing');
  await assert.rejects(extractFontFiles(Buffer.alloc(24)),/格式无效/);
});
