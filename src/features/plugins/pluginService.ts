// 插件 IPC 与模块加载只在设置页或对应查看器打开后执行。
import { invoke } from '@tauri-apps/api/core';
import type { InstalledPlugin, PluginCatalog, PluginId, PluginModule, PluginPackage } from './pluginTypes';

/** 所有端使用同一操作协议，网页运行时转发到部署实例。 */
export function pluginCommand<T>(operation: string, id?: PluginId, enabled?: boolean): Promise<T> {
  return invoke<T>('plugin_command', { operation, id: id ?? null, enabled: enabled ?? null });
}
export const listPlugins = () => pluginCommand<InstalledPlugin[]>('list');
export const fetchPluginCatalog = () => pluginCommand<PluginCatalog>('catalog');

// 版本是缓存键的一部分；不把重库引入首屏，仅保留各插件的当前模块引用。
const modules = new Map<string, Promise<PluginModule>>();

/** 只加载后端已验证且已启用的官方插件；失败条目允许重试。 */
export async function loadPlugin(id: PluginId, expectedVersion?: string): Promise<PluginModule> {
  // 宿主已根据当前启用状态决定加载；同版本多文档复用模块，不重复传输大型 WASM 包。
  const cached = expectedVersion && modules.get(`${id}@${expectedVersion}`);
  if (cached) return cached;
  const pkg = await pluginCommand<PluginPackage>('load', id);
  if (pkg.manifest.id !== id || pkg.manifest.apiVersion !== 1) throw new Error('插件协议不兼容');
  const key = `${id}@${pkg.manifest.version}`;
  for (const cached of modules.keys()) if (cached.startsWith(`${id}@`) && cached !== key) modules.delete(cached);
  const prior = modules.get(key);
  if (prior) return prior;
  const pending = (async () => {
    const url = URL.createObjectURL(new Blob([pkg.code], { type: 'text/javascript' }));
    try {
      const module = await import(/* @vite-ignore */ url) as PluginModule;
      if (typeof module.mount !== 'function') throw new Error('插件入口无效');
      return module;
    } finally { URL.revokeObjectURL(url); }
  })();
  modules.set(key, pending);
  pending.catch(() => { if (modules.get(key) === pending) modules.delete(key); });
  return pending;
}
