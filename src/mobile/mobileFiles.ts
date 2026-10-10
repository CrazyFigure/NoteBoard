// NoteBoard 移动端文件操作
// 浏览文件夹、打开/新建/重命名/删除/导入/分享。打开文档统一走 openDocument，
// 重命名与删除后与桌面资源管理器相同地同步已打开的文档与标签。

import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import * as ipc from '../core/ipc/commands';
import type { FileTreeNode } from '../core/ipc/types';
import { openDocument } from '../features/editor-code/orchestration/openDocument';
import { markOpenDocumentDeleted } from '../features/external/missingFileGuard';
import { basenameOf, dirnameOf, isSubPath, joinPath, sameKey } from '../features/explorer/pathUtils';
import { useDocumentStore } from '../stores/documentStore';
import { useWindowStore } from '../stores/windowStore';
import { showToast } from '../stores/toastStore';
import { syncTrashPath, useSyncStore } from '../stores/syncStore';
import { rememberLocation, useMobileStore, type StorageLocation } from './mobileStore';

// 文件名非法字符（取 Windows 与 Android 的并集，保证跨设备同步时也合法）
const INVALID_NAME_PATTERN = /[\\/:*?"<>|\n\r\t]/;

/** 把异常统一转为可读消息 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '操作失败';
}

/** 校验文件名，返回错误提示（合法返回 null） */
export function validateFileName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '名称不能为空';
  if (trimmed === '.' || trimmed === '..') return '名称不合法';
  if (INVALID_NAME_PATTERN.test(trimmed)) return '名称不能包含 \\ / : * ? " < > | 等字符';
  return null;
}

/** 列表排序：文件夹在前，其余按名称自然排序 */
function sortEntries(entries: FileTreeNode[]): FileTreeNode[] {
  // 同步回收站固定排在最后
  const trash = syncTrashPath(useSyncStore.getState().config);
  const isTrash = (node: FileTreeNode) => trash !== null && node.isDir && sameKey(node.path, trash);
  return [...entries].sort((left, right) => {
    if (isTrash(left) !== isTrash(right)) return isTrash(left) ? 1 : -1;
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
    return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
}

/** 加载指定文件夹到列表（失败时保留错误信息供界面展示） */
export async function loadFolder(folder: string): Promise<void> {
  const store = useMobileStore.getState();
  store.setLoading(true);
  store.setListError(null);
  try {
    const nodes = await ipc.readDir(folder, false);
    useMobileStore.getState().setCurrentFolder(folder);
    useMobileStore.getState().setEntries(sortEntries(nodes));
    rememberLocation(useMobileStore.getState().location, folder);
  } catch (error) {
    useMobileStore.getState().setListError(errorMessage(error));
    useMobileStore.getState().setEntries([]);
    useMobileStore.getState().setCurrentFolder(folder);
  } finally {
    useMobileStore.getState().setLoading(false);
  }
}

/** 刷新当前文件夹 */
export async function refreshCurrentFolder(): Promise<void> {
  const folder = useMobileStore.getState().currentFolder;
  if (folder) await loadFolder(folder);
}

/** 返回上一级（不越过当前存储位置的根目录）；已在根目录返回 false */
export async function navigateUp(): Promise<boolean> {
  const { currentFolder, locationRoot } = useMobileStore.getState();
  if (!currentFolder || sameKey(currentFolder, locationRoot)) return false;
  const parent = dirnameOf(currentFolder);
  if (!parent || !isSubPath(locationRoot, parent)) return false;
  await loadFolder(parent);
  return true;
}

/** 切换存储位置（手机存储需要所有文件访问权限，由调用方先确认） */
export async function switchLocation(location: StorageLocation, preferredFolder?: string | null): Promise<void> {
  const platform = useMobileStore.getState().platform;
  if (!platform) return;
  const root = location === 'device' ? platform.externalRoot : platform.defaultWorkspace;
  if (!root) {
    showToast(location === 'device' ? '无法获取手机存储位置' : '无法获取工作区位置', 'error');
    return;
  }
  useMobileStore.getState().setLocation(location, root);
  // 记住的文件夹必须仍位于该存储位置下
  const folder = preferredFolder && isSubPath(root, preferredFolder) ? preferredFolder : root;
  await loadFolder(folder);
}

/** 打开多端同步文件夹：按其所在存储位置（我的笔记 / 手机存储）切换后进入 */
export async function openSyncFolderOnMobile(): Promise<void> {
  const root = useSyncStore.getState().config?.sync.rootDir?.trim();
  const platform = useMobileStore.getState().platform;
  if (!root || !platform) {
    showToast('尚未设置同步文件夹，请在 设置 → 同步与备份 中选择', 'warning', 5000);
    return;
  }
  if (platform.defaultWorkspace && isSubPath(platform.defaultWorkspace, root)) {
    await switchLocation('workspace', root);
    return;
  }
  if (platform.externalRoot && isSubPath(platform.externalRoot, root)) {
    if (!platform.allFilesAccess) {
      showToast('同步文件夹位于手机存储，需要先授予「所有文件访问权限」', 'warning', 5000);
      return;
    }
    await switchLocation('device', root);
    return;
  }
  // 其他位置（应用无法归入两个存储位置）：直接载入
  await loadFolder(root);
}

/** 打开文件或进入文件夹 */
export async function openEntry(node: FileTreeNode): Promise<void> {
  if (node.isDir) {
    await loadFolder(node.path);
    return;
  }
  await openPathInEditor(node.path);
}

/** 按路径打开文档并切到编辑页 */
export async function openPathInEditor(path: string): Promise<void> {
  try {
    const result = await openDocument(path);
    if (result === 'failed') {
      showToast(`无法打开：${basenameOf(path)}`, 'error');
      return;
    }
    useMobileStore.getState().setPage('editor');
  } catch (error) {
    showToast(`无法打开：${errorMessage(error)}`, 'error');
  }
}

/** 在当前文件夹新建文件夹 */
export async function createFolder(name: string): Promise<boolean> {
  const folder = useMobileStore.getState().currentFolder;
  try {
    await ipc.createDir(folder, name.trim());
    await refreshCurrentFolder();
    return true;
  } catch (error) {
    showToast(errorMessage(error), 'error');
    return false;
  }
}

/** 重命名文件/文件夹，并同步已打开的文档与标签（与桌面资源管理器一致） */
export async function renameEntry(node: FileTreeNode, newName: string): Promise<boolean> {
  const trimmed = newName.trim();
  if (trimmed === node.name) return true;
  const parentDir = dirnameOf(node.path);
  const newPath = joinPath(parentDir, trimmed);
  try {
    await ipc.renamePath(node.path, newPath);
    if (!node.isDir) {
      // 单文件：同步迁移已打开文档 store 与标签
      useDocumentStore.getState().renameDocument(node.path, newPath, trimmed, parentDir);
      useWindowStore.getState().updateTabPath(node.path, newPath, trimmed);
    } else {
      // 目录：批量迁移该目录下所有已打开文档与标签
      useDocumentStore.getState().renameDirectory(node.path, newPath);
      useWindowStore.getState().renameTabsDirectory(node.path, newPath);
    }
    await refreshCurrentFolder();
    return true;
  } catch (error) {
    showToast(errorMessage(error), 'error');
    return false;
  }
}

/** 删除文件/文件夹（移动端为永久删除，调用方须先确认） */
export async function deleteEntry(node: FileTreeNode): Promise<boolean> {
  try {
    await ipc.moveToTrash(node.path);
    if (node.isDir) {
      // 目录下已打开的文档逐个标记为已删除（保留未保存内容，允许另存）
      for (const tab of useWindowStore.getState().tabs) {
        if (tab.path && isSubPath(node.path, tab.path)) markOpenDocumentDeleted(tab.key);
      }
    } else {
      markOpenDocumentDeleted(node.path);
    }
    await refreshCurrentFolder();
    return true;
  } catch (error) {
    showToast(errorMessage(error), 'error');
    return false;
  }
}

/** 在目录中生成不重名的文件名（a.md → a (1).md） */
function uniqueName(existing: Set<string>, name: string): string {
  if (!existing.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base} (${index})${ext}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

/** 从系统选择器返回的路径/URI 推断文件名（content:// URI 取最后一段并解码） */
function displayNameFromPicked(picked: string): string {
  let last = picked.split(/[/\\]/).filter(Boolean).pop() ?? 'imported';
  try {
    last = decodeURIComponent(last);
  } catch {
    // 保持原样
  }
  // DocumentsProvider 形如 primary:Download/a.md，取冒号与斜杠后的最后一段
  return last.split(/[:/]/).filter(Boolean).pop() || 'imported';
}

/** 通过系统文件选择器导入文件到当前文件夹（复制，原文件不受影响） */
export async function importFiles(): Promise<void> {
  const picked = await open({ multiple: true });
  if (!picked) return;
  const list = Array.isArray(picked) ? picked : [picked];
  if (list.length === 0) return;
  const folder = useMobileStore.getState().currentFolder;
  const existing = new Set(useMobileStore.getState().entries.map((entry) => entry.name.toLowerCase()));
  let imported = 0;
  let lastPath: string | null = null;
  for (const source of list) {
    try {
      const bytes = await readFile(source);
      const name = uniqueName(existing, displayNameFromPicked(source));
      existing.add(name.toLowerCase());
      const target = joinPath(folder, name);
      await ipc.saveBinaryFile(target, bytes);
      imported += 1;
      lastPath = target;
    } catch (error) {
      showToast(`导入失败：${errorMessage(error)}`, 'error');
    }
  }
  await refreshCurrentFolder();
  if (imported === 1 && lastPath) {
    await openPathInEditor(lastPath);
  } else if (imported > 1) {
    showToast(`已导入 ${imported} 个文件`, 'success');
  }
}

/** 调用系统分享面板 */
export async function shareEntry(path: string): Promise<void> {
  try {
    await ipc.shareFile(path);
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

/** 处理外部传入（打开方式 / 分享到 NoteBoard）的文件：逐个打开，最后一个显示在编辑页 */
export async function consumeIncomingFiles(): Promise<void> {
  let paths: string[] = [];
  try {
    paths = await ipc.takeIncomingFiles();
  } catch {
    return;
  }
  for (const path of paths) {
    await openPathInEditor(path);
  }
}
