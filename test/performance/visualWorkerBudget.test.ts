// 构建门禁按模块来源检查所有分包，防止改名或动态导入绕过限制。
import { expect, it } from 'vitest';
import type { Rollup } from 'vite';
import { inspectVisualWorker, visualWorkerBudgetPlugin, VISUAL_WORKER_MAX_BYTES } from '../../scripts/visualWorkerBudget';

/** 提供门禁实际读取的最小输出；模拟的分包名故意不包含任何库名。 */
function output(bytes = 100): Rollup.OutputBundle {
  return {
    'entry.js': { type: 'chunk', fileName: 'entry.js', isEntry: true, facadeModuleId: '/src/visualPreparation.worker.ts', code: 'x'.repeat(bytes) },
    'extra.js': { type: 'chunk', fileName: 'extra.js', code: '动态加载的资源' },
    'font.bin': { type: 'asset', fileName: 'font.bin', source: new Uint8Array(50) },
  } as unknown as Rollup.OutputBundle;
}

it('分包改名、pnpm 路径和 Windows 路径均按真实来源拦截', () => {
  const report = inspectVisualWorker(output(), [
    'C:\\repo\\node_modules\\.pnpm\\react-dom@19\\node_modules\\react-dom\\index.js',
    '/repo/node_modules/mermaid/dist/diagram.js', '/repo/src/stores/settingsStore.ts',
    '/repo/node_modules/@tauri-apps/api/core.js',
  ]);
  expect(report.forbidden).toEqual(['@tauri-apps/api', 'mermaid', 'react-dom', 'src/stores/settingsStore.ts']);
  expect(report.bytes).toBe(100 + Buffer.byteLength('动态加载的资源') + 50);
});

it('允许解析内核，拒绝完整资源总量超预算的实际构建', () => {
  expect(inspectVisualWorker(output(), ['/repo/node_modules/@tiptap/core/index.js']).forbidden).toEqual([]);
  const hook = visualWorkerBudgetPlugin().generateBundle;
  if (!hook || typeof hook === 'function') throw new Error('预算检查必须在产物生成后执行');
  const context = { getModuleIds: () => [], error: (message: string) => { throw new Error(message); } };
  expect(() => hook.handler.call(context as never, {} as never, output(VISUAL_WORKER_MAX_BYTES), false)).toThrow('超过预算');
});
