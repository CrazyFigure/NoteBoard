// NoteBoard 更新日志同步脚本
// 以 v* 附注标签为真相来源，生成「关于」页展示的最近版本日志 src/core/releaseNotes.json。
// 已提交的 JSON 作为基线：Docker 等无 .git 的构建直接沿用，浅克隆只拿到当前标签时合并补充。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(repoRoot, 'src', 'core', 'releaseNotes.json');
const KEEP_COUNT = 10;
const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// 按「新增：」等小节标题拆分附注正文；无小节的整段说明归入无标题小节
function parseBody(body) {
  const sections = [];
  let current = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^(.+?)[：:]$/);
    if (heading && !line.startsWith('-')) {
      current = { title: heading[1], items: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { title: '', items: [] };
      sections.push(current);
    }
    current.items.push(line.replace(/^[-*•]\s*/, ''));
  }
  return sections.filter((section) => section.items.length > 0);
}

function readLocalTags() {
  let names;
  try {
    names = git(['tag', '-l', 'v*']).split(/\r?\n/).map((name) => name.trim()).filter((name) => VERSION_TAG.test(name));
  } catch {
    // 没有 git 或不在仓库内时只用已提交的基线
    return [];
  }
  const entries = [];
  for (const name of names) {
    try {
      // 轻量标签没有附注，跳过以免把提交信息当成更新日志
      const type = git(['cat-file', '-t', name]).trim();
      if (type !== 'tag') continue;
      const date = git(['tag', '-l', name, '--format=%(creatordate:short)']).trim();
      const body = git(['tag', '-l', name, '--format=%(contents:body)']).trim();
      const subject = git(['tag', '-l', name, '--format=%(contents:subject)']).trim();
      // 旧版附注把摘要写在标题里（如「NoteBoard v0.5.8：导图增强…」），正文为空时退回标题
      const sections = parseBody(body || subject.replace(/^NoteBoard\s+v[\d.]+\s*[：:]?\s*/, ''));
      if (sections.length === 0) continue;
      entries.push({ version: name.slice(1), date, sections });
    } catch {
      continue;
    }
  }
  return entries;
}

function compareVersionDesc(a, b) {
  const pa = a.version.split('.').map(Number);
  const pb = b.version.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

const baselineRaw = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
const baseline = baselineRaw ? JSON.parse(baselineRaw) : [];

// 本地标签覆盖同版本基线，便于修订附注后重新生成
const merged = new Map(baseline.map((entry) => [entry.version, entry]));
for (const entry of readLocalTags()) merged.set(entry.version, entry);

const next = [...merged.values()].sort(compareVersionDesc).slice(0, KEEP_COUNT);
const nextRaw = `${JSON.stringify(next, null, 2)}\n`;

if (nextRaw !== baselineRaw) {
  writeFileSync(outputPath, nextRaw, 'utf8');
  console.log(`[sync-changelog] 已更新最近 ${next.length} 个版本日志，最新 v${next[0]?.version ?? '-'}`);
} else {
  console.log(`[sync-changelog] 版本日志已是最新，最新 v${next[0]?.version ?? '-'}`);
}
