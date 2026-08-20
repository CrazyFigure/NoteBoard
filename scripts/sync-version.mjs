// NoteBoard 版本号自动同步脚本
// 以 package.json 的 version 为单一真相来源，自动同步至 src-tauri/Cargo.toml 与 src-tauri/tauri.conf.json
// 支持直接执行同步，或通过命令行参数指定新版本号（如: node scripts/sync-version.mjs 0.1.2）

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = resolve(repoRoot, 'package.json');
const cargoTomlPath = resolve(repoRoot, 'src-tauri', 'Cargo.toml');
const tauriConfPath = resolve(repoRoot, 'src-tauri', 'tauri.conf.json');

// 1. 读取 package.json
const packageJsonRaw = readFileSync(packageJsonPath, 'utf8');
const packageJson = JSON.parse(packageJsonRaw);

// 2. 获取目标版本号（命令行传入优先，否则使用 package.json 中的当前版本）
const cliVersion = process.argv[2]?.trim()?.replace(/^v/i, '');
const targetVersion = cliVersion || packageJson.version;

if (!targetVersion || !/^\d+\.\d+\.\d+/.test(targetVersion)) {
  console.error(`[sync-version] 无效的版本号格式: "${targetVersion}"`);
  process.exit(1);
}

// 3. 若通过命令行传入了新版本号，回写 package.json
if (cliVersion && packageJson.version !== targetVersion) {
  packageJson.version = targetVersion;
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  console.log(`[sync-version] 已更新 package.json 版本为: ${targetVersion}`);
}

// 4. 同步更新 src-tauri/Cargo.toml
const cargoTomlRaw = readFileSync(cargoTomlPath, 'utf8');
const updatedCargoToml = cargoTomlRaw.replace(
  /(\[package\][\s\S]*?version\s*=\s*")[^"]+(")/,
  `$1${targetVersion}$2`
);
if (cargoTomlRaw !== updatedCargoToml) {
  writeFileSync(cargoTomlPath, updatedCargoToml, 'utf8');
  console.log(`[sync-version] 已同步 src-tauri/Cargo.toml 版本为: ${targetVersion}`);
} else {
  console.log(`[sync-version] src-tauri/Cargo.toml 版本已是最新: ${targetVersion}`);
}

// 5. 同步更新 src-tauri/tauri.conf.json
const tauriConfRaw = readFileSync(tauriConfPath, 'utf8');
const tauriConf = JSON.parse(tauriConfRaw);
if (tauriConf.version !== targetVersion) {
  tauriConf.version = targetVersion;
  writeFileSync(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`, 'utf8');
  console.log(`[sync-version] 已同步 src-tauri/tauri.conf.json 版本为: ${targetVersion}`);
} else {
  console.log(`[sync-version] src-tauri/tauri.conf.json 版本已是最新: ${targetVersion}`);
}

console.log(`[sync-version] 版本号全工程同步完成: v${targetVersion}`);
