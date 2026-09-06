// NoteBoard 启动预算检查 — 静态入口闭包分析（P0/S01 建立，S05 后作为 CI 门禁）
//
// 🔴 设计约束（docs/启动性能与低内存根治计划.md §P0-5 与回归清单）：
//   1. 只统计真实静态依赖闭包：从 dist/index.html 的入口脚本与 modulepreload 出发，
//      递归跟随静态 import / export-from 边；动态 import() 不计入首屏。
//   2. modulepreload 本身会触发执行，属于首屏闭包，不得通过删除 preload 掩盖静态依赖。
//   3. 记录 minified 字节为主，gzip 仅作补充；不以文件名或压缩体积代替闭包证据。
//   4. 两种模式：默认报告模式（只输出报告，不判定）；--check 门禁模式（违反预算以非零码退出，
//      供 pnpm gate:budget 在依赖边界达标后启用）。
//
// 用法：
//   node scripts/check-budget.mjs           # 报告模式
//   node scripts/check-budget.mjs --check   # 门禁模式

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const distDir = path.join(rootDir, 'dist');
const reportPath = path.join(rootDir, 'test-results', 'performance', 'budget-report.json');

// ── 预算规则 ──
// 入口静态闭包中禁止出现的标志性重依赖 chunk 模式（S05 逐类型懒加载后应全部移出）。
// 普通文本 / 普通 Markdown 的首屏不得执行：Excalidraw、Mermaid、KaTeX、JSZip、cytoscape
// （脑图）、image-blob-reduce（Excalidraw 图片）、lowlight/highlight 全量语言包。
const FORBIDDEN_CHUNK_PATTERNS = [
  { pattern: /excalidraw/i, label: 'excalidraw（画板核心）' },
  { pattern: /subset-shared/i, label: 'excalidraw-subset-shared（画板共享包）' },
  { pattern: /image-blob-reduce/i, label: 'excalidraw-image-blob-reduce（画板图片处理）' },
  { pattern: /mermaid|sequenceDiagram|flowDiagram|ganttDiagram|classDiagram|stateDiagram|erDiagram|pieDiagram|journeyDiagram|mindmap-|timeline-|gitGraph|blockDiagram|architectureDiagram|c4Diagram|vennDiagram|xychart|quadrantChart|requirementDiagram|sankey|circuit|radar/i, label: 'mermaid（图表运行时）' },
  { pattern: /katex/i, label: 'katex（公式渲染）' },
  { pattern: /jszip/i, label: 'jszip（XMind/Excalidraw 压缩依赖）' },
  { pattern: /cytoscape/i, label: 'cytoscape（脑图图布局）' },
  { pattern: /highlight/i, label: 'lowlight/highlight（代码高亮语言包）' },
];

// 🔴 N10.1 模块来源级禁止规则：按构建模块清单（.module-sources.json）追踪包来源，
//    不依赖 chunk 文件名——改名/合并 chunk 仍能检出（黑名单之外的第二道、也是主防线）。
const FORBIDDEN_PACKAGES = [
  { name: '@excalidraw/excalidraw', label: 'excalidraw（画板核心）' },
  { name: 'excalidraw', label: 'excalidraw（画板核心）' },
  { name: 'image-blob-reduce', label: 'image-blob-reduce（画板图片处理）' },
  { name: 'mermaid', label: 'mermaid（图表运行时）' },
  { name: 'katex', label: 'katex（公式渲染）' },
  { name: 'jszip', label: 'jszip（XMind/Excalidraw 压缩依赖）' },
  { name: 'cytoscape', label: 'cytoscape（脑图图布局）' },
  { name: 'lowlight', label: 'lowlight/highlight（代码高亮语言包）' },
  { name: 'highlight.js', label: 'lowlight/highlight（代码高亮语言包）' },
];

// 🔴 N10.1 可配置字节预算：入口静态闭包的硬上限（KiB，minified）。
//    当前实测约 1006 KiB（JS）/ 68 KiB（CSS）；预算留约 20% 余量，超限即回归。
const BUDGET = {
  initialJsKiB: 1200,
  initialCssKiB: 120,
};

/** 从产物 HTML 提取首屏必执行 JS 与 CSS */
function collectBootAssets(html) {
  const scripts = [...html.matchAll(/<script[^>]*type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  const preloads = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\.\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  // 属性顺序可能变化，做一次宽松兜底扫描
  for (const m of html.matchAll(/<script[^>]*src="\.\/(assets\/[^"]+\.js)"/g)) {
    if (!scripts.includes(m[1])) scripts.push(m[1]);
  }
  const styles = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"/g)].map((m) => m[1]);
  return { scripts, preloads, styles };
}

await init;

const htmlPath = path.join(distDir, 'index.html');
if (!fs.existsSync(htmlPath)) {
  console.error('未找到 dist/index.html，请先运行 pnpm build');
  process.exit(2);
}
const html = fs.readFileSync(htmlPath, 'utf8');
const { scripts, preloads, styles } = collectBootAssets(html);

// ── 递归静态闭包（🔴 R14 修复：相对导入者解析 + 缺文件失败关闭）──
const visited = new Map(); // 文件名 → { bytes, staticImports }
const resolveErrors = [];
const missingFiles = new Set();
// 入口与预载文件必须存在（缺失即失败：不是静默跳过）
for (const bootFile of [...new Set([...scripts, ...preloads])]) {
  if (!fs.existsSync(path.join(distDir, bootFile))) {
    missingFiles.add(bootFile);
  }
}
const stack = [...new Set([...scripts, ...preloads])];
while (stack.length > 0) {
  const file = stack.pop();
  if (visited.has(file)) continue;
  const filePath = path.join(distDir, file);
  if (!fs.existsSync(filePath)) {
    // 🔴 R14：静态边引用的文件缺失 → 失败关闭（旧实现静默 continue 会漏依赖）
    missingFiles.add(file);
    continue;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const [imports] = parse(content);
  // 相对导入规范到 dist 根的 POSIX 风格路径（相对导入者所在目录解析）
  const importerDir = path.posix.dirname(file);
  const staticImports = imports
    .filter((item) => item.d === -1 && item.n?.startsWith('./'))
    .map((item) => path.posix.normalize(path.posix.join(importerDir, item.n)));
  visited.set(file, { bytes: fs.statSync(filePath).size, staticImports });
  for (const dep of staticImports) {
    if (!visited.has(dep)) stack.push(dep);
  }
}
// 静态边解析出的目标缺失（如代码引用被删的资源）——在报告模式下警告、门禁模式失败
if (missingFiles.size > 0) {
  resolveErrors.push(`闭包静态边引用的文件缺失: ${[...missingFiles].join(', ')}`);
}

// ── 汇总与违规定位 ──
const closureFiles = [...visited.keys()].sort();
const totalBytes = closureFiles.reduce((sum, f) => sum + visited.get(f).bytes, 0);
const styleBytes = styles.reduce((sum, f) => {
  const p = path.join(distDir, f);
  return sum + (fs.existsSync(p) ? fs.statSync(p).size : 0);
}, 0);

const violations = [];
for (const file of closureFiles) {
  for (const { pattern, label } of FORBIDDEN_CHUNK_PATTERNS) {
    if (pattern.test(file)) {
      violations.push({ file, label, bytes: visited.get(file).bytes, via: 'chunk-name' });
      break;
    }
  }
}

// ── 🔴 N10.1 模块来源追踪（主防线）：构建模块清单按包名检出禁止库 ──
const moduleSourcesPath = path.join(distDir, '.module-sources.json');
let moduleSources = null;
if (fs.existsSync(moduleSourcesPath)) {
  moduleSources = JSON.parse(fs.readFileSync(moduleSourcesPath, 'utf8'));
} else {
  resolveErrors.push('缺少构建模块清单 dist/.module-sources.json（旧构建流程产物；请用当前 vite 配置重新 pnpm build）');
}
if (moduleSources) {
  for (const file of closureFiles) {
    const packages = moduleSources[file]?.packages ?? [];
    for (const { name, label } of FORBIDDEN_PACKAGES) {
      if (packages.includes(name)) {
        violations.push({ file, label, bytes: visited.get(file).bytes, via: `module-source:${name}` });
        break;
      }
    }
  }
}
// 去重（同一文件可能命中 chunk 名与来源两条防线）
const dedupedViolations = [];
const seenViolationFiles = new Set();
for (const v of violations) {
  if (seenViolationFiles.has(v.file)) continue;
  seenViolationFiles.add(v.file);
  dedupedViolations.push(v);
}

// ── 🔴 N10.1 字节预算：入口静态闭包硬上限 ──
const closureKiB = Math.round(totalBytes / 102.4) / 10;
const styleKiBRounded = Math.round(styleBytes / 102.4) / 10;
const budgetViolations = [];
if (closureKiB > BUDGET.initialJsKiB) {
  budgetViolations.push(`入口 JS 闭包 ${closureKiB} KiB 超出预算 ${BUDGET.initialJsKiB} KiB`);
}
if (styleKiBRounded > BUDGET.initialCssKiB) {
  budgetViolations.push(`入口 CSS ${styleKiBRounded} KiB 超出预算 ${BUDGET.initialCssKiB} KiB`);
}

const report = {
  generatedAt: new Date().toISOString(),
  mode: process.argv.includes('--check') ? 'check' : 'report',
  entryScripts: scripts,
  modulePreloads: preloads,
  stylesheets: styles,
  closure: {
    files: closureFiles.length,
    totalBytes,
    totalKiB: closureKiB,
    styleKiB: styleKiBRounded,
    fileDetails: closureFiles.map((f) => ({ file: f, bytes: visited.get(f).bytes })),
  },
  budget: {
    limitsKiB: BUDGET,
    violations: budgetViolations,
  },
  violations: dedupedViolations,
  violationBytes: dedupedViolations.reduce((sum, v) => sum + v.bytes, 0),
};

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

console.log(`入口闭包：${report.closure.files} 个 JS，共 ${report.closure.totalKiB} KiB（minified）；CSS ${report.closure.styleKiB} KiB`);
console.log(`modulepreload：${preloads.length} 个；入口脚本：${scripts.length} 个`);
console.log(`字节预算：JS ≤ ${BUDGET.initialJsKiB} KiB / CSS ≤ ${BUDGET.initialCssKiB} KiB ${budgetViolations.length === 0 ? '（达标）' : '（超限！）'}`);
if (moduleSources) {
  console.log('模块来源追踪：dist/.module-sources.json（按包名检出禁止库）');
}
if (dedupedViolations.length > 0) {
  console.log(`\n❌ 首屏闭包含 ${dedupedViolations.length} 个禁止模块（合计 ${Math.round(report.violationBytes / 1024)} KiB）：`);
  for (const v of dedupedViolations) {
    console.log(`   - ${v.file}（${v.label}，${Math.round(v.bytes / 1024)} KiB，检出方式：${v.via}）`);
  }
} else {
  console.log('✅ 首屏闭包未发现禁止的重依赖模块');
}
for (const bv of budgetViolations) {
  console.error(`❌ 预算超限：${bv}`);
}
console.log(`报告已写入 ${path.relative(rootDir, reportPath)}`);

// 🔴 R14：门禁模式下解析错误也失败关闭（入口缺失/静态边断裂/模块清单缺失）
if (resolveErrors.length > 0) {
  console.error('❌ 闭包解析失败（失败关闭）:');
  for (const err of resolveErrors) {
    console.error(`   - ${err}`);
  }
}

if (report.mode === 'check' && (dedupedViolations.length > 0 || resolveErrors.length > 0 || budgetViolations.length > 0)) {
  process.exit(1);
}
if (report.mode === 'report' && (resolveErrors.length > 0 || budgetViolations.length > 0)) {
  // 报告模式也以非零退出提示（构建产物损坏/预算超限）
  process.exit(1);
}
