// NoteBoard 最近关闭窗口
// 只记录窗口关闭时仍在标签栏中的文件；启动时自动恢复 Tab，但保持 Home 为当前页面。
// 运行期间标签变化后增量写入快照：应用内更新、关机、崩溃或被结束进程时来不及走关闭流程，
// 若只在窗口关闭时记录，本次运行中打开的文件会全部丢失。

import { getCurrentWindow } from '@tauri-apps/api/window';
import * as ipc from '../../core/ipc/commands';
import type { SessionSnapshot, SessionTabSnapshot, WindowBootDto } from '../../core/ipc/types';
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

/** 标签变化后延迟写入快照的防抖时长（连续开关标签只写一次） */
const SNAPSHOT_PERSIST_DEBOUNCE_MS = 1_000;
/** 定时核对快照签名：暂存路径在暂存完成后才出现，不会触发 windowStore 订阅 */
const SNAPSHOT_PERSIST_INTERVAL_MS = 5_000;
/** 已写入“清空”时的签名占位（避免重复 clearSession） */
const EMPTY_SNAPSHOT_SIGNATURE = '<empty>';

/** 启动恢复阶段是否已结束；结束前不增量写入，防止显式打开的文件抢先覆盖待恢复的旧快照 */
let startupRestoreSettled = false;
/** 窗口已进入最终关闭（或更新退出）：停止增量写入，避免关闭过程中移除标签后把快照清空 */
let snapshotFrozen = false;
/** 本窗口最近一次写入的快照签名（签名不变不写盘） */
let lastPersistedSignature: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** 增量写入串行队列（最终关闭写入前等待其排空） */
let persistQueue: Promise<void> = Promise.resolve();

/**
 * 跟踪本窗口是否曾打开标签，用于区分“纯 Home 退出”与“用户已逐个关闭全部标签”；
 * 同时在标签变化、失焦、定时核对时增量写入快照，覆盖来不及走关闭流程的退出方式。
 */
export function startClosedWindowSessionTracker(): () => void {
  windowHadTabs = useWindowStore.getState().tabs.length > 0;
  startupRestoreSettled = false;
  snapshotFrozen = false;
  lastPersistedSignature = null;

  const unsubscribe = useWindowStore.subscribe((state, prev) => {
    if (state.tabs.length > 0) windowHadTabs = true;
    // 只有标签列表变化才安排写入；单纯切换激活标签不写盘
    if (state.tabs !== prev.tabs) scheduleSnapshotPersist();
  });
  const intervalTimer = setInterval(() => {
    enqueueSnapshotPersist();
  }, SNAPSHOT_PERSIST_INTERVAL_MS);

  // 失焦/隐藏时立即落盘：用户切去别的程序后可能直接关机或更新
  const handleBlur = () => flushSnapshotPersist();
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') flushSnapshotPersist();
  };
  // 重新获得焦点时强制重写一次：其他窗口关闭时可能覆盖了快照，以用户正在使用的窗口为准
  const handleFocus = () => {
    lastPersistedSignature = null;
    scheduleSnapshotPersist();
  };
  window.addEventListener('blur', handleBlur);
  window.addEventListener('focus', handleFocus);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    unsubscribe();
    clearInterval(intervalTimer);
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    window.removeEventListener('blur', handleBlur);
    window.removeEventListener('focus', handleFocus);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}

/** 启动恢复阶段结束（无论是否执行了恢复），此后允许增量写入快照 */
export function markStartupRestoreSettled(): void {
  startupRestoreSettled = true;
  scheduleSnapshotPersist();
}

/** 解除冻结并重新写入（应用内更新启动安装器失败、窗口继续使用时调用） */
export function resumeSnapshotTracking(): void {
  snapshotFrozen = false;
  lastPersistedSignature = null;
  scheduleSnapshotPersist();
}

/**
 * 启动时是否恢复最近关闭窗口：
 * 只有进程内唯一存活的窗口才恢复（新建窗口/迁移窗口不恢复，避免与存活窗口重复打开同一批文件）；
 * 空启动与双击文件冷启动都恢复，双击打开的文件照常成为当前标签。
 */
export function shouldRestoreOnStartup(boot: Pick<WindowBootDto, 'startupMode' | 'isSoleWindow'>): boolean {
  if (!useSettingsStore.getState().settings.file.restoreSession) return false;
  if (boot.isSoleWindow === false) return false;
  return boot.startupMode === 'empty' || boot.startupMode === 'explicit-open';
}

/** 读取窗口 label 中的序号；主窗口与异常 label 均安全降级为 0。 */
function currentWindowSequence(): number {
  const label = getCurrentWindow().label;
  const parsed = Number.parseInt(label.replace(/^nb-/, ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 收集应进入快照的标签（excludeKeys 为“不保存”分支明确丢弃的标签） */
function collectSnapshotTabs(excludeKeys: string[] = []): Tab[] {
  const excluded = new Set(excludeKeys);
  return useWindowStore.getState().tabs.filter((tab) => {
    if (excluded.has(tab.key)) return false;
    // 文本对比等工具视图没有对应文件，恢复时只会被当成“已不存在的文件”跳过
    if (tab.toolKind) return false;
    // 用户确认空白未命名文件无需保存，也不应进入最近关闭窗口。
    return !tab.key.startsWith('untitled:') || hasUnsavedWork(tab.key);
  });
}

/** 按当前布局、资源管理器根目录与暂存记录组装单窗口快照 */
function buildWindowSnapshot(tabs: Tab[]): SessionSnapshot {
  const snapshotTabs: SessionTabSnapshot[] = tabs.map((tab) => ({
    key: tab.key,
    isPinned: false,
    viewMode: tab.viewMode,
    sourcePath: tab.path,
    stagedPath: tab.lazyStagedPath ?? getStagedPath(tab.key),
    displayName: tab.displayName,
  }));
  const layout = useLayoutStore.getState();
  return {
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
}

/** 快照签名：不含写入时间与激活标签（切换标签不触发写盘） */
function snapshotSignature(snapshot: SessionSnapshot): string {
  const [windowSnapshot] = snapshot.windows;
  return JSON.stringify([windowSnapshot.explorerRoot, windowSnapshot.layout, windowSnapshot.tabs]);
}

/** 防抖安排一次增量写入 */
function scheduleSnapshotPersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    enqueueSnapshotPersist();
  }, SNAPSHOT_PERSIST_DEBOUNCE_MS);
}

/** 立即写入（取消尚未到期的防抖） */
function flushSnapshotPersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  enqueueSnapshotPersist();
}

/** 串行执行增量写入，避免定时器、失焦与订阅并发写盘 */
function enqueueSnapshotPersist(): void {
  persistQueue = persistQueue
    .then(persistSnapshotIncrementally)
    .catch((error) => {
      console.warn('[closedWindowSession] 增量保存最近文件快照失败:', error);
    });
}

/**
 * 增量写入快照：只记录标签描述，不触发正文暂存（未保存内容由 stagingManager 增量暂存）。
 * 标签变空时沿用关闭语义：曾打开过标签才清除旧快照，纯 Home 不覆盖。
 */
async function persistSnapshotIncrementally(): Promise<void> {
  if (!startupRestoreSettled || snapshotFrozen) return;
  if (!useSettingsStore.getState().settings.file.restoreSession) return;

  const tabs = collectSnapshotTabs();
  if (tabs.length === 0) {
    if (!windowHadTabs || lastPersistedSignature === EMPTY_SNAPSHOT_SIGNATURE) return;
    lastPersistedSignature = EMPTY_SNAPSHOT_SIGNATURE;
    await ipc.clearSession();
    return;
  }

  const snapshot = buildWindowSnapshot(tabs);
  const signature = snapshotSignature(snapshot);
  if (signature === lastPersistedSignature) return;
  lastPersistedSignature = signature;
  try {
    await ipc.saveSession(snapshot);
  } catch (error) {
    // 写入失败时清空签名，下次核对重试
    lastPersistedSignature = null;
    throw error;
  }
}

/**
 * 保存最近关闭窗口快照（窗口最终关闭或更新退出前调用，调用后停止增量写入）。
 * excludeKeys 用于“不保存”分支，明确丢弃的标签不会再次出现在恢复列表中。
 */
export async function saveCurrentWindowSnapshot(excludeKeys: string[] = []): Promise<boolean> {
  // 最终写入：先冻结增量写入并等待在途写入结束，关闭流程随后移除标签也不会清空快照
  snapshotFrozen = true;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  await persistQueue;

  const settings = useSettingsStore.getState().settings;
  if (!settings.file.restoreSession) return false;

  const tabs = collectSnapshotTabs(excludeKeys);

  // 纯 Home 启动后直接退出不覆盖旧快照；曾打开标签后变空则说明用户已逐个关闭，应清除旧快照。
  if (tabs.length === 0) {
    if (windowHadTabs) await ipc.clearSession();
    return true;
  }

  const unsavedKeys = tabs.filter((tab) => hasUnsavedWork(tab.key)).map((tab) => tab.key);
  if (unsavedKeys.length > 0) {
    await stashPendingDocuments({ keys: unsavedKeys });
  }

  await ipc.saveSession(buildWindowSnapshot(tabs));
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
  //    按当前全部标签重写：双击文件冷启动时显式打开的文件一并记录。
  const currentTabs = collectSnapshotTabs();
  if (currentTabs.length > 0) {
    const rewrite = buildWindowSnapshot(currentTabs);
    await ipc.saveSession(rewrite);
    lastPersistedSignature = snapshotSignature(rewrite);
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
      if (!doc) return 'stale';
      // 图片/不支持格式本就不读正文（content 恒为 null）：本窗口打开链建立了会话
      // （result=opened）即视为加载完成，否则恢复标签会永远停在"正在加载"
      const isContentless = doc.kind === 'image' || doc.kind === 'preview' || doc.kind === 'unsupported';
      if (doc.content == null && !(isContentless && result === 'opened')) {
        return 'stale';
      }
      // 打开链完成后清除懒标记，并以打开链判定的类型为准（编辑器/图片/不支持视图正常挂载）
      useWindowStore.getState().clearLazy(key, { kind: doc.kind, language: doc.language });
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
