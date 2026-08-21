// NoteBoard 运行期文件删除保护
// 仅检查当前已打开文件；重启恢复阶段的缺失文件由会话恢复逻辑直接跳过。

import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';

const inFlightKeys = new Set<string>();
const lastCheckedAt = new Map<string, number>();
/** 指针与焦点事件可能连续触发，短时间内复用最近检查结果，避免高频 IPC。 */
const CHECK_THROTTLE_MS = 800;

/** 将已在当前窗口打开、随后被删除的文件标记为断开状态。 */
export function markOpenDocumentDeleted(docKey: string): void {
  const tabStore = useWindowStore.getState();
  const documentStore = useDocumentStore.getState();
  // Windows 路径大小写不敏感，左侧文件树与文档注册表的规范化形式可能略有差异。
  const actualKey = tabStore.tabs.find((tab) => tab.key.toLocaleLowerCase() === docKey.toLocaleLowerCase())?.key;
  if (!actualKey || !documentStore.getDocument(actualKey)) return;
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
      markOpenDocumentDeleted(docKey);
      return false;
    }

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
