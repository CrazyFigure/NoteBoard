// NoteBoard 窗口标题同步
// 将当前打开文件名同步到各端窗口标题（Windows 任务栏按钮与预览窗口、macOS 窗口菜单/程序坞、Linux 任务栏、网页浏览器标签页）。

import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IS_NATIVE_MOBILE, IS_WEB } from '../../core/platform';

declare const __NB_DEV_MOCK__: boolean | undefined;

// 开发态桌面窗口保留 Dev 后缀，避免调试实例与正式安装版在任务栏和切换器中混淆
export const BASE_WINDOW_TITLE =
  typeof __NB_DEV_MOCK__ !== 'undefined' && __NB_DEV_MOCK__ && !IS_WEB
    ? 'NoteBoard Dev'
    : 'NoteBoard';

/** 按当前活动文件名生成窗口标题：文件名置前便于任务栏窄按钮直接识别，无活动文件时回退应用名 */
export function formatWindowTitle(fileName?: string | null, appTitle = BASE_WINDOW_TITLE): string {
  return fileName && fileName.trim().length > 0 ? `${fileName} - ${appTitle}` : appTitle;
}

/** 安全同步当前窗口或网页标题；测试环境缺失原生窗口注入或平台不支持时静默跳过 */
export function syncCurrentWindowTitle(title: string): void {
  // 原生移动端为单 Activity 全屏壳，无需向宿主重复下发窗口标题
  if (IS_NATIVE_MOBILE) return;
  try {
    const currentWindow = getCurrentWindow();
    if (typeof currentWindow?.setTitle !== 'function') return;
    void Promise.resolve(currentWindow.setTitle(title)).catch(() => {});
  } catch {
    // 单测 jsdom 未注入 __TAURI_INTERNALS__ 时安全忽略
  }
}

/** 订阅当前活动文件名变化并同步更新窗口标题 */
export function useWindowTitleSync(fileName?: string | null): void {
  const title = formatWindowTitle(fileName);
  const lastTitleRef = useRef<string | null>(null);

  useEffect(() => {
    // 标题未变化时不重复发起 IPC，避免打断其他临时标题逻辑（如网页打印对话框）
    if (lastTitleRef.current === title) return;
    lastTitleRef.current = title;
    syncCurrentWindowTitle(title);
  }, [title]);
}
