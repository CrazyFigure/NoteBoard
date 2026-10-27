// @vitest-environment node
// 使用真实 Vite 构建检验压缩时序，避免压缩副本仍残留动态导入预载占位符而导致网页白屏。
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { build } from 'vite';
import { expect, it } from 'vitest';

it('网页预压缩资源与 Vite 最终输出逐字节相同，动态导入已完成预载替换', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'noteboard-compression-'));
  // 先确认不可变路径位于本测试的临时目录范围内，后续才允许递归清理。
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('noteboard-compression-')) {
    throw new Error('临时构建目录超出预期清理范围');
  }
  try {
    await fs.writeFile(path.join(fixture, 'index.html'), '<script type="module" src="/main.js"></script>');
    // 保留足够的真实脚本字节以触发预压缩，并用动态导入经过 Vite 的最终预载改写阶段。
    const values = Array.from({ length: 150 }, (_, index) => `回归内容 ${index}`);
    await fs.writeFile(path.join(fixture, 'main.js'), `window.values=${JSON.stringify(values)};window.load=()=>import('./async.js');`);
    await fs.writeFile(path.join(fixture, 'async.js'), 'export const value = "异步资源";');
    await build({
      configFile: path.resolve('vite.config.ts'), root: fixture, mode: 'web', logLevel: 'silent',
      build: { outDir: 'dist', reportCompressedSize: false },
    });
    const assets = path.join(fixture, 'dist/assets');
    const files = await fs.readdir(assets);
    const compressed = files.filter((name) => name.endsWith('.js.br'));
    expect(compressed.length).toBeGreaterThan(0);
    for (const name of compressed) {
      const original = await fs.readFile(path.join(assets, name.slice(0, -3)));
      expect(brotliDecompressSync(await fs.readFile(path.join(assets, name)))).toEqual(original);
      expect(gunzipSync(await fs.readFile(path.join(assets, `${name.slice(0, -3)}.gz`)))).toEqual(original);
      expect(original.toString('utf8')).not.toContain('__VITE_PRELOAD__');
    }
  } finally {
    // 路径由 mkdtemp 固定在系统临时目录，只清理当前测试独占的构建目录。
    await fs.rm(fixture, { recursive: true, force: true });
  }
}, 30000);
