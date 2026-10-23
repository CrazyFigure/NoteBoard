// NoteBoard 文档历史记录：文档生命周期通知
// 单独成文件只依赖 IPC 封装，供窗口状态等底层模块调用而不引入循环依赖

import * as ipc from '../../core/ipc/commands';

/** 关闭文档后封口当前版本（合并窗口结束）；失败不影响关闭 */
export function notifyHistoryDocumentClosed(path: string | null | undefined): void {
  if (!path) return;
  void Promise.resolve()
    .then(() => ipc.historyCheckpoint(path, 'close'))
    .catch(() => {});
}
