// NoteBoard 中心目录监听服务（S14 K 节）
// 🔴 设计（docs/启动性能与低内存根治计划.md §K）：
//   1. 真实实现使用已安装的 tauri-plugin-fs watch（JS API；fs:allow-watch 权限已在
//      capabilities 声明），替换原 Rust 占位空命令。
//   2. 按目录引用计数：多个标签/视图共用同一 root 的监听，一个关闭不误停其它订阅。
//   3. 监听内容只覆盖活动目录（不为每标签递归扫描整个磁盘）。
//   4. 触发侧消费：目录变化 → 发 nb://explorer-refresh 事件（增量刷新该目录），
//      与 useWatcher 原事件消费路径一致。

import { watchImmediate, type UnwatchFn, type WatchEvent } from '@tauri-apps/plugin-fs';
import * as ipc from '../../core/ipc/commands';
import { useExplorerStore } from './explorerStore';
// 🔴 N09：外部正文核对链——watcher 事件给受影响的已打开文档安排有界核对，
//    确认外部修改后更新冲突状态（阻止旧 autosave 覆盖外部修改）
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
// 🔴 R3-10：异步核对结果按会话代际条件提交（旧读取不误标同路径新会话）
import { getSessionGeneration } from '../session/documentSession';

/** 目录监听记录 */
interface WatchRecord {
  /** plugin-fs 的注销函数 */
  unwatch: UnwatchFn | null;
  /** 引用计数（归零时停止监听） */
  refs: number;
  /** 监听建立中（防止并发重复建监听） */
  pending: Promise<void> | null;
}

/** 活动监听表：规范化目录 → 记录 */
const records = new Map<string, WatchRecord>();

/** 记录本模块已发起写入的文件路径（watcher 事件忽略自身写入，防自触发循环） */
const selfWrites = new Map<string, number>();

/** 自身写入的静默窗口（写盘后该路径的事件在此窗口内忽略） */
const SELF_WRITE_SILENCE_MS = 1500;

/**
 * 登记一次自身写入（writeDocument 原子替换会触发 watcher 事件）。
 * 以实际写入的路径识别，不用"最近 1 秒全部忽略"（会漏掉其它软件的修改）。
 */
export function noteSelfWrite(path: string): void {
  selfWrites.set(path, Date.now());
}

/** 事件是否属于自身写入（在静默窗口内） */
function isSelfWrite(path: string | undefined): boolean {
  if (!path) return false;
  const at = selfWrites.get(path);
  if (at === undefined) return false;
  if (Date.now() - at > SELF_WRITE_SILENCE_MS) {
    selfWrites.delete(path);
    return false;
  }
  return true;
}

/** 待复核目录（自身写入静默窗口命中后登记；窗口结束后复核一次，防吞外部修改） */
const pendingRecheckDirs = new Set<string>();
let recheckTimer: ReturnType<typeof setTimeout> | null = null;

// ── 🔴 N09：已打开文档的外部修改核对（文件树刷新之外的正文保护链） ──

/** 待核对文档路径（事件风暴去抖合并——600ms 内多事件一次读取） */
const pendingDocRechecks = new Set<string>();
let docRecheckTimer: ReturnType<typeof setTimeout> | null = null;
/** 自身写静默窗口内命中的文档路径（延迟到窗口结束后核对，不吞外部紧随修改） */
const deferredDocRechecks = new Set<string>();

/** 🔴 R3-10：规范化路径身份（与 Rust key 归一一致——大小写不敏感） */
function normalizeDocKey(path: string): string {
  return path.replace(/\//g, '\\').toLowerCase();
}

/** 按规范化身份查找已打开文档的 key（事件路径大小写/斜杠差异可命中） */
function findOpenDocKey(rawPath: string): string | null {
  const normalized = normalizeDocKey(rawPath);
  for (const key of useDocumentStore.getState().documents.keys()) {
    if (normalizeDocKey(key) === normalized) return key;
  }
  return null;
}

/** 为事件路径上的已打开文档登记一次外部修改核对（去抖合并） */
function scheduleDocumentRecheck(rawPath: string): void {
  // 🔴 R3-10：按规范化身份匹配已打开文档（大小写/斜杠差异可命中）
  const docKey = findOpenDocKey(rawPath);
  if (!docKey) return;
  const doc = useDocumentStore.getState().getDocument(docKey);
  const tab = useWindowStore.getState().getTab(docKey);
  // 只核对已打开且已加载（非 lazy）的文档
  if (!doc || !tab || tab.lazySource) return;
  // 🔴 R3-10：不再跳过已 modified/deleted 的文档——外部写回基线（内容恢复
  // 一致）时仍需复核恢复 clean；modified 期间重复核对幂等（内容比较）
  pendingDocRechecks.add(docKey);
  if (docRecheckTimer) return;
  // 🔴 N09：事件风暴去抖——多个事件合并为一次读取（不做每事件一次昂贵读取）
  docRecheckTimer = setTimeout(() => {
    docRecheckTimer = null;
    const paths = [...pendingDocRechecks];
    pendingDocRechecks.clear();
    for (const p of paths) void recheckDocument(p);
  }, 600);
}

/**
 * 核对单个已打开文档是否被外部修改。
 * 与基线（最近一次实际写盘内容）逐字比较——等长替换同样检出；
 * 确认外部修改后置 externalStatus='modified'（自动保存被阻止、冲突横幅提示用户）；
 * 文件消失置 'deleted'；与基线一致恢复 'clean'。
 * 🔴 R3-10：异步结果按会话代际/基线身份条件提交——读取期间会话换代或自身保存
 * 完成时，不误标新会话/不与自身保存竞争（捕获读取时刻的代际与基线内容）。
 */
async function recheckDocument(docKey: string): Promise<void> {
  // 🔴 R3-10：捕获读取时刻的基线与会话代际——异步返回后校验（旧读取迟到不误标新会话）
  const docAtStart = useDocumentStore.getState().getDocument(docKey);
  if (!docAtStart) return;
  const baselineAtStart = docAtStart.baselineContent ?? '';
  const generationAtStart = getSessionGeneration(docKey);
  try {
    const payload = await ipc.readDocument(docKey);
    // 🔴 R3-10：读取返回后校验会话未换代（同路径重开——旧读取结果不适用于新会话）
    if (getSessionGeneration(docKey) !== generationAtStart) return;
    const docNow = useDocumentStore.getState().getDocument(docKey);
    if (!docNow) return;
    // 🔴 R3-10：基线在读取期间变化（自身保存完成）→ 按新基线重新比较（不吞也不误报）
    const effectiveBaseline = docNow.baselineContent !== docAtStart.baselineContent
      ? (docNow.baselineContent ?? '')
      : baselineAtStart;
    const nextStatus: 'modified' | 'clean' = payload.content !== effectiveBaseline ? 'modified' : 'clean';
    if (docNow.externalStatus !== nextStatus) {
      useDocumentStore.getState().setExternalStatus(docKey, nextStatus);
      useWindowStore.getState().setTabExternalStatus(docKey, nextStatus);
    }
  } catch {
    // 读取失败：区分删除与权限（仅确认删除才标记；权限问题保持现状）
    try {
      const state = await ipc.pathExists(docKey);
      // 🔴 R3-10：同样按会话代际条件提交
      if (getSessionGeneration(docKey) !== generationAtStart) return;
      const docNow = useDocumentStore.getState().getDocument(docKey);
      if (!docNow) return;
      if (!state.exists && docNow.externalStatus !== 'deleted') {
        useDocumentStore.getState().setExternalStatus(docKey, 'deleted');
        useWindowStore.getState().setTabExternalStatus(docKey, 'deleted');
      }
    } catch {
      // 无法确认：保持现状
    }
  }
}

/** 🔴 R09/N09：watcher 回调与 Explorer 刷新在同一调用链——直接增量刷新该目录
 *    （readDir + updateChildren；不经 mitt/Tauri 事件双总线）；
 *    同时给事件路径上的已打开文档登记外部修改核对 */
function handleWatchEvent(dir: string, event: WatchEvent): void {
  // 自身写入静默窗口命中：不立即刷新，但登记复核（静默窗口结束后再拉一次，
  // 防止吞掉其它软件紧随其后对同文件的修改）；文档核对同样延迟
  const selfWriteHit = event.paths.some((path) => isSelfWrite(path));
  for (const path of event.paths) {
    if (selfWriteHit && isSelfWrite(path)) {
      // 🔴 R3-10：按规范化身份解析已打开文档 key（大小写/斜杠差异可命中）
      const docKey = findOpenDocKey(path);
      deferredDocRechecks.add(docKey ?? path);
    } else {
      scheduleDocumentRecheck(path);
    }
  }
  if (selfWriteHit) {
    scheduleRecheck(dir);
    return;
  }
  void refreshDirectory(dir);
}

/** 静默窗口结束后复核：一次性拉取该目录（去重合并多个待复核目录）+ 延迟文档核对 */
function scheduleRecheck(dir: string): void {
  pendingRecheckDirs.add(dir);
  if (recheckTimer) return;
  recheckTimer = setTimeout(() => {
    recheckTimer = null;
    const dirs = [...pendingRecheckDirs];
    pendingRecheckDirs.clear();
    for (const d of dirs) void refreshDirectory(d);
    // 🔴 N09：静默窗口内命中的文档路径统一复核（自身写完成后外部修改仍能检出）
    const paths = [...deferredDocRechecks];
    deferredDocRechecks.clear();
    for (const p of paths) void recheckDocument(p);
  }, SELF_WRITE_SILENCE_MS + 100);
}

/** 增量刷新目录（失败静默——目录可能已被删除） */
async function refreshDirectory(dir: string): Promise<void> {
  try {
    const children = await ipc.readDir(dir, true);
    useExplorerStore.getState().updateChildren(dir, children);
  } catch {
    // 目录不可读（被删/权限）：保持现有显示
  }
}

/** 为目录建立监听（已存在则只增加引用） */
async function ensureWatch(dir: string): Promise<void> {
  let record = records.get(dir);
  if (record) {
    record.refs += 1;
    return;
  }
  record = { unwatch: null, refs: 1, pending: null };
  records.set(dir, record);
  record.pending = (async () => {
    try {
      // watchImmediate：事件即时到达（防抖由消费端的增量刷新频率自然合并）
      record!.unwatch = await watchImmediate(dir, (event) => {
        void handleWatchEvent(dir, event);
      });
    } catch (error) {
      // 建监听失败（目录被删/权限）：记录移除，调用方容错（目录区域显示旧数据）
      console.error('[directoryWatcher] 建立目录监听失败:', dir, error);
      records.delete(dir);
    } finally {
      record!.pending = null;
    }
  })();
  await record.pending;
}

/** 释放一次目录监听引用（归零时停止） */
export async function unwatchDirectory(dir: string): Promise<void> {
  const record = records.get(dir);
  if (!record) return;
  record.refs -= 1;
  if (record.refs > 0) return;
  // 引用归零：等待建立完成后停止（避免建立中注销竞态）
  if (record.pending) await record.pending.catch(() => {});
  // 🔴 R09：等待期间可能有新订阅（refs 又 >0）或记录被替换（新代际）——
  //    重新检查：不关掉新订阅需要的 watcher
  if (record.refs > 0) return;
  if (records.get(dir) !== record) return; // 记录已被替换
  records.delete(dir);
  const unwatch = record.unwatch;
  record.unwatch = null;
  if (unwatch) {
    try {
      await unwatch();
    } catch {
      // 已注销
    }
  }
}


/** 订阅目录监听（引用计数 +1）；返回释放函数（引用计数 -1） */
export function watchDirectory(dir: string): () => void {
  void ensureWatch(dir).catch((e) => {
    console.error('[directoryWatcher] 订阅目录监听失败:', dir, e);
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    void unwatchDirectory(dir).catch(() => {});
  };
}

/** 仅测试：读取当前引用计数 */
export function debugWatchRefs(): Map<string, number> {
  return new Map([...records.entries()].map(([dir, r]) => [dir, r.refs]));
}
