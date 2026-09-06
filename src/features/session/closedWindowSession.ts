// NoteBoard 最近关闭窗口
// 只记录窗口关闭时仍在标签栏中的文件；启动时自动恢复 Tab，但保持 Home 为当前页面。

import { getCurrentWindow } from '@tauri-apps/api/window';
import * as ipc from '../../core/ipc/commands';
import type { SessionSnapshot, SessionTabSnapshot } from '../../core/ipc/types';
import { useLayoutStore } from '../../stores/layoutStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWindowStore } from '../../stores/windowStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { openDocument } from '../editor-code/orchestration/openDocument';
import { getStagedPath, stashPendingDocuments, registerRestoredStagedPath } from '../staging/stagingManager';
import { kindFromPath, languageFromPath } from '../../core/docKind';
import { useDocumentStore } from '../../stores/documentStore';
import type { Tab } from '../../stores/windowStore';
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
    stagedPath: tab.lazyStagedPath ?? getStagedPath(tab.key),
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
 * 启动时恢复最近文件到标签栏（S10：轻量描述符）。
 * 只建立 Tab 与轻量 Document（正文为空、不读盘、不预取编辑器、不注册所有权），
 * 正文在用户点击标签时按需加载（loadRestoredTab）；Home 保持首屏不创建编辑器。
 * 已命名文件只打开原路径；重启期间原文件被删除则直接跳过。只有原本未命名的文件才回退到暂存路径。
 */
export async function restoreLastClosedWindow(): Promise<boolean> {
  const snapshot = await ipc.loadSession();
  const windowSnapshot = snapshot?.windows[0];
  if (!windowSnapshot || windowSnapshot.tabs.length === 0) return false;

  let skippedMissing = 0;
  let retainedNamedStagingCopies = 0;
  const restoredTabs: Tab[] = [];
  for (const tab of windowSnapshot.tabs) {
    let candidate: string | null = null;
    // 🔴 N02：区分"字段不存在（旧格式，按 key 回退）"与"显式 null（未命名）"——
    //    未命名条目重写快照后 sourcePath 显式为 null，若用 ?? 回退会把暂存路径
    //    当成命名文件路径（丢失未命名/暂存身份，变成干净命名条目）
    const sourcePath =
      'sourcePath' in tab && tab.sourcePath !== undefined
        ? tab.sourcePath
        : (!tab.key.startsWith('untitled:') ? tab.key : null);
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

    // 🔴 N02：同路径已有标签或已加载会话（恢复期间用户手动打开/前一轮恢复已
    //    处理）——不建占位：content:null 会覆盖用户正在编辑的正文
    const existingTab = useWindowStore.getState().getTab(candidate);
    const existingDoc = useDocumentStore.getState().getDocument(candidate);
    if (existingTab || (existingDoc && existingDoc.content != null)) {
      continue;
    }

    // 🔴 S10 轻量描述符：kind/language 按路径推断，正文延迟到点击加载
    const kind = kindFromPath(candidate);
    const language = languageFromPath(candidate);
    const displayName = candidate.split(/[\\/]/).pop() ?? candidate;
    const dirPath =
      candidate.substring(0, Math.max(candidate.lastIndexOf('\\'), candidate.lastIndexOf('/'))) ||
      candidate;
    const staged = tab.stagedPath ?? null;
    // 🔴 R01：未命名标签以暂存路径为打开来源（有未保存工作，进入关闭保护）；
    //    命名文件按原路径恢复（正文未知但磁盘为权威基线），暂存修改保留在
    //    磁盘暂存区、脱离内存暂存管理（与原实现语义一致），不标脏。
    const isStagedRestore = !sourcePath;

    useDocumentStore.getState().upsertFromPayload({
      key: candidate,
      displayName,
      dirPath,
      kind,
      language,
      // 🔴 R01：正文未知用 null——绝不能用空字符串代替（空串会进入写入链覆盖恢复副本）
      content: null,
      encoding: 'utf8',
      eol: 'lf',
      size: 0,
      mtime: 0,
      readonly: false,
    });
    if (isStagedRestore && staged) {
      useDocumentStore.getState().setDirty(candidate, true);
      // 暂存路径登记回内存记录（内容未知；关闭丢弃/保留流程照常工作）
      registerRestoredStagedPath(candidate, staged);
    }

    restoredTabs.push({
      key: candidate,
      displayName,
      path: sourcePath ?? null,
      kind,
      language,
      isDirty: Boolean(isStagedRestore && staged),
      isPreview: false,
      viewMode: tab.viewMode ?? null,
      externalStatus: null,
      isDetached: false,
      lazySource: candidate,
      lazyStagedPath: staged,
    });
  }

  if (restoredTabs.length > 0) {
    // 批量加入标签（不激活、不动 activeKey：恢复期间用户交互不被抢焦点；Home 保持首屏）
    useWindowStore.getState().addRestoredTabs(restoredTabs);
    // 标签描述符建立后再应用布局，避免资源管理器状态覆盖原窗口布局
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
  // 🔴 R01：恢复事务落盘——把恢复出的标签（含未加载条目的原暂存路径）重写回会话，
  //    而不是 clearSession：未加载标签在进程异常退出后仍可再次恢复；
  //    窗口正常关闭时由 saveCurrentWindowSnapshot 覆盖或清除。
  if (restoredTabs.length > 0) {
    const layoutNow = useLayoutStore.getState();
    const rewrite: SessionSnapshot = {
      schemaVersion: 1,
      savedAt: Date.now(),
      windows: [{
        seq: currentWindowSequence(),
        explorerRoot: useExplorerStore.getState().root ?? '',
        layout: {
          explorerVisible: layoutNow.explorerVisible,
          explorerWidth: layoutNow.explorerWidth,
          outlineVisible: layoutNow.outlineVisible,
          outlineWidth: layoutNow.outlineWidth,
        },
        tabs: restoredTabs.map((tab) => ({
          key: tab.key,
          isPinned: false,
          viewMode: tab.viewMode,
          sourcePath: tab.path,
          stagedPath: tab.lazyStagedPath ?? getStagedPath(tab.key),
          displayName: tab.displayName,
        })),
        activeKey: '',
      }],
    };
    await ipc.saveSession(rewrite);
  } else {
    await ipc.clearSession();
  }

  const restoredCount = restoredTabs.length;
  if (skippedMissing > 0) {
    showToast(`已恢复 ${restoredCount} 个文件，跳过 ${skippedMissing} 个已不存在的文件`, 'info');
  } else if (retainedNamedStagingCopies > 0) {
    showToast(`已按原路径恢复 ${restoredCount} 个文件；${retainedNamedStagingCopies} 份暂存修改仍保留在暂存区`, 'info', 5000);
  } else if (restoredCount > 0) {
    showToast(`已恢复 ${restoredCount} 个最近文件`, 'success');
  }
  return restoredCount > 0;
}

// ── S10：按需加载 ──

/** 懒标签按需加载结果（供保存/另存/迁移的正文出口判断） */
export type LazyLoadResult =
  /** 正文已加载并交付到本 key 的会话 */
  | 'loaded'
  /** 加载失败（打开链失败或正文未交付）——标签保留可重试 */
  | 'failed'
  /** 调用时无懒标签（已加载/标签不存在）——调用方按普通文档处理 */
  | 'no-lazy'
  /** 并发等待时其它调用方已完成，但会话仍未见正文（罕见竞态，按失败处理） */
  | 'stale';

/** 懒加载在途（key → 共享加载 Promise；并发调用等待同一读取，不把"正在加载"当完成） */
const loadingLazyTabs = new Map<string, Promise<LazyLoadResult>>();

/**
 * 按需加载恢复标签的正文：走完整打开链（prepare 归属/读盘/注册/编辑器预取），
 * 完成后清除懒加载标记。
 * 🔴 N02：返回明确的 loaded/failed/stale 结果——focused/cancelled 也必须验证
 *    目标会话确实得到正文（content != null）才清除懒标记；失败保留标签可重试。
 */
export async function loadRestoredTab(key: string): Promise<LazyLoadResult> {
  const tab = useWindowStore.getState().getTab(key);
  if (!tab?.lazySource) return 'no-lazy';
  // 🔴 N02：共享加载 Promise——并发保存/激活等待同一次读取，不重复触发打开链
  const existing = loadingLazyTabs.get(key);
  if (existing) return existing;

  const task = (async (): Promise<LazyLoadResult> => {
    try {
      const result = await openDocument(tab.lazySource!);
      if (result === 'failed') {
        showToast(`无法加载 ${tab.displayName}，请重试或检查文件`, 'error');
        return 'failed'; // 保留懒标签（可重试）
      }
      // 🔴 N02：opened/focused/cancelled 都不能只凭返回值清除懒标记——
      //    必须验证本 key 的会话确实拿到正文（focused=另一处已打开，本标签无正文）
      const doc = useDocumentStore.getState().getDocument(key);
      if (!doc || doc.content == null) {
        return 'stale';
      }
      // 打开链完成后清除懒标记（正文已在 store；编辑器正常挂载）
      useWindowStore.getState().clearLazy(key);
      return 'loaded';
    } finally {
      loadingLazyTabs.delete(key);
    }
  })();
  loadingLazyTabs.set(key, task);
  return task;
}

/**
 * 🔴 N02：正文出口统一前置屏障（保存/另存/迁移共用）。
 * 只有"已加载且有可写正文"的状态才返回正文；null/失败/失效一律返回 null，
 * 调用方必须中止——绝不能用 '' 把未知正文补成合法空文件写盘。
 * 空字符串是合法正文（用户清空文档），与"未知（null）"严格区分。
 */
export async function ensureWritableContent(docKey: string): Promise<string | null> {
  const doc = useDocumentStore.getState().getDocument(docKey);
  if (!doc) return null;
  // 正文未知（懒恢复占位）→ 先按需加载；仍拿不到则中止
  if (doc.content == null) {
    const tab = useWindowStore.getState().getTab(docKey);
    if (!tab?.lazySource) return null; // 未知内容且无从加载
    const result = await loadRestoredTab(docKey);
    if (result !== 'loaded') return null;
    const loaded = useDocumentStore.getState().getDocument(docKey);
    return loaded?.content ?? null;
  }
  return doc.content;
}
