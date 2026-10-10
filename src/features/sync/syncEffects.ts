// NoteBoard 同步结果在本窗口的落地处理
//
// 同步线程改动本机文件后广播 nb://sync-applied，每个窗口据此：
//   - 已打开且未修改的文档：静默重新加载为最新内容
//   - 已打开且有未保存修改的文档：标记为外部已修改（出现冲突横幅，自动保存暂停，由用户决定）
//   - 已打开的文档被其他设备删除：标记为已删除——继续编辑后保存会作为新文件写回
//   - 已打开的文档被其他设备改名/移动：标签与文档路径跟随迁移
//   - 刷新文件树中受影响且已展开的目录（移动端刷新当前文件夹）

import * as ipc from '../../core/ipc/commands';
import { onSyncApplied } from '../../core/ipc/events';
import type { SyncLocalChange } from '../../core/ipc/types';
import { IS_MOBILE_UI } from '../../core/platform';
import { useDocumentStore } from '../../stores/documentStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWindowStore } from '../../stores/windowStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { basenameOf, dirnameOf, isSubPath, pathKey } from '../explorer/pathUtils';
import { allowRecreateOnSave, checkOpenDocumentStillExists, markOpenDocumentDeleted } from '../external/missingFileGuard';
import { syncTrashPath, useSyncStore } from '../../stores/syncStore';
import { showToast } from '../../stores/toastStore';

/** 按规范化身份查找已打开文档（大小写/分隔符差异可命中） */
function findOpenKey(path: string): string | null {
  const target = pathKey(path);
  for (const key of useDocumentStore.getState().documents.keys()) {
    if (pathKey(key) === target) return key;
  }
  return null;
}

/** 文件内容被同步更新 */
async function handleContentChanged(path: string): Promise<void> {
  const key = findOpenKey(path);
  if (!key) return;
  const doc = useDocumentStore.getState().getDocument(key);
  const tab = useWindowStore.getState().getTab(key);
  if (!doc || !tab || tab.lazySource) return;
  // 之前被标记为已删除（例如另一端恢复了该文件）：先解除断开状态
  if (tab.isDetached || doc.externalStatus === 'deleted') {
    await checkOpenDocumentStillExists(key, true);
  }
  if (doc.isDirty) {
    // 本机有未保存修改：不覆盖编辑内容，交由冲突横幅处理（重新加载 / 覆盖磁盘）
    useDocumentStore.getState().setExternalStatus(key, 'modified');
    useWindowStore.getState().setTabExternalStatus(key, 'modified');
    return;
  }
  const { reloadFromDisk } = await import('../external/externalChangeActions');
  await reloadFromDisk(key, { silent: true });
}

/**
 * 文件被其他设备删除（或移入同步回收站）
 * 有未保存修改：保持可编辑，保存（或关闭时选择保存）会在原路径作为新文件重新创建；
 * 没有修改：与本机删除一致，进入「文件已被删除」流程。
 */
function handleDeleted(path: string): void {
  const key = findOpenKey(path);
  if (!key) return;
  const doc = useDocumentStore.getState().getDocument(key);
  if (doc?.isDirty) {
    allowRecreateOnSave(key);
    showToast(`「${basenameOf(path)}」已在其他设备上被删除，你的未保存修改仍在；保存后将作为新文件重新创建`, 'warning', 8000, 'sync-recreate');
    return;
  }
  markOpenDocumentDeleted(key);
}

/** 文件被同步移动/改名（移入回收站视为删除，回收站中的文件不能打开编辑） */
function handleMoved(from: string, to: string): void {
  const trash = syncTrashPath(useSyncStore.getState().config);
  if (trash && isSubPath(trash, to)) {
    handleDeleted(from);
    return;
  }
  const key = findOpenKey(from);
  if (!key) return;
  const name = basenameOf(to);
  useDocumentStore.getState().renameDocument(key, to, name, dirnameOf(to));
  useWindowStore.getState().updateTabPath(key, to, name);
}

/** 刷新文件树中已加载的受影响目录（含祖先目录：新建的子目录需要在父目录列表中出现） */
export async function refreshExplorer(paths: string[]): Promise<void> {
  const { root, children } = useExplorerStore.getState();
  if (!root) return;
  const dirs = new Set<string>();
  for (const p of paths) {
    let dir = dirnameOf(p);
    while (dir && isSubPath(root, dir)) {
      if (children.has(pathKey(dir))) dirs.add(dir);
      if (pathKey(dir) === pathKey(root)) break;
      const parent = dirnameOf(dir);
      if (!parent || parent === dir) break;
      dir = parent;
    }
  }
  const showHidden = useSettingsStore.getState().settings.file.showHiddenFiles ?? false;
  await Promise.all(
    [...dirs].map(async (dir) => {
      try {
        const nodes = await ipc.readDir(dir, showHidden);
        useExplorerStore.getState().updateChildren(dir, nodes);
      } catch {
        // 目录已不存在：保持现状，父目录刷新后自然消失
      }
    }),
  );
}

/** 应用一批同步改动 */
export async function applySyncChanges(changes: SyncLocalChange[]): Promise<void> {
  const touched: string[] = [];
  for (const change of changes) {
    touched.push(change.path);
    try {
      switch (change.kind) {
        case 'modified':
        case 'added':
          await handleContentChanged(change.path);
          break;
        case 'deleted':
          handleDeleted(change.path);
          break;
        case 'moved':
          if (change.from) {
            touched.push(change.from);
            handleMoved(change.from, change.path);
          }
          break;
      }
    } catch (error) {
      console.warn('[sync] 处理同步改动失败:', change, error);
    }
  }
  await refreshExplorer(touched);
  if (IS_MOBILE_UI) {
    const { refreshCurrentFolder } = await import('../../mobile/mobileFiles');
    await refreshCurrentFolder();
  }
}

/** 启动监听；返回注销函数 */
export function startSyncEffects(): () => void {
  let disposed = false;
  const unlisten = onSyncApplied((changes) => {
    if (!disposed) void applySyncChanges(changes);
  });
  return () => {
    disposed = true;
    void unlisten.then((fn) => fn());
  };
}
