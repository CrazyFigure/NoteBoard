// NoteBoard 应用更新全局状态管理 Store
// 支持启动时与 5 分钟定时静默检测更新、红点提醒、主动检测及弹窗控制

import { create } from 'zustand';
import type { UpdateCheckResult } from '../core/ipc/types';
import * as ipc from '../core/ipc/commands';
import { translateUpdateCheckError } from '../core/updates';
import { IS_WEB } from '../core/platform';
import { RELEASE_CHANNELS, alternateUpdateChannel, currentUpdateChannel } from '../core/releaseChannel';
import { useSettingsStore } from './settingsStore';

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

/** 自动检查更新开关：旧设置缺字段时视为开启 */
function autoCheckEnabled(): boolean {
  return useSettingsStore.getState().settings.system?.autoCheckUpdate !== false;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  checking: false,
  hasUpdate: false,
  updateResult: null,
  checkError: null,
  modalOpen: false,

  checkForUpdates: async (silent = false) => {
    // 若当前正在检查中，避免重复请求
    if (get().checking) return;
    // 弹窗打开期间跳过静默检查：否则弹窗会闪回"检查中"状态，并重置用户展开的版本日志与下载进度
    if (silent && get().modalOpen) return;

    try {
      set({
        checking: true,
        checkError: null,
        // 主动检测时立即打开弹窗并清空旧结果，静默检测则保持现有弹窗状态
        ...(silent ? {} : { modalOpen: true, updateResult: null }),
      });

      // 优先探测用户所选渠道（首次安装默认 GitHub），不通时才尝试另一个；
      // 只有另一个渠道探测成功才切换设置，两者均失败时保留原设置。
      const preferred = currentUpdateChannel();
      const errors: string[] = [];
      for (const channel of [preferred, alternateUpdateChannel(preferred)]) {
        let result: UpdateCheckResult;
        try {
          result = await ipc.checkForUpdates(channel);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const label = RELEASE_CHANNELS[channel].label;
          errors.push(`${label}：${translateUpdateCheckError(msg, label)}`);
          continue;
        }

        // 备用渠道返回有效结果即代表其可用，即使没有新版本也同步保存，后续下载统一使用该渠道；
        // 探测期间用户已手动改选渠道时尊重用户选择，不覆盖。
        if (channel !== preferred && currentUpdateChannel() === preferred) {
          await useSettingsStore.getState().setSystem({ updateChannel: channel });
        }
        set({ updateResult: result, hasUpdate: Boolean(result.updateAvailable) });
        return;
      }

      // 两个渠道均失败后才提示，静默检测保持不打扰用户。
      if (!silent) set({ checkError: errors.join('\n') });
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
    // 网页由部署者更新镜像，访问者不能触发服务器安装桌面程序。
    if (IS_WEB) return () => {};
    // 定时器常驻，触发时才读开关：关闭后跳过，重新开启后下一轮即恢复，无需重建定时器
    const tick = () => {
      if (autoCheckEnabled()) void get().checkForUpdates(true);
    };
    // 1. 启动时延时 3 秒执行首次静默检查，避开应用冷启动高负载
    const initialTimer = setTimeout(tick, 3000);

    // 2. 注册每隔 5 分钟的定时静默检查任务
    const intervalTimer = setInterval(tick, AUTO_CHECK_INTERVAL_MS);

    // 返回清理函数
    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  },
}));
