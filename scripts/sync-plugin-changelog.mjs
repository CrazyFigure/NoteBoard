// 插件更新日志同步脚本
// 以 plugins/versions.json 的提交历史为真相来源，生成设置页插件卡片展示的最近版本日志 src/features/plugins/pluginChangelog.json。
// 已提交的 JSON 作为基线：Docker 等无 .git 的构建直接沿用，浅克隆只拿到部分历史时合并补充。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionsPath = resolve(repoRoot, 'plugins', 'versions.json');
const outputPath = resolve(repoRoot, 'src', 'features', 'plugins', 'pluginChangelog.json');
const KEEP_COUNT = 10;
const VERSION = /^\d+\.\d+\.\d+$/;

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
}

function compareVersionDesc(a, b) {
  const pa = a.version.split('.').map(Number);
  const pb = b.version.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

/** 依次收集「旧 → 新」的版本快照，同一版本的说明以最新一次为准，日期取首次出现。 */
function collect(merged, snapshot, date) {
  for (const item of snapshot) {
    if (!item?.id || !VERSION.test(item.version ?? '') || !item.changelog) continue;
    const list = merged.get(item.id) ?? new Map();
    const prior = list.get(item.version);
    list.set(item.version, { version: item.version, date: prior?.date && prior.date < date ? prior.date : date, changelog: item.changelog });
    merged.set(item.id, list);
  }
}

function readHistory(merged) {
  let commits;
  try {
    commits = git(['log', '--reverse', '--format=%H %ad', '--date=short', '--', 'plugins/versions.json']).split(/\r?\n/).filter(Boolean);
  } catch {
    // 没有 git 或不在仓库内时只用已提交的基线
    return;
  }
  for (const line of commits) {
    const [hash, date] = line.split(' ');
    try {
      collect(merged, JSON.parse(git(['show', `${hash}:plugins/versions.json`])), date);
    } catch {
      continue;
    }
  }
}

const baselineRaw = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
const baseline = baselineRaw ? JSON.parse(baselineRaw) : {};

// 基线最先写入，提交历史与工作区覆盖同版本说明，便于修订文案后重新生成
const merged = new Map();
for (const [id, entries] of Object.entries(baseline)) merged.set(id, new Map(entries.map((entry) => [entry.version, entry])));
readHistory(merged);
// 工作区尚未提交的新版本也一并展示，日期记为今天
if (existsSync(versionsPath)) collect(merged, JSON.parse(readFileSync(versionsPath, 'utf8')), new Date().toISOString().slice(0, 10));

const next = Object.fromEntries([...merged.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, list]) => [id, [...list.values()].sort(compareVersionDesc).slice(0, KEEP_COUNT)]));
const nextRaw = `${JSON.stringify(next, null, 2)}\n`;

if (nextRaw !== baselineRaw) {
  writeFileSync(outputPath, nextRaw, 'utf8');
  console.log(`[sync-plugin-changelog] 已更新 ${Object.keys(next).length} 个插件的最近版本日志`);
} else {
  console.log('[sync-plugin-changelog] 插件版本日志已是最新');
}
