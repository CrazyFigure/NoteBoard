// NoteBoard 字体资源包运行态：负责状态校验、WebView 注册、多窗口同步与操作反馈。

import { create } from 'zustand';

import { activateFontPack, translateFontPackError } from '../app/fontPack';
import * as ipc from '../core/ipc/commands';
import {
  onFontPackChanged,
  onFontPackDownloadProgress,
} from '../core/ipc/events';
import type { DownloadProgress, FontPackStatus } from '../core/ipc/types';

export type FontPackAction = 'download' | 'import' | 'remove' | '';

interface FontPackStore {
  status: FontPackStatus | null;
  initialized: boolean;
  action: FontPackAction;
  progress: DownloadProgress | null;
  error: string | null;
  init: () => Promise<void>;
  refresh: () => Promise<FontPackStatus | null>;
  download: () => Promise<FontPackStatus | null>;
  importArchive: (sourcePath: string) => Promise<FontPackStatus | null>;
  remove: () => Promise<FontPackStatus | null>;
  clearError: () => void;
  _applyStatus: (status: FontPackStatus) => Promise<FontPackStatus>;
}

// React StrictMode 可能在首次挂载阶段重复调用初始化；共享 Promise 保证监听器与 SHA 校验只建立一次。
let initializationPromise: Promise<void> | null = null;

export const useFontPackStore = create<FontPackStore>((set, get) => ({
  status: null,
  initialized: false,
  action: '',
  progress: null,
  error: null,

  init: async () => {
    if (get().initialized) return;
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
      try {
        // 下载进度与状态变化均为应用级广播；每个 WebView 独立更新自己的 FontFaceSet。
        await Promise.all([
          onFontPackDownloadProgress((progress) => set({ progress })),
          onFontPackChanged((status) => {
            get()._applyStatus(status).catch((error) => {
              if (!get().error) set({ error: translateFontPackError(error) });
            });
          }),
        ]);
        const status = await ipc.getFontPackStatus();
        await get()._applyStatus(status);
      } catch (error) {
        if (!get().error) set({ error: translateFontPackError(error) });
      } finally {
        set({ initialized: true });
      }
    })();
    return initializationPromise;
  },

  _applyStatus: async (status) => {
    try {
      await activateFontPack(status);
      set({ status, error: null });
      return status;
    } catch (error) {
      // 字体二进制通过哈希但 WebView 无法解析时按无效包处理，设置页保留修复入口。
      const invalidStatus: FontPackStatus = { ...status, state: 'invalid', faces: [] };
      set({ status: invalidStatus, error: '字体文件无法由当前 WebView 加载，请修复或重新下载字体包。' });
      throw error;
    }
  },

  refresh: async () => {
    try {
      const status = await ipc.getFontPackStatus();
      return await get()._applyStatus(status);
    } catch (error) {
      if (!get().error) set({ error: translateFontPackError(error) });
      return null;
    }
  },

  download: async () => {
    if (get().action) return null;
    set({ action: 'download', progress: null, error: null });
    try {
      const status = await ipc.downloadFontPack();
      return await get()._applyStatus(status);
    } catch (error) {
      if (!get().error) set({ error: translateFontPackError(error) });
      return null;
    } finally {
      set({ action: '' });
    }
  },

  importArchive: async (sourcePath) => {
    if (get().action) return null;
    set({ action: 'import', progress: null, error: null });
    try {
      const status = await ipc.importFontPack(sourcePath);
      return await get()._applyStatus(status);
    } catch (error) {
      if (!get().error) set({ error: translateFontPackError(error) });
      return null;
    } finally {
      set({ action: '' });
    }
  },

  remove: async () => {
    if (get().action) return null;
    set({ action: 'remove', progress: null, error: null });
    try {
      const status = await ipc.removeFontPack();
      return await get()._applyStatus(status);
    } catch (error) {
      if (!get().error) set({ error: translateFontPackError(error) });
      return null;
    } finally {
      set({ action: '' });
    }
  },

  clearError: () => set({ error: null }),
}));
