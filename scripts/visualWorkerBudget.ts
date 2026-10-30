// 后台解析必须保持独立：检查整个 Worker 输出，而非只看入口文件或压缩后的名称。
import type { Plugin } from 'vite';
import type { OutputBundle } from 'rollup';

/** 正式构建实测约 566 kB，留约 24% 余量；原始字节预算避免压缩率掩盖依赖回流。 */
export const VISUAL_WORKER_MAX_BYTES = 700_000;

/** 图表渲染、界面与原生调用均不属于 Markdown 解析内核。 */
const FORBIDDEN_PACKAGES = new Set([
  'react', 'react-dom', '@tiptap/react', 'lucide-react', 'mermaid', '@mermaid-js/parser',
  'katex', '@excalidraw/excalidraw', 'cytoscape', 'lowlight', 'highlight.js',
]);

/** 汇总所有静态/动态分包与资源，并按真实模块来源识别不允许的依赖。 */
export function inspectVisualWorker(bundle: OutputBundle, moduleIds: Iterable<string>) {
  const forbidden = new Set<string>();
  for (const id of moduleIds) {
    const normalized = id.replaceAll('\\', '/');
    // pnpm 布局中使用最后一段 node_modules，避免把 .pnpm 当作包名。
    const matches = [...normalized.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
    const name = matches.at(-1)?.[1];
    if (name && (FORBIDDEN_PACKAGES.has(name) || name.startsWith('@tauri-apps/'))) forbidden.add(name);
    if (/\/src\/(?:stores|components)\//.test(normalized) || /\/src\/web\/runtime\.ts$/.test(normalized)) {
      forbidden.add(normalized.slice(normalized.lastIndexOf('/src/') + 1));
    }
  }
  // 字体、图片等间接资源也占安装包空间，不能只限制 JS 主文件。
  const files = Object.values(bundle).map((item) => ({
    file: item.fileName,
    bytes: Buffer.byteLength(item.type === 'chunk' ? item.code : item.source),
  }));
  return { files, bytes: files.reduce((sum, file) => sum + file.bytes, 0), forbidden: [...forbidden].sort() };
}

/** 在实际 Worker 构建中执行，依赖违规或超预算时阻止后续原生打包和发布。 */
export function visualWorkerBudgetPlugin(): Plugin {
  return {
    name: 'noteboard-visual-worker-budget',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const visualWorker = Object.values(bundle).some((item) => item.type === 'chunk'
          && item.isEntry && item.facadeModuleId?.replaceAll('\\', '/').endsWith('/visualPreparation.worker.ts'));
        if (!visualWorker) return;
        const report = inspectVisualWorker(bundle, this.getModuleIds());
        if (report.forbidden.length) this.error(`后台解析引入了界面或渲染依赖：${report.forbidden.join('、')}`);
        if (report.bytes > VISUAL_WORKER_MAX_BYTES) {
          this.error(`后台解析资源 ${report.bytes} 字节，超过预算 ${VISUAL_WORKER_MAX_BYTES} 字节`);
        }
        this.emitFile({ type: 'asset', fileName: '.visual-worker-budget.json', source: JSON.stringify(report, null, 2) });
      },
    },
  };
}
