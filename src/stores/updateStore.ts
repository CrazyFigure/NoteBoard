// NoteBoard 应用更新全局状态管理 Store
// 支持启动时与 5 分钟定时静默检测更新、红点提醒、主动检测及弹窗控制

import { create } from 'zustand';
import type { UpdateCheckResult } from '../core/ipc/types';
import * as ipc from '../core/ipc/commands';
import { translateUpdateCheckError } from '../core/updates';

interface UpdateStore {
  /** 是否正在执行更新检查 */
  checking: boolean;
  /** 是否存在可用新版本（用于在标题栏更新图标上显示小红点） */
  hasUpdate: boolean;
  /** 最新一次检查结果 */
  updateResult: UpdateCheckResult | null;
  /** 检查更新失败时的中文错误描述 */
  checkError: string | null;
  /** 更新模态弹窗是否打开 */
  modalOpen: boolean;

  /**
   * 检查应用更新
   * @param silent 是否为静默检查（启动或定时触发时为 true，不主动弹窗；用户主动点击时为 false）
   */
  checkForUpdates: (silent?: boolean) => Promise<void>;

  /** 打开更新弹窗 */
  openModal: () => void;

  /** 关闭更新弹窗 */
  closeModal: () => void;

  /** 初始化启动检测与 5 分钟定时自动轮询任务 */
  initAutoUpdateTimer: () => () => void;
}

// 自动检测轮询间隔：5 分钟（毫秒）
const AUTO_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  checking: false,
  hasUpdate: false,
  updateResult: null,
  checkError: null,
  modalOpen: false,

  checkForUpdates: async (silent = false) => {
    // 若当前正在检查中，避免重复请求
    if (get().checking) return;

    try {
      set({
        checking: true,
        checkError: null,
        // 主动检测时立即打开弹窗并清空旧结果，静默检测则保持现有弹窗状态
        ...(silent ? {} : { modalOpen: true, updateResult: null }),
      });

      // 调用后端 IPC 接口请求 GitHub Release
      const result = await ipc.checkForUpdates();

      set({
        updateResult: result,
        hasUpdate: Boolean(result.updateAvailable),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendlyError = translateUpdateCheckError(msg);

      // 主动检查时记录错误展示给用户，静默检查时不打扰用户
      if (!silent) {
        set({ checkError: friendlyError });
      }
    } finally {
      set({ checking: false });
    }
  },

  openModal: () => {
    set({ modalOpen: true });
  },

  closeModal: () => {
    set({ modalOpen: false });
  },

  initAutoUpdateTimer: () => {
    // 1. 启动时延时 3 秒执行首次静默检查，避开应用冷启动高负载
    const initialTimer = setTimeout(() => {
      get().checkForUpdates(true);
    }, 3000);

    // 2. 注册每隔 5 分钟的定时静默检查任务
    const intervalTimer = setInterval(() => {
      get().checkForUpdates(true);
    }, AUTO_CHECK_INTERVAL_MS);

    // 返回清理函数
    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  },
}));
