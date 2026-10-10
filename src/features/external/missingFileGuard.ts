// NoteBoard 运行期文件删除保护
// 仅检查当前已打开文件；重启恢复阶段的缺失文件由会话恢复逻辑直接跳过。

import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { pathKey, sameKey } from '../explorer/pathUtils';

const inFlightKeys = new Set<string>();

/**
 * 被其他设备经多端同步删除、但本机仍有未保存修改的文档：
 * 不进入「已删除」断开状态，继续编辑后保存（或关闭时选择保存）会在原路径作为新文件重新创建并同步到其他设备。
 * 本机资源管理器中的主动删除仍走原有断开流程（禁止悄悄在旧路径重建文件）。
 */
const recreateOnSaveKeys = new Set<string>();

/** 标记文档：原文件被同步删除后允许保存时在原路径重新创建 */
export function allowRecreateOnSave(docKey: string): void {
  recreateOnSaveKeys.add(pathKey(docKey));
}

/** 文档是否处于「同步删除后允许重新创建」状态 */
export function isRecreateOnSaveAllowed(docKey: string): boolean {
  return recreateOnSaveKeys.has(pathKey(docKey));
}

/** 文件已重新出现在原路径（保存成功或其他设备恢复）后解除标记 */
function clearRecreateOnSave(docKey: string): void {
  recreateOnSaveKeys.delete(pathKey(docKey));
}
const lastCheckedAt = new Map<string, number>();
/** 指针与焦点事件可能连续触发，短时间内复用最近检查结果，避免高频 IPC。 */
const CHECK_THROTTLE_MS = 800;

/** 将已在当前窗口打开、随后被删除的文件标记为断开状态。 */
export function markOpenDocumentDeleted(docKey: string): void {
  const tabStore = useWindowStore.getState();
  const documentStore = useDocumentStore.getState();
  // Windows 路径大小写不敏感，左侧文件树与文档注册表的规范化形式可能略有差异（Android 等平台大小写敏感）。
  const actualKey = tabStore.tabs.find((tab) => sameKey(tab.key, docKey))?.key;
  if (!actualKey || !documentStore.getDocument(actualKey)) return;
  if (isRecreateOnSaveAllowed(actualKey)) return;
  tabStore.setTabDetached(actualKey, true);
  tabStore.setTabExternalStatus(actualKey, 'deleted');
  documentStore.setExternalStatus(actualKey, 'deleted');
}

/**
 * 在标签激活、编辑区交互或窗口重新聚焦时确认原路径是否仍存在。
 * 未命名文档没有原路径，不参与运行期删除检测。
 */
export async function checkOpenDocumentStillExists(docKey: string, force = false): Promise<boolean> {
  const tab = useWindowStore.getState().getTab(docKey);
  if (!tab?.path || tab.key.startsWith('untitled:')) return true;
  const now = Date.now();
  if (!force && now - (lastCheckedAt.get(docKey) ?? 0) < CHECK_THROTTLE_MS) {
    return !tab.isDetached;
  }
  if (inFlightKeys.has(docKey)) return !tab.isDetached;

  inFlightKeys.add(docKey);
  lastCheckedAt.set(docKey, now);
  try {
    const state = await ipc.pathExists(tab.path);
    if (!state.exists || state.isDir) {
      // 同步删除后等待保存重建：保持可编辑，不弹出「文件已被删除」
      if (isRecreateOnSaveAllowed(docKey)) return true;
      markOpenDocumentDeleted(docKey);
      return false;
    }
    clearRecreateOnSave(docKey);

    // 用户可能在提示期间把文件恢复到原路径，下一次交互时自动解除断开状态。
    if (tab.isDetached) {
      useWindowStore.getState().setTabDetached(docKey, false);
      useWindowStore.getState().setTabExternalStatus(docKey, 'clean');
      useDocumentStore.getState().setExternalStatus(docKey, 'clean');
    }
    return true;
  } catch (error) {
    console.warn('[missingFileGuard] 检查文件是否存在失败:', error);
    return true;
  } finally {
    inFlightKeys.delete(docKey);
  }
}

/** 检查当前活动标签，供窗口和编辑区事件直接复用。 */
export function checkActiveDocumentStillExists(force = false): Promise<boolean> {
  const activeKey = useWindowStore.getState().activeKey;
  return activeKey ? checkOpenDocumentStillExists(activeKey, force) : Promise.resolve(true);
}
