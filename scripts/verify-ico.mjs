// 校验实际交付的 ICO 帧顺序、尺寸与副本，防止窗口再次使用 16px 小图或旧资源。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ico = readFileSync(join(repoRoot, 'src-tauri/icons/icon.ico'));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
assert.equal(ico.readUInt16LE(0), 0, 'ICO 保留字段必须为零');
assert.equal(ico.readUInt16LE(2), 1, '必须是应用图标');
const count = ico.readUInt16LE(4);
const sizes = new Set();
let expectedOffset = 6 + count * 16;
for (let index = 0; index < count; index += 1) {
  const entry = 6 + index * 16;
  const size = ico[entry] || 256;
  const height = ico[entry + 1] || 256;
  const length = ico.readUInt32LE(entry + 8);
  const offset = ico.readUInt32LE(entry + 12);
  assert.equal(height, size, '图标必须为正方形');
  assert.equal(ico.readUInt16LE(entry + 4), 1, '图标必须为单平面');
  assert.equal(ico.readUInt16LE(entry + 6), 32, '图标必须为 32 位 RGBA');
  assert.equal(offset, expectedOffset, '图标帧不能重叠或留空');
  assert.ok(offset + length <= ico.length, '图标帧不能越界');
  const png = ico.subarray(offset, offset + length);
  assert.deepEqual(png.subarray(0, 8), pngSignature, '图标帧必须为 PNG');
  assert.equal(png.toString('ascii', 12, 16), 'IHDR', 'PNG 必须包含图像头');
  assert.equal(png.readUInt32BE(16), size, 'PNG 宽度必须与 ICO 目录一致');
  assert.equal(png.readUInt32BE(20), size, 'PNG 高度必须与 ICO 目录一致');
  assert.equal(png[24], 8, 'PNG 每通道必须为 8 位');
  assert.equal(png[25], 6, 'PNG 必须保留 RGBA 透明通道');
  if (index === 0) assert.equal(size, 256, 'Tauri 默认窗口图标必须先读取 256px 层');
  assert.ok(!sizes.has(size), 'ICO 尺寸不能重复');
  sizes.add(size);
  expectedOffset += length;
}
assert.equal(expectedOffset, ico.length, 'ICO 不能包含多余数据');
assert.deepEqual([...sizes].sort((a, b) => a - b), [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);
for (const path of ['logo.ico', 'public/logo.ico', 'public/favicon.ico']) {
  assert.deepEqual(readFileSync(join(repoRoot, path)), ico, `${path} 必须与桌面图标一致`);
}
const config = JSON.parse(readFileSync(join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
assert.equal(config.bundle.icon.find((path) => path.endsWith('.png')), 'icons/icon.png', 'Unix 窗口必须优先加载高清 PNG');
const png = readFileSync(join(repoRoot, 'src-tauri/icons/icon.png'));
assert.equal(png.readUInt32BE(16), 512, '默认 PNG 必须为 512px');
assert.equal(png.readUInt32BE(20), 512, '默认 PNG 必须为正方形');
console.log('图标校验通过：256px 首层、10 种 ICO 尺寸、统一副本及 512px Unix 默认图标。');
