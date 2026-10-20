// 插件状态按 WebView 维护，实际安装状态由原生层或网页服务持久化。
import { create } from 'zustand';
import { emit, listen } from '@tauri-apps/api/event';
import { fetchPluginCatalog, listPlugins, pluginCommand } from '../features/plugins/pluginService';
import type { CatalogPlugin, InstalledPlugin, PluginId } from '../features/plugins/pluginTypes';

interface PluginStore {
  installed: InstalledPlugin[];
  catalog: CatalogPlugin[];
  initialized: boolean;
  busy: string;
  error: string | null;
  refresh: () => Promise<void>;
  check: () => Promise<void>;
  act: (operation: 'install' | 'toggle' | 'remove', id: PluginId, enabled?: boolean) => Promise<void>;
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  installed: [], catalog: [], initialized: false, busy: '', error: null,
  refresh: async () => {
    try { set({ installed: await listPlugins(), initialized: true }); }
    catch (error) { set({ initialized: true, error: String(error) }); }
  },
  check: async () => {
    if (get().busy) return;
    set({ busy: 'catalog', error: null });
    try { set({ catalog: (await fetchPluginCatalog()).plugins }); }
    catch (error) { set({ error: String(error) }); }
    finally { set({ busy: '' }); }
  },
  act: async (operation, id, enabled) => {
    if (get().busy) return;
    set({ busy: `${operation}:${id}`, error: null });
    try {
      await pluginCommand(operation, id, enabled);
      await get().refresh();
      await emit('nb://plugins-changed');
    } catch (error) { set({ error: String(error) }); }
    finally { set({ busy: '' }); }
  },
}));

let initialization: Promise<void> | undefined;
/** 安装状态变动广播到其它窗口，重新获得焦点时也校对共享网页实例。 */
export function initializePlugins(): Promise<void> {
  if (!initialization) initialization = (async () => {
    await listen('nb://plugins-changed', () => void usePluginStore.getState().refresh());
    window.addEventListener('focus', () => void usePluginStore.getState().refresh());
    await usePluginStore.getState().refresh();
  })().catch((error) => { initialization = undefined; throw error; });
  return initialization;
}
