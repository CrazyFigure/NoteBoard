// NoteBoard 全局导出结果弹窗 Store
// 所有导出功能（图表、PDF、画板、思维导图、绘图、多维表格）统一在完成后弹出结果窗：
// 成功时可直接在本软件打开导出文件、在文件管理器中定位，失败时展示原因。
// 由 components/ExportResultDialogHost 统一渲染，桌面端与移动端 Shell 各挂载一份。

import { create } from 'zustand';
import { showToast } from './toastStore';

/** 导出写盘结果 */
export interface ExportedFile {
  /**
   * 导出文件的磁盘路径
   * 浏览器下载、安卓 content URI 等拿不到可操作磁盘路径时为 null
   */
  path: string | null;
  /** 导出文件名（含扩展名） */
  fileName: string;
}

export type ExportResultRequest =
  | { id: number; status: 'success'; title: string; path: string; fileName: string }
  | { id: number; status: 'error'; title: string; message: string };

/** 新请求的分布式省略类型：去掉自增 id */
type ExportResultInput =
  | Omit<Extract<ExportResultRequest, { status: 'success' }>, 'id'>
  | Omit<Extract<ExportResultRequest, { status: 'error' }>, 'id'>;

interface ExportResultStore {
  request: ExportResultRequest | null;
  open: (request: ExportResultInput) => void;
  close: () => void;
}

let seq = 0;

export const useExportResultStore = create<ExportResultStore>((set) => ({
  request: null,
  // 同一时间只展示最近一次导出结果，新结果直接顶替旧弹窗
  open: (request) => set({ request: { ...request, id: ++seq } as ExportResultRequest }),
  close: () => set({ request: null }),
}));

/** 从路径中取文件名，兼容 Windows 与 POSIX 分隔符 */
function baseNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** 把任意异常整理成可读文案 */
function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return '未知错误';
}

/**
 * 导出成功后展示结果
 * - 有磁盘路径：弹出结果窗，提供「打开文件 / 在文件夹中显示 / 关闭」
 * - 无磁盘路径（浏览器下载、安卓 URI）：没有可执行的后续操作，退回轻量 Toast
 * @param title 结果标题，如「已导出 PNG 图片」
 */
export function showExportSuccess(file: ExportedFile, title: string): void {
  if (!file.path) {
    showToast(title, 'success');
    return;
  }
  useExportResultStore.getState().open({
    status: 'success',
    title,
    path: file.path,
    fileName: file.fileName || baseNameOf(file.path),
  });
}

/**
 * 导出失败后展示原因
 * @param title 失败标题，如「导出 CSV 失败」
 */
export function showExportError(error: unknown, title = '导出失败'): void {
  useExportResultStore.getState().open({ status: 'error', title, message: errorMessageOf(error) });
}
