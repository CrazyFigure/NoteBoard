// 实际加载 WASM 并读取二进制 DWG；绑定层校验不能退化为只匹配字符串的测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import { TextEncoder } from 'node:util';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {cspCompatibleRuntime} from '../cad/cspRuntime.mjs';
import {Worker} from 'node:worker_threads';
import {build} from 'esbuild';

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

test('真实 DWG 完成 CSP Worker 解析和场景整理后再回传结果', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'noteboard-cad-worker-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const wasmRoot = new URL('../node_modules/@flyfish-dev/cad-viewer/dist/wasm/', import.meta.url);
  const runtime = path.join(folder, 'runtime.mjs');
  await fs.writeFile(runtime, cspCompatibleRuntime(await fs.readFile(new URL('libredwg-web.js', wasmRoot), 'utf8')));
  const guard = await build({ entryPoints: [fileURLToPath(new URL('../cad/scene-worker.mjs', import.meta.url))], bundle: true, write: false, format: 'iife', minify: true });
  const upstream = (await fs.readFile(new URL('dwg-worker.js', wasmRoot), 'utf8')).replaceAll('"libredwg-web.js"', JSON.stringify(pathToFileURL(runtime).href));
  // Node 仅补齐浏览器 Worker 的消息与离线字节入口，解析、绑定和整理均执行实际发布代码。
  const prelude = `import {parentPort as __cadPort} from 'node:worker_threads';import * as __cadFs from 'node:fs/promises';globalThis.self={postMessage:(message)=>__cadPort.postMessage(message)};globalThis.fetch=async()=>new Response(await __cadFs.readFile(new URL(${JSON.stringify(new URL('libredwg-web.wasm', wasmRoot).href)})));\n`;
  const workerFile = path.join(folder, 'worker.mjs');
  await fs.writeFile(workerFile, prelude + guard.outputFiles[0].text + '\n' + upstream + '\n__cadPort.on("message",data=>self.onmessage({data}));');
  const worker = new Worker(workerFile);
  t.after(() => worker.terminate());
  const bytes = await fs.readFile(new URL('./fixtures/line-2000.dwg', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DWG Worker 验收超时')), 10_000);
    t.after(() => clearTimeout(timer));
    worker.on('error', reject);
    worker.on('message', (message) => {
      if (message.type === 'result') { clearTimeout(timer); resolve(message.result); }
      if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.error.message)); }
    });
    worker.postMessage({ type: 'load', requestId: 1, bytes, fileName: 'sample.dwg', options: { keepRaw: false } });
  });
  assert.ok(result.document.entities.length > 0);
  assert.ok(result.scene.stats.sourceEntities > 0);
  assert.ok(result.scene.stats.expandedEntities >= result.document.entities.length);
  assert.equal(result.document.raw, undefined);
  assert.equal(result.scene.document, undefined);
});
