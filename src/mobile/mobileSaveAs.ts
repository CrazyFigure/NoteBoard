// NoteBoard 移动端"另存为"命名流程
// 系统保存对话框在 Android 上返回 content:// URI，无法按路径写盘与注册文档身份；
// 移动端改为在当前浏览的文件夹中由用户命名，返回真实路径交给 saveAs 事务继续执行。

import { create } from 'zustand';
import { joinPath } from '../features/explorer/pathUtils';
import type { SaveAsPathPicker } from '../features/editor-code/orchestration/saveDocument';
import { useMobileStore } from './mobileStore';

interface SaveAsRequest {
  defaultName: string;
  folder: string;
  resolve: (path: string | null) => void;
}

interface SaveAsState {
  request: SaveAsRequest | null;
  setRequest: (request: SaveAsRequest | null) => void;
}

export const useMobileSaveAsStore = create<SaveAsState>((set) => ({
  request: null,
  setRequest: (request) => set({ request }),
}));

/** 生成保存目标文件夹：当前浏览文件夹，未初始化时回退默认工作区 */
function targetFolder(): string {
  const { currentFolder, platform } = useMobileStore.getState();
  return currentFolder || platform?.defaultWorkspace || '';
}

/** 注册到 saveDocument 的路径选择器：弹出命名对话框，确认后返回绝对路径 */
export const mobileSaveAsPicker: SaveAsPathPicker = ({ defaultName, defaultExtension }) =>
  new Promise((resolve) => {
    // 已有未完成请求时先取消旧请求，避免悬挂的 Promise
    useMobileSaveAsStore.getState().request?.resolve(null);
    const name = defaultName.includes('.') ? defaultName : `${defaultName}.${defaultExtension}`;
    useMobileSaveAsStore.getState().setRequest({
      defaultName: name,
      folder: targetFolder(),
      resolve,
    });
  });

/** 对话框确认：补齐扩展名后拼出完整路径 */
export function resolveSaveAs(name: string): void {
  const request = useMobileSaveAsStore.getState().request;
  if (!request) return;
  useMobileSaveAsStore.getState().setRequest(null);
  request.resolve(joinPath(request.folder, name));
}

/** 对话框取消 */
export function cancelSaveAs(): void {
  const request = useMobileSaveAsStore.getState().request;
  if (!request) return;
  useMobileSaveAsStore.getState().setRequest(null);
  request.resolve(null);
}
