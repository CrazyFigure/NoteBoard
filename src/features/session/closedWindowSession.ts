// NoteBoard 最近关闭窗口
// 只记录窗口关闭时仍在标签栏中的文件；启动时自动恢复 Tab，但保持 Home 为当前页面。

import { getCurrentWindow } from '@tauri-apps/api/window';
import * as ipc from '../../core/ipc/commands';
import type { SessionSnapshot, SessionTabSnapshot } from '../../core/ipc/types';
import { useLayoutStore } from '../../stores/layoutStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWindowStore } from '../../stores/windowStore';
import { sameKey, useExplorerStore } from '../explorer/explorerStore';
import { openDocument } from '../editor-code/orchestration/openDocument';
import { getStagedPath, stashPendingDocuments } from '../staging/stagingManager';
import { hasUnsavedWork } from '../staging/stagingPolicy';
import { showToast } from '../../stores/toastStore';

let windowHadTabs = false;

/** 跟踪本窗口是否曾打开标签，用于区分“纯 Home 退出”与“用户已逐个关闭全部标签”。 */
export function startClosedWindowSessionTracker(): () => void {
  windowHadTabs = useWindowStore.getState().tabs.length > 0;
  return useWindowStore.subscribe((state) => {
    if (state.tabs.length > 0) windowHadTabs = true;
  });
}

/** 读取窗口 label 中的序号；主窗口与异常 label 均安全降级为 0。 */
function currentWindowSequence(): number {
  const label = getCurrentWindow().label;
  const parsed = Number.parseInt(label.replace(/^nb-/, ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 保存最近关闭窗口快照。
 * excludeKeys 用于“不保存”分支，明确丢弃的标签不会再次出现在恢复列表中。
 */
export async function saveCurrentWindowSnapshot(excludeKeys: string[] = []): Promise<boolean> {
  const settings = useSettingsStore.getState().settings;
  if (!settings.file.restoreSession) return false;

  const excluded = new Set(excludeKeys);
  const tabs = useWindowStore.getState().tabs.filter((tab) => {
    if (excluded.has(tab.key)) return false;
    // 用户确认空白未命名文件无需保存，也不应进入最近关闭窗口。
    return !tab.key.startsWith('untitled:') || hasUnsavedWork(tab.key);
  });

  // 纯 Home 启动后直接退出不覆盖旧快照；曾打开标签后变空则说明用户已逐个关闭，应清除旧快照。
  if (tabs.length === 0) {
    if (windowHadTabs) await ipc.clearSession();
    return true;
  }

  const unsavedKeys = tabs.filter((tab) => hasUnsavedWork(tab.key)).map((tab) => tab.key);
  if (unsavedKeys.length > 0) {
    await stashPendingDocuments({ keys: unsavedKeys });
  }

  const snapshotTabs: SessionTabSnapshot[] = tabs.map((tab) => ({
    key: tab.key,
    isPinned: false,
    viewMode: tab.viewMode,
    sourcePath: tab.path,
    stagedPath: getStagedPath(tab.key),
    displayName: tab.displayName,
  }));
  const layout = useLayoutStore.getState();
  const snapshot: SessionSnapshot = {
    schemaVersion: 1,
    savedAt: Date.now(),
    windows: [{
      seq: currentWindowSequence(),
      explorerRoot: useExplorerStore.getState().root ?? '',
      layout: {
        explorerVisible: layout.explorerVisible,
        explorerWidth: layout.explorerWidth,
        outlineVisible: layout.outlineVisible,
        outlineWidth: layout.outlineWidth,
      },
      tabs: snapshotTabs,
      activeKey: useWindowStore.getState().activeKey ?? '',
    }],
  };
  await ipc.saveSession(snapshot);
  return true;
}

/**
 * 启动时恢复最近文件到标签栏。
 * 已命名文件只打开原路径；重启期间原文件被删除则直接跳过。只有原本未命名的文件才回退到暂存路径。
 */
export async function restoreLastClosedWindow(): Promise<boolean> {
  const snapshot = await ipc.loadSession();
  const windowSnapshot = snapshot?.windows[0];
  if (!windowSnapshot || windowSnapshot.tabs.length === 0) return false;

  const restoredKeys = new Map<string, string>();
  let skippedMissing = 0;
  let retainedNamedStagingCopies = 0;
  for (const tab of windowSnapshot.tabs) {
    let candidate: string | null = null;
    // 旧版会话只有 key 字段，非未命名 key 兼容视为原文件路径。
    const sourcePath = tab.sourcePath ?? (!tab.key.startsWith('untitled:') ? tab.key : null);
    if (sourcePath) {
      const sourceState = await ipc.pathExists(sourcePath);
      if (sourceState.exists && !sourceState.isDir) {
        candidate = sourcePath;
        if (tab.stagedPath) retainedNamedStagingCopies += 1;
      }
    } else if (tab.stagedPath) {
      const stagedState = await ipc.pathExists(tab.stagedPath);
      if (stagedState.exists && !stagedState.isDir) candidate = tab.stagedPath;
    }

    // 重启恢复只跳过已删除文件，不创建“丢失文件”标签或处置弹窗。
    if (!candidate) {
      skippedMissing += 1;
      continue;
    }
    await openDocument(candidate);
    // openDocument 默认激活新标签；启动恢复需立即撤销激活，确保首屏始终保持 Home。
    useWindowStore.setState({ activeKey: null });
    const restoredTab = useWindowStore.getState().tabs.find((openedTab) => (
      sameKey(openedTab.path ?? openedTab.key, candidate)
    ));
    if (!restoredTab) continue;
    restoredKeys.set(tab.key, restoredTab.key);
    if (tab.viewMode) {
      useWindowStore.getState().setTabViewMode(restoredTab.key, tab.viewMode);
    }
  }

  if (restoredKeys.size > 0) {
    // 标签恢复完成后再应用布局，避免 openDocument 自动展开资源管理器覆盖原窗口状态。
    useLayoutStore.getState().restoreFrom(windowSnapshot.layout);
    if (windowSnapshot.explorerRoot) {
      try {
        const rootState = await ipc.pathExists(windowSnapshot.explorerRoot);
        if (rootState.exists && rootState.isDir) {
          const children = await ipc.readDir(windowSnapshot.explorerRoot, false);
          useExplorerStore.getState().setRoot(windowSnapshot.explorerRoot, children);
        }
      } catch (error) {
        console.warn('[closedWindowSession] 恢复原资源管理器目录失败:', error);
      }
    }
  }
  // 文件已经进入 Tab 栏，但启动首屏固定回到 Home，等待用户自行选择要查看的标签。
  useWindowStore.setState({ activeKey: null });
  await ipc.clearSession();

  const restoredCount = restoredKeys.size;
  if (skippedMissing > 0) {
    showToast(`已恢复 ${restoredCount} 个文件，跳过 ${skippedMissing} 个已不存在的文件`, 'info');
  } else if (retainedNamedStagingCopies > 0) {
    showToast(`已按原路径恢复 ${restoredCount} 个文件；${retainedNamedStagingCopies} 份暂存修改仍保留在暂存区`, 'info', 5000);
  } else if (restoredCount > 0) {
    showToast(`已恢复 ${restoredCount} 个最近文件`, 'success');
  }
  return restoredCount > 0;
}
