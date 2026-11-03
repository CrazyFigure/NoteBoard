// 桌面图标从同一矢量源逐尺寸渲染，避免重复缩放；不覆盖 macOS / Android 的专用图标。
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconRoot = join(repoRoot, 'src-tauri', 'icons');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'noteboard-icons-'));
// 当前锁定的 Tauri 只解码 ICO 第一层作为窗口 / 托盘图标，必须先放高分辨率层，避免高 DPI 放大小图。
const icoSizes = [256, 16, 20, 24, 32, 40, 48, 64, 96, 128];

try {
  // 使用项目锁定的 Tauri SVG 渲染器，不依赖额外的系统图像工具。
  const result = spawnSync(process.execPath, [
    join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
    'icon', join(iconRoot, 'icon-source.svg'), '--output', temporaryRoot,
    ...[...icoSizes, 512].flatMap((size) => ['--png', String(size)]),
  ], { cwd: repoRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`图标渲染失败：${result.status}`);

  // ICO 目录显式保留各 DPI 尺寸，Windows Shell 可直接选择匹配的帧。
  const frames = icoSizes.map((size) => ({ size, png: readFileSync(join(temporaryRoot, `${size}x${size}.png`)) }));
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = directory[entry];
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  const ico = Buffer.concat([directory, ...frames.map(({ png }) => png)]);
  for (const destination of ['src-tauri/icons/icon.ico', 'logo.ico', 'public/logo.ico', 'public/favicon.ico']) {
    writeFileSync(join(repoRoot, destination), ico);
  }

  // Linux 的窗口图标与安装包沿用同一组资源，默认使用 512px，避免从 32px 向上缩放。
  for (const [size, names] of [
    [32, ['32x32.png']],
    [128, ['128x128.png']],
    [256, ['128x128@2x.png']],
    [512, ['icon.png', 'icon-source.png']],
  ]) {
    for (const name of names) copyFileSync(join(temporaryRoot, `${size}x${size}.png`), join(iconRoot, name));
  }
  console.log('桌面图标已生成；macOS ICNS 与 Android 安全区源图保持独立。');
} finally {
  // 只移除本脚本创建的随机临时目录。
  rmSync(temporaryRoot, { recursive: true, force: true });
}
