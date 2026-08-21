// NoteBoard 暂存管理器
// 编辑停止后增量覆盖副本，正常保存/明确丢弃时清理，暂存关闭与异常终止时保留。

import * as ipc from '../../core/ipc/commands';
import type { StagingDocument, StagingResult } from '../../core/ipc/types';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { syncDocumentContent } from '../editor-code/orchestration/syncDocumentContent';
import { hasUnsavedWork } from './stagingPolicy';

/** 编辑停止后快速落盘，缩小任务管理器强制终止时可能丢失的时间窗口。 */
const STAGING_DEBOUNCE_MS = 800;
/** 定时兜底覆盖，处理编辑器未触发常规失焦或订阅事件的边界。 */
const STAGING_INTERVAL_MS = 5_000;

// 每个文档在一次编辑会话内复用同一暂存文件，避免每次键入都生成历史副本。
const stagedPaths = new Map<string, string>();
// 明确选择“暂存”的文档不再由标签移除后的清理流程删除。
const retainedKeys = new Set<string>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let stopDocumentSubscription: (() => void) | null = null;
let stopWindowSubscription: (() => void) | null = null;
let writeQueue: Promise<StagingResult[]> = Promise.resolve([]);

/** 统一复用关闭保护策略：空白未命名文件不暂存，有内容或脏态才暂存。 */
const shouldStage = hasUnsavedWork;

/** 收集指定范围内需暂存的文档，并在关闭/失焦前同步编辑器权威内容。 */
function collectDocuments(keys?: string[]): StagingDocument[] {
  const tabs = useWindowStore.getState().tabs;
  const requestedKeys = keys ? new Set(keys) : null;
  const candidates = tabs.filter((tab) => (!requestedKeys || requestedKeys.has(tab.key)) && shouldStage(tab.key));

  for (const tab of candidates) {
    syncDocumentContent(tab.key);
  }

  const store = useDocumentStore.getState();
  return candidates.flatMap((tab) => {
    const document = store.getDocument(tab.key);
    if (!document || !shouldStage(tab.key)) return [];
    return [{
      key: tab.key,
      displayName: tab.displayName || document.displayName,
      content: document.content ?? '',
      encoding: document.encoding,
      eol: document.eol,
      targetPath: stagedPaths.get(tab.key) ?? null,
    }];
  });
}

/** 清理已恢复干净且未被明确保留的副本，避免正常编辑产生长期垃圾。 */
async function cleanupResolvedCopies(): Promise<void> {
  const cleanupTasks: Promise<void>[] = [];
  for (const [key, path] of stagedPaths) {
    if (retainedKeys.has(key) || shouldStage(key)) continue;
    stagedPaths.delete(key);
    cleanupTasks.push(ipc.deleteStagedFile(path).catch((error) => {
      console.warn('[stagingManager] 清理已恢复文档的暂存副本失败:', error);
    }));
  }
  await Promise.all(cleanupTasks);
}

/** 实际执行一次暂存写入；由串行队列调用，防止定时器与关闭事件并发覆盖。 */
async function writePendingDocuments(keys?: string[], retain = false): Promise<StagingResult[]> {
  await cleanupResolvedCopies();
  const documents = collectDocuments(keys);
  if (documents.length === 0) return [];

  const results: StagingResult[] = [];
  const errors: string[] = [];
  // 逐份调用以保留部分成功结果：某一文件失败时，其余文件仍能得到异常退出保护与稳定覆盖路径。
  for (const document of documents) {
    try {
      const [result] = await ipc.stashDocuments([document]);
      if (!result) {
        errors.push(`${document.displayName}：后端未返回暂存路径`);
        continue;
      }
      const previousPath = document.targetPath;
      stagedPaths.set(result.key, result.targetPath);
      results.push(result);
      // 修改设置位置后 Rust 会返回新路径，此时清理旧位置中仅用于异常恢复的副本。
      if (previousPath && previousPath !== result.targetPath) {
        ipc.deleteStagedFile(previousPath).catch((error) => {
          console.warn('[stagingManager] 清理旧暂存位置副本失败:', error);
        });
      }
    } catch (error) {
      errors.push(`${document.displayName}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 只有整批成功时才标记为用户确认保留，失败时窗口继续停留并允许用户重试或正常保存。
  if (errors.length > 0) throw new Error(errors.join('；'));
  if (retain) results.forEach((result) => retainedKeys.add(result.key));
  return results;
}

/**
 * 立即暂存未保存文档。所有调用串行执行；retain=true 表示用户明确要求保留并关闭。
 */
export function stashPendingDocuments(options: { keys?: string[]; retain?: boolean } = {}): Promise<StagingResult[]> {
  const keys = options.keys ? [...options.keys] : undefined;
  const retain = options.retain ?? false;
  writeQueue = writeQueue
    .catch(() => [])
    .then(() => writePendingDocuments(keys, retain));
  return writeQueue;
}

/** 返回当前编辑会话已分配的暂存路径，供最近关闭窗口快照建立原路径/暂存路径关系。 */
export function getStagedPath(docKey: string): string | null {
  return stagedPaths.get(docKey) ?? null;
}

/** 正常保存完成后清理该文档的异常恢复副本。 */
export async function onDocumentSaved(docKey: string): Promise<void> {
  // 等待已在途的暂存写入结束，避免“先清理、后写回”在快速保存/退出时遗留假恢复副本。
  await writeQueue.catch(() => []);
  retainedKeys.delete(docKey);
  const path = stagedPaths.get(docKey);
  stagedPaths.delete(docKey);
  if (path) await ipc.deleteStagedFile(path).catch((error) => {
    console.warn('[stagingManager] 保存后清理暂存副本失败:', error);
  });
}

/** 用户明确选择“不保存”时同步清理副本，保证该动作语义仍是彻底丢弃。 */
export async function discardStagedDocuments(keys: string[]): Promise<void> {
  // 关闭确认前排空写队列，保证明确丢弃后不会被较早排队的定时任务重新写回。
  await writeQueue.catch(() => []);
  const tasks = keys.flatMap((key) => {
    retainedKeys.delete(key);
    const path = stagedPaths.get(key);
    stagedPaths.delete(key);
    return path ? [ipc.deleteStagedFile(path)] : [];
  });
  await Promise.allSettled(tasks);
}

/** 文档变化时安排一次近期限时暂存；已有任务不顺延，避免连续输入长期推迟异常保护。 */
function scheduleStaging(): void {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    stashPendingDocuments().catch((error) => {
      console.error('[stagingManager] 增量暂存失败:', error);
    });
  }, STAGING_DEBOUNCE_MS);
}

/**
 * 启动异常退出保护：订阅内容与标签变化，并在失焦、页面隐藏及固定间隔立即刷新副本。
 */
export function startStagingManager(): () => void {
  if (stopDocumentSubscription || stopWindowSubscription) {
    return stopStagingManager;
  }

  stopDocumentSubscription = useDocumentStore.subscribe(scheduleStaging);
  stopWindowSubscription = useWindowStore.subscribe(scheduleStaging);
  intervalTimer = setInterval(() => {
    stashPendingDocuments().catch((error) => {
      console.error('[stagingManager] 定时暂存失败:', error);
    });
  }, STAGING_INTERVAL_MS);

  const handleWindowBlur = () => {
    stashPendingDocuments().catch((error) => {
      console.error('[stagingManager] 失焦暂存失败:', error);
    });
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') handleWindowBlur();
  };
  window.addEventListener('blur', handleWindowBlur);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  stopEventListeners = () => {
    window.removeEventListener('blur', handleWindowBlur);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
  scheduleStaging();
  return stopStagingManager;
}

let stopEventListeners: (() => void) | null = null;

/** 停止本窗口的定时器与订阅；不删除副本，以免卸载阶段误伤异常恢复文件。 */
function stopStagingManager(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  debounceTimer = null;
  intervalTimer = null;
  stopDocumentSubscription?.();
  stopWindowSubscription?.();
  stopEventListeners?.();
  stopDocumentSubscription = null;
  stopWindowSubscription = null;
  stopEventListeners = null;
}
