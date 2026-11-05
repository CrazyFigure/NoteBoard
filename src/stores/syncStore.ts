// NoteBoard 多端同步 Store
// 同步与备份在 Rust 后台线程中执行；这里只缓存配置与运行状态、监听结果事件并弹出提示。
// 同步与备份结果共用一个提示分组，连续出现多条时只展示最新一条。

import { create } from 'zustand';
import type { BackupReport, SyncConfigFile, SyncReport, SyncReportEvent, SyncStatus } from '../core/ipc/types';
import * as ipc from '../core/ipc/commands';
import { onSyncConfigChanged, onSyncReport, onSyncStatus } from '../core/ipc/events';
import { joinPath } from '../features/explorer/pathUtils';
import { showToast } from './toastStore';
import { IS_WEB } from '../core/platform';

/** 同步类提示的分组键 */
export const SYNC_TOAST_KEY = 'sync';
/** 同步目录下回收站目录名 */
export const SYNC_TRASH_DIR = '.nb-trash';

interface SyncStore {
  config: SyncConfigFile | null;
  status: SyncStatus | null;
  initialized: boolean;
  /** 网页未配置访问认证或同步进程不可用时，展示明确原因而非一直加载。 */
  unavailableReason: string | null;
  /** 回收站弹窗 */
  trashOpen: boolean;
  init: () => Promise<void>;
  /** 保存配置（Rust 端校正后回填） */
  saveConfig: (next: SyncConfigFile) => Promise<SyncConfigFile>;
  setTrashOpen: (open: boolean) => void;
}

/** 生成同步结果提示文本 */
export function describeSyncReport(report: SyncReport): string {
  if (!report.ok) return report.message || '同步失败';
  if (report.errors.length > 0) return `${report.message}：${report.errors[0]}`;
  return report.message;
}

function toastForReport(event: SyncReportEvent): void {
  if (!event.notify) return;
  if (event.kind === 'sync') {
    const report = event.report as SyncReport;
    const type = !report.ok ? 'error' : report.errors.length > 0 ? 'warning' : 'success';
    showToast(describeSyncReport(report), type, report.ok && report.errors.length === 0 ? 4000 : 8000, SYNC_TOAST_KEY);
  } else {
    const report = event.report as BackupReport;
    showToast(report.message, report.ok ? 'success' : 'error', report.ok ? 4000 : 8000, SYNC_TOAST_KEY);
  }
}

let subscribed = false;
// 初始化快照可能晚于实时事件返回，不能让旧快照清掉刚收到的文件更新确认。
let statusGeneration = 0;

export const useSyncStore = create<SyncStore>((set, get) => ({
  config: null,
  status: null,
  initialized: false,
  unavailableReason: null,
  trashOpen: false,

  init: async () => {
    // 未启用部署访问认证时不请求凭证接口，公开访客仍可使用共享笔记。
    if (IS_WEB && !(await import('../web/runtime')).canUseWebSync()) {
      // 多用户部署中同步凭证可访问服务器所在网络，仅管理员可用。
      const { isMultiUser, isAdmin } = await import('../features/account/accountState');
      set({ initialized: true, unavailableReason: isMultiUser() && !isAdmin() ? '多端同步仅管理员可用。' : '网页同步需要设置部署访问账号密码，并使用包含同步引擎的镜像。' });
      return;
    }
    if (get().initialized) return;
    set({ initialized: true });
    if (!subscribed) {
      subscribed = true;
      void onSyncStatus((status) => { statusGeneration += 1; set({ status }); });
      void onSyncConfigChanged((config) => set({ config }));
      void onSyncReport(toastForReport);
    }
    try {
      const generation = statusGeneration;
      const [config, status] = await Promise.all([ipc.syncGetConfig(), ipc.syncGetStatus()]);
      set({ config, ...(generation === statusGeneration ? { status } : {}) });
    } catch (error) {
      console.error('加载同步配置失败:', error);
    }
  },

  saveConfig: async (next) => {
    // 乐观更新，界面输入不等待磁盘写入
    set({ config: next });
    const saved = await ipc.syncSaveConfig(next);
    set({ config: saved });
    return saved;
  },

  setTrashOpen: (trashOpen) => set({ trashOpen }),
}));

/** 当前同步目录下回收站的绝对路径（未设置同步目录返回 null） */
export function syncTrashPath(config: SyncConfigFile | null): string | null {
  const root = config?.sync.rootDir?.trim();
  if (!root) return null;
  return joinPath(root, SYNC_TRASH_DIR);
}
