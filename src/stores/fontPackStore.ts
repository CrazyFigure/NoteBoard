// NoteBoard 字体资源包运行态：负责状态校验、WebView 注册、多窗口同步与操作反馈。

import { create } from 'zustand';

import { activateFontPack, translateFontPackError } from '../app/fontPack';
import * as ipc from '../core/ipc/commands';
import {
  onFontPackChanged,
  onFontPackDownloadProgress,
} from '../core/ipc/events';
import { useSettingsStore } from './settingsStore';
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

// 🔴 R11：包代际 epoch——remove/import/download 触发递增；
//    异步激活（activateFontPack）完成时若 epoch 已变（如随后的 remove），
//    旧 ready 结果不得覆盖新状态（invalid/missing）
let packEpoch = 0;

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
    // 🔴 S06：verifying 表示后台校验中——不激活、不设错误，等待校验完成的广播
    if (status.state === 'verifying') {
      set({ status });
      return status;
    }
    // 🔴 R11：本状态到达时递增 epoch；remove/import 的状态变化自然使旧激活失效
    packEpoch += 1;
    const applyEpoch = packEpoch;
    try {
      // 传入当前排版设置：activateFontPack 只主动加载配置引用的族（按需 face）
      const typography = useSettingsStore.getState().settings.typography;
      await activateFontPack(status, typography);
      // 激活期间又有新状态（remove/import/download 的广播到达）→ 本结果丢弃
      if (packEpoch !== applyEpoch) return status;
      set({ status, error: null });
      return status;
    } catch (error) {
      if (packEpoch !== applyEpoch) return status;
      // 字体二进制通过哈希但 WebView 无法解析时按无效包处理，设置页保留修复入口。
      const invalidStatus: FontPackStatus = { ...status, state: 'invalid', faces: [] };
      set({ status: invalidStatus, error: '字体文件无法由当前 WebView 加载，请修复或重新下载字体包。' });
      throw error;
    }
  },

  refresh: async () => {
    try {
      // S06：显式修复入口走强制重验命令（generation 递增，旧任务结果作废）
      const status = await ipc.refreshFontPackStatus();
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
