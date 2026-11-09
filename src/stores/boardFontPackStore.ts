// 画板手写字体包（小赖）运行态：状态查询、下载/卸载与多窗口同步。
// 字体面的注册与 Excalidraw 资源路径由 src/features/board/excalidrawAssetPath.ts 负责。

import { create } from 'zustand';

import { translateFontPackError } from '../app/fontPack';
import * as ipc from '../core/ipc/commands';
import { onBoardFontPackChanged, onBoardFontPackDownloadProgress } from '../core/ipc/events';
import { IS_WEB } from '../core/platform';
import type { BoardFontPackStatus, DownloadProgress } from '../core/ipc/types';

type BoardFontPackAction = 'download' | 'remove' | '';

interface BoardFontPackStore {
  status: BoardFontPackStatus | null;
  action: BoardFontPackAction;
  progress: DownloadProgress | null;
  error: string | null;
  /** 首次调用时查询状态并订阅广播；重复调用复用同一次查询 */
  ensureStatus: () => Promise<BoardFontPackStatus | null>;
  download: () => Promise<BoardFontPackStatus | null>;
  remove: () => Promise<BoardFontPackStatus | null>;
}

// 多个画板与设置页可能同时触发首次查询，共享 Promise 保证只校验一次、只订阅一次。
let statusPromise: Promise<BoardFontPackStatus | null> | null = null;

export const useBoardFontPackStore = create<BoardFontPackStore>((set, get) => ({
  status: null,
  action: '',
  progress: null,
  error: null,

  ensureStatus: () => {
    // 网页版小赖随前端内置，不存在可下载的包
    if (IS_WEB) return Promise.resolve(null);
    if (statusPromise) return statusPromise;
    statusPromise = (async () => {
      try {
        await Promise.all([
          onBoardFontPackDownloadProgress((progress) => set({ progress })),
          onBoardFontPackChanged((status) => set({ status })),
        ]);
        const status = await ipc.getBoardFontPackStatus();
        set({ status });
        return status;
      } catch (error) {
        set({ error: translateFontPackError(error) });
        return null;
      }
    })();
    return statusPromise;
  },

  download: async () => {
    if (get().action) return null;
    set({ action: 'download', progress: null, error: null });
    try {
      const status = await ipc.downloadBoardFontPack();
      set({ status });
      return status;
    } catch (error) {
      set({ error: translateFontPackError(error) });
      return null;
    } finally {
      set({ action: '' });
    }
  },

  remove: async () => {
    if (get().action) return null;
    set({ action: 'remove', progress: null, error: null });
    try {
      const status = await ipc.removeBoardFontPack();
      set({ status });
      return status;
    } catch (error) {
      set({ error: translateFontPackError(error) });
      return null;
    } finally {
      set({ action: '' });
    }
  },
}));
