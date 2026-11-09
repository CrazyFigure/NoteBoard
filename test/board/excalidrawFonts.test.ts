// @vitest-environment node
// 画板字体本地化守护：Excalidraw 升级后若字体地址写法变化，本地字体或 esm.sh 回退抑制会静默失效。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';

import viteConfig from '../../vite.config';

const require = createRequire(import.meta.url);
const excalidrawDist = path.dirname(path.dirname(require.resolve('@excalidraw/excalidraw')));

/** 取出字体插件（配置为函数形式，按生产构建参数求值） */
const getFontsPlugin = (): Plugin => {
  const resolved = typeof viteConfig === 'function'
    ? viteConfig({ command: 'build', mode: 'production', isSsrBuild: false, isPreview: false })
    : viteConfig;
  const plugin = (resolved as { plugins: unknown[] }).plugins
    .flat()
    .find((item) => (item as Plugin | null)?.name === 'noteboard-excalidraw-fonts');
  if (!plugin) throw new Error('未找到 noteboard-excalidraw-fonts 插件');
  return plugin as Plugin;
};

/** 找出包含字体地址构造逻辑的 Excalidraw 产物文件 */
const findFontChunk = (dir: string) => {
  const name = fs.readdirSync(dir).find((file) => file.endsWith('.js')
    && fs.readFileSync(path.join(dir, file), 'utf8').includes('ASSETS_FALLBACK_URL'));
  if (!name) throw new Error(`${dir} 中未找到 ASSETS_FALLBACK_URL`);
  return path.join(dir, name);
};

describe('Excalidraw 画布字体本地化', () => {
  it('包内仍提供 Excalifont 与小赖分片字体', () => {
    const fontsDir = path.join(excalidrawDist, 'prod', 'fonts');
    expect(fs.readdirSync(path.join(fontsDir, 'Excalifont')).some((file) => file.endsWith('.woff2'))).toBe(true);
    expect(fs.readdirSync(path.join(fontsDir, 'Xiaolai')).length).toBeGreaterThan(100);
  });

  it.each(['prod', 'dev'])('%s 产物中的 esm.sh 回退仅在未配置本地路径时追加', (flavor) => {
    const file = findFontChunk(path.join(excalidrawDist, flavor));
    const transform = getFontsPlugin().transform as (code: string, id: string) => { code: string } | null;
    const result = transform(fs.readFileSync(file, 'utf8'), file);
    expect(result).not.toBeNull();
    // 唯一一处回退 push 必须被本地地址长度短路
    expect(result!.code.match(/\.push\(new URL\([\w$]+,\s*[\w$]+\.ASSETS_FALLBACK_URL\)\)/g)).toHaveLength(1);
    expect(result!.code).toMatch(/([\w$]+)\.length\|\|\1\.push\(new URL\([\w$]+,[\w$]+\.ASSETS_FALLBACK_URL\)\)/);
  });
});
