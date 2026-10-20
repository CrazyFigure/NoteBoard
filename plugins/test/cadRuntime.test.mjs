// 实际加载 WASM 并读取二进制 DWG；绑定层校验不能退化为只匹配字符串的测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import { TextEncoder } from 'node:util';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {cspCompatibleRuntime} from '../cad/cspRuntime.mjs';

test('无动态代码执行的 CAD 绑定层仍可解析真实 DWG，依赖变化必须显式审查',async(t)=>{
  const source=await fs.readFile(new URL('../node_modules/@flyfish-dev/cad-viewer/dist/wasm/libredwg-web.js',import.meta.url),'utf8');
  const patched=cspCompatibleRuntime(source);
  assert.doesNotMatch(patched,/new Function|\beval\(/);
  assert.throws(()=>cspCompatibleRuntime(source+' '),/已变化/);
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'noteboard-cad-test-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const target=path.join(folder,'runtime.mjs');await fs.writeFile(target,patched);
  const {default:createModule}=await import(pathToFileURL(target).href);
  const module=await createModule({wasmBinary:await fs.readFile(new URL('../node_modules/@flyfish-dev/cad-viewer/dist/wasm/libredwg-web.wasm',import.meta.url))});
  module.FS.writeFile('sample.dwg',await fs.readFile(new URL('./fixtures/line-2000.dwg',import.meta.url)));
  const result=module.dwg_read_file('sample.dwg');
  try {assert.ok(result.data>0);assert.ok(module.dwg_get_num_entities(result.data)>0);}
  finally {module.dwg_free(result.data);module.FS.unlink('sample.dwg');}
});

test('UTF-8 DXF 忽略旧代码页按 UTF-8 解码，GBK 图纸保持原样', async () => {
  const { normalizeDxfEncoding } = await import('../cad/dxfEncoding.mjs');
  const utf8 = new TextEncoder().encode('  9\n$DWGCODEPAGE\n  3\nANSI_936\n  1\n中文标注\n');
  const fixed = normalizeDxfEncoding(utf8);
  assert.deepEqual([...fixed.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(normalizeDxfEncoding(fixed), fixed);
  const gbk = Uint8Array.from([0x31, 0x0a, 0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(normalizeDxfEncoding(gbk), gbk);
  const ascii = new TextEncoder().encode('0\nEOF\n');
  assert.equal(normalizeDxfEncoding(ascii), ascii);
});
