// NoteBoard 文档会话协调（S09 H 节：版本与同步屏障）
//
// 🔴 不变量（docs/启动性能与低内存根治计划.md §H）：
//   1. 每文档至少区分 revision（每次真实修改递增）/ mirroredRevision / savedRevision；
//      撤销/重做的内容变化同样递增 revision；不复用历史索引当版本。
//   2. flushDocument 是统一异步屏障：捕获某个确切 revision 的权威快照并推进镜像；
//      迟到快照不得倒退镜像；对 save 允许保存捕获时版本，不要求用户停止输入。
//   3. 每文档写盘串行（enqueueDocumentWrite）：晚完成的旧写入不得覆盖新内容；
//      基线只更新为实际写成功的文本。
//   4. 写入成功后的脏态重算采用 flush-and-compare（当前权威内容 vs 基线）：
//      撤销/手动改回原文都能正确清除或保持 dirty（不能只比 revision）。
//   5. 保存成功通知（onDocumentSaved）携带已保存内容证明，暂存清理只删被覆盖的副本。
//   6. 本模块不另存一套全量正文 Map：内容经 documentStore 镜像与编辑器内核引用。

import type { CapturedContent, FlushReason } from '../../core/editor/editorTypes';
import {
  getEditorCapabilities,
  getDocumentRevision,
  clearDocumentRevision,
  moveDocumentRevision,
} from '../../core/editor/editorRegistry';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import * as ipc from '../../core/ipc/commands';
import { getBaseline, normalizeEol } from '../editor-md/serialize';
import { onDocumentSaved } from '../staging/stagingManager';
// 🔴 S14：写盘后登记自身写入（目录 watcher 忽略自身原子替换事件，防自触发循环）
import { noteSelfWrite } from '../explorer/directoryWatcher';

// ── 🔴 N04：会话代际（独立于路径的生命周期身份） ──
//
// 路径相同 ≠ 生命周期相同：关闭→同路径重开、另存为身份迁移都会建立新会话。
// 会话代际在以下时机递增，令此前捕获了旧代际的全部在途任务（flush 快照、
// 镜像提交、自动/手动写盘、关闭清理）在执行时因代际不匹配而作废：
//   1. disposeDocumentSession（会话终结）
//   2. documents Map 中 key 从无到有（同路径新会话建立——含测试的 remove+upsert 路径）
//   3. migrateDocumentSession（另存为：旧 key 作废、新 key 换代）
// instanceId 只表示同一会话内的编辑器挂载代际，不能兼任会话身份。
//
// 🔴 R3-03 步骤 4：可清理设计——全局单调 token + 活动会话表。清理会话时从
// 活动表移除（后续 get 返回 0），但**全局 token 已发出且永不回退**——清理后
// 旧 token 与"无会话（0）"比较即失效，不误碰新会话；活动表不随访问路径增长。

/** 全局单调会话 token（永不回退；活动会话表 key 化后的判定基准） */
let nextSessionToken = 0;

/** 活动会话表：docKey → 当前代际（清理后移除；重建时分配新 token） */
const activeSessionGenerations = new Map<string, number>();

/** 读取会话代际（无活动会话为 0——与任何已发放 token 不等，旧任务自然作废） */
export function getSessionGeneration(docKey: string): number {
  return activeSessionGenerations.get(docKey) ?? 0;
}

/** 推进会话代际（作废全部持有旧代际的在途任务）；返回新代际 */
function advanceSessionGeneration(docKey: string): number {
  const next = ++nextSessionToken;
  activeSessionGenerations.set(docKey, next);
  return next;
}

/** 🔴 R3-03：会话资源清理——活动表条目移除（get 回 0；后续 in-flight 任务因
 *    token ≠ 0 全部作废；重建时 documents 订阅分配新 token，不与旧 token 撞） */
function releaseSessionGeneration(docKey: string): void {
  activeSessionGenerations.delete(docKey);
}

/** 会话代际是否仍是当前代（任务执行时的统一校验） */
function isSessionCurrent(docKey: string, generation: number): boolean {
  return activeSessionGenerations.get(docKey) === generation;
}

// 🔴 N04：documents 中 key 从无到有 = 同路径新会话建立 → 作废旧任务。
//    经 zustand 订阅实现，避免 documentStore 反向依赖 documentSession（循环依赖）。
useDocumentStore.subscribe((state, prev) => {
  if (state.documents === prev.documents) return;
  for (const key of state.documents.keys()) {
    // 🔴 R3-03/C08：documents 中 key 从无到有 = 同路径新会话建立——无条件分配
    //    新 token（即使活动表仍有旧条目：关闭时可能因 closing/写队列未释放）。
    //    旧 token 与新 token 不等 → 旧关闭/写任务自动失效，不越权新会话。
    if (!prev.documents.has(key)) {
      advanceSessionGeneration(key);
    }
  }
  // 🔴 R3-03：documents 中 key 消失且无活动代际消费者时清理活动表
  //    （activeSessionGenerations 的条目由 dispose/migrate 显式释放；
  //    这里兜底移除既不在 documents 也不在写队列/closing 的孤立条目）
  for (const key of [...activeSessionGenerations.keys()]) {
    if (!state.documents.has(key) && !writeQueues.has(key) && !closingGenerations.has(key)) {
      releaseSessionGeneration(key);
    }
  }
});

// ── revision 记录（会话字段；内容版本在 editorRegistry，此处记录同步进度） ──

/** mirroredRevision：镜像（documentStore.content）已确认对应的 revision */
const mirroredRevisions = new Map<string, number>();
/** savedRevision：最近一次成功写盘时捕获的 revision */
const savedRevisions = new Map<string, number>();

function setMirroredRevision(docKey: string, revision: number): void {
  // 🔴 迟到快照不得倒退镜像版本
  const current = mirroredRevisions.get(docKey) ?? 0;
  if (revision > current) mirroredRevisions.set(docKey, revision);
}

/** 读取保存进度版本（供诊断/测试） */
export function getSavedRevision(docKey: string): number {
  return savedRevisions.get(docKey) ?? 0;
}

/** 文档身份迁移（另存为）/最终关闭时清理会话记录 */
export function migrateDocumentSession(fromKey: string, toKey: string): void {
  const mirrored = mirroredRevisions.get(fromKey);
  const saved = savedRevisions.get(fromKey);
  if (mirrored !== undefined) mirroredRevisions.set(toKey, mirrored);
  if (saved !== undefined) savedRevisions.set(toKey, saved);
  // 🔴 N04：真实内容版本随身份迁移（内容未变，版本连续；savedRevision 才有意义）
  moveDocumentRevision(fromKey, toKey);
  mirroredRevisions.delete(fromKey);
  savedRevisions.delete(fromKey);
  // 🔴 N04：旧 key 会话作废（迟到旧任务不得再写旧 key）；新 key 换代
  //    （若新路径存在旧任务/旧会话残留，一并作废）
  advanceSessionGeneration(fromKey);
  advanceSessionGeneration(toKey);
}

/**
 * 文档最终关闭时清理（不用于标签切换）。
 * 🔴 N04：推进会话代际——关闭即作废该会话全部在途任务（旧 flush/写盘/清理
 *    不得影响同路径重开的新会话）。写队列指针不删除：新同路径会话的写任务
 *    串接在旧队列之后（不越过未完成的旧磁盘写入），队尾自清理防泄漏。
 */
export function disposeDocumentSession(docKey: string): void {
  clearDocumentRevision(docKey);
  mirroredRevisions.delete(docKey);
  savedRevisions.delete(docKey);
  advanceSessionGeneration(docKey);
  // 🔴 R3-03：孤立会话表清理——关闭后既无 documents 记录也无在途写/closing 时
  //    从活动表移除（get 回 0）；documents 订阅的兜底清理同样覆盖此路径
  releaseIfOrphaned(docKey);
}

// 🔴 R4-05/D04：孤立条目清理（documents 订阅兜底与显式释放共用）——
//    既不在 documents、也不在写队列、也无 closing 条目时从活动表移除。
//    closing 条目由 disposeTabLifecycleAsync 的 finally 释放后调用
//    releaseIfOrphaned 完成回落（closing 存在期间不清理——drain 事务进行中）。
function releaseIfOrphaned(docKey: string): void {
  if (
    !useDocumentStore.getState().documents.has(docKey)
    && !writeQueues.has(docKey)
    && !closingGenerations.has(docKey)
  ) {
    releaseSessionGeneration(docKey);
  }
}

// ── 统一内容提交屏障（R03） ──

/**
 * 提交一次捕获的权威快照到镜像（所有编辑器 adapter 的 flush 必须经此屏障）。
 * 🔴 校验（docs §R03）：捕获时实例已非当前实例（新实例接管/旧实例迟到）、
 *    或捕获后 revision 已前进（有更新输入）——旧快照一律丢弃，不得覆盖新内容。
 * 🔴 N04：携带 sessionGeneration 时校验会话代际——旧会话（同路径已重开）的
 *    迟到提交一律丢弃；编辑器注册空窗（无注册实例）不再无条件接纳任意快照。
 * 返回是否已提交。
 */
export function submitCapturedContent(
  docKey: string,
  captured: { instanceId: string; revision: number; content: string | null },
  sessionGeneration?: number,
): boolean {
  // 只读变体（图片）无正文，不写镜像
  if (captured.content === null) return true;
  // 🔴 N04：旧会话代际的提交（同路径已关闭/重开）一律丢弃
  if (sessionGeneration !== undefined && !isSessionCurrent(docKey, sessionGeneration)) {
    return false;
  }
  const capabilities = getEditorCapabilities(docKey);
  // 当前注册实例与捕获实例不一致 → 旧实例迟到结果，丢弃。
  if (capabilities && capabilities.instanceId !== captured.instanceId) return false;
  // 捕获后已有更新输入（revision 前进）→ 旧快照倒退镜像，丢弃
  if (getDocumentRevision(docKey) > captured.revision) return false;
  const store = useDocumentStore.getState();
  if (store.getDocument(docKey)?.content !== captured.content) {
    store.setContent(docKey, captured.content);
  }
  return true;
}

// ── 统一异步屏障 ──

/**
 * 捕获某个确切 revision 的权威内容快照并刷新镜像。
 * 已挂载实例：经能力注册表 flush（内核权威内容，内部经 submitCapturedContent 提交）；
 * 未挂载/flush 失败：返回 null（调用方使用 store 中最近镜像，旧语义）。
 * 🔴 N04：flush 期间会话换代（同路径重开）→ 迟到快照作废，返回 null；
 *    调用方不得再把 null 快照当有效内容写盘（配合 N02 的空正文屏障）。
 */
export async function flushDocument(
  docKey: string,
  reason: FlushReason,
): Promise<CapturedContent | null> {
  const generation = getSessionGeneration(docKey);
  const capabilities = getEditorCapabilities(docKey);
  if (!capabilities) return null;
  const captured = await capabilities.flush(reason);
  if (captured) {
    // 🔴 N04：flush 是异步屏障——等待期间同路径会话已换代时，迟到快照作废
    if (!isSessionCurrent(docKey, generation)) return null;
    setMirroredRevision(docKey, captured.revision);
  }
  return captured;
}

// ── 🔴 R3-05：关闭状态（closing）——停止接纳写任务 ──
//
// 统一异步关闭事务的第一步（在任何 await 之前同步完成）：进入 closing 后，
// 该会话的写队列不再接纳新任务（旧任务仍可完成排空——在途 I/O 不中断）。
// 🔴 R4-05/D04/D05：closing 绑定**具体会话代际**（不是路径永久墓碑）——
//   1. beginClosing 总是记录**当前**代际（重开后的新会话第二次关闭时，关闭
//      代际随新会话推进——旧值不残留，第二次关闭同样阻止该会话的迟到写入）。
//   2. 关闭事务完成（drain + 条件注销后）**释放 closing 条目**（不再永久保留）；
//      旧会话任务的作废由"活动表已清除（get 回 0）≠ 旧任务捕获的 token"实现
//      （isSessionCurrent 校验），无需靠 closing 墓碑兜底。
//   3. 同代重复调用幂等（值相同写入无操作）；释放后（条目不存在）再次进入
//      照常记录。

/** docKey → 关闭中的会话代际（条目存在即 closing；值 = 进入 closing 时的代际） */
const closingGenerations = new Map<string, number>();

/**
 * 进入关闭状态（停止接纳写任务）。
 * 🔴 R4-05：总是记录当前代际——同代重复调用幂等（同值无操作）；
 *    会话换代后的新关闭事务以新代际覆盖（第二次关闭保护，D05）。
 */
export function beginClosing(docKey: string): void {
  const current = getSessionGeneration(docKey);
  // 同代幂等：已是当前代际则不变（不重置任何进行中的关闭事务）；换代则更新
  if (closingGenerations.get(docKey) !== current) {
    closingGenerations.set(docKey, current);
  }
}

/**
 * 退出关闭状态（关闭事务完成——drain + 条件注销后释放条目）。
 * 🔴 R4-05：释放后旧会话任务靠活动表 token 校验作废（不再保留 closing 墓碑，
 *    30 个路径关闭后 closing 表回落，D04）；只清除**同代**条目（换代后的
 *    新关闭事务不被旧事务的 finally 误清）。
 */
export function endClosing(docKey: string): void {
  // 无条件移除（调用方保证本事务持有该代际；换代场景由 beginClosing 覆盖
  // 已使旧条目失效——新条目记录新代际，此处的移除若发生在换代后则移除的
  // 是新事务条目，因此调用方必须在 finally 中先比对代际）
  closingGenerations.delete(docKey);
}

/** 该会话是否处于关闭中（closing 期间——drain 尚未完成）。
 * 判定：条目存在且当前代际 = 关闭代际（代际已推进说明是重开的新会话——
 * 恢复接纳；条目已释放说明关闭事务完成——新任务靠 token 校验兜底）。
 */
export function isClosing(docKey: string): boolean {
  const closedAt = closingGenerations.get(docKey);
  if (closedAt === undefined) return false;
  // 条目记录的是进入 closing 时的代际：当前代际相同 → 本会话 closing 中；
  // 代际已推进（同路径重开建立新会话）→ 新会话不受旧 closing 约束
  return getSessionGeneration(docKey) === closedAt;
}

/** 🔴 R4-05：读取 closing 条目的代际（无条目 undefined；关闭事务释放判断用） */
export function getClosingGeneration(docKey: string): number | undefined {
  return closingGenerations.get(docKey);
}

/**
 * 🔴 R4-05/D04：closing 条目释放后的活动表回落——disposeTabLifecycleAsync
 * 在 finally 释放 closing 后调用（closing 存在期间活动表条目被保留以支撑
 * drain 事务的代际校验；事务完成后若已孤立则彻底清理，不长期泄漏）。
 */
export function releaseSessionAfterClosing(docKey: string): void {
  releaseIfOrphaned(docKey);
}

/** 每文档串行写队列 ──

/** docKey → 上一次写任务（settled），新任务串接其后 */
const writeQueues = new Map<string, Promise<unknown>>();

/**
 * 把一次写盘任务排入该文档的串行队列。
 * 返回本次任务的 Promise（失败向上抛）；队列本身永不因单个失败而断裂。
 * 🔴 N04：队列尾部自清理——任务 settle 后若仍是尾指针则移除记录（关闭后的
 *    Map 条目不长期泄漏）；新会话（同路径重开）的写任务串接在旧队列之后，
 *    不越过未完成的旧磁盘写入（取消语义由任务内部的代际校验实现）。
 */
export function enqueueDocumentWrite<T>(
  docKey: string,
  writer: () => Promise<T>,
): Promise<T> {
  // 🔴 R3-05：closing 状态停止接纳——窗口整体关闭/标签关闭期间的新写任务被拒绝
  //    （旧任务正常排空；任务内部代际校验保证旧会话任务不越权）
  if (isClosing(docKey)) {
    return Promise.reject(new Error(`文档正在关闭，拒绝新的写任务: ${docKey}`));
  }
  const previous = writeQueues.get(docKey) ?? Promise.resolve();
  const current = previous.then(writer);
  // 队列链只接 settled 状态：单个失败不断链，也不吞掉调用方错误
  const settled = current.catch(() => {});
  settled.then(() => {
    if (writeQueues.get(docKey) === settled) writeQueues.delete(docKey);
  });
  writeQueues.set(docKey, settled);
  return current;
}

/** 等待该文档全部在途写完成（关闭/迁移屏障用） */
export async function drainDocumentWrites(docKey: string): Promise<void> {
  const pending = writeQueues.get(docKey);
  if (pending) await pending.catch(() => {});
}

// ── 🔴 N04：条件清理（旧会话的清理任务不得删除新会话） ──

/**
 * 仅当当前会话仍是指定代际时删除文档记录。
 * 关闭路径的异步清理（动态 import/延迟回调）必须携带关闭时的代际；
 * 同路径已重开（代际推进）时跳过，新会话不受旧清理影响。
 */
export function removeDocumentIfSessionMatches(docKey: string, generation: number): void {
  if (!isSessionCurrent(docKey, generation)) return;
  useDocumentStore.getState().remove(docKey);
}

// ── 写入成功后的脏态精确重算（flush-and-compare） ──

/**
 * 保存成功后重算脏态：flush 当前权威内容与基线逐字比较。
 * 覆盖 H 节时序：撤销/手动改回原文 → dirty 清除；写盘期间新输入 → dirty 保持。
 */
async function refreshDirtyAfterWrite(docKey: string): Promise<boolean> {
  const captured = await flushDocument(docKey, 'save');
  const store = useDocumentStore.getState();
  const doc = store.getDocument(docKey);
  if (!doc) return false;
  // 🔴 N02：正文未知（无编辑器实例且镜像为 null）时不得用 '' 假装已知内容——
  //    保守保持脏态，避免误清关闭保护
  const currentContent = captured?.content ?? doc.content;
  if (currentContent === null) {
    store.setDirty(docKey, true);
    useWindowStore.getState().setTabDirty(docKey, true);
    return true;
  }
  const baseline = doc.baselineContent ?? '';
  const isDirty = normalizeEol(currentContent) !== normalizeEol(baseline);
  store.setDirty(docKey, isDirty);
  useWindowStore.getState().setTabDirty(docKey, isDirty);
  try {
    await ipc.setDocumentDirty(docKey, isDirty);
  } catch {
    // 非关键
  }
  return isDirty;
}

// ── 统一自动保存（全部 autosave 入口） ──

/**
 * 排队自动保存：策略/外部状态检查 → 每文档写队列内写盘 →
 * 成功后基线更新为实际写入内容 + 脏态精确重算 + 带证明的暂存清理。
 * CodeEditor / Markdown visual / Markdown source / BoardEditor 的 autosave 统一走这里。
 */
export async function queuedAutoSave(docKey: string, content: string): Promise<void> {
  const store = useDocumentStore.getState();
  const targetDoc = store.getDocument(docKey);
  if (!targetDoc) return;

  // 🔴 N04：排队时捕获会话代际——关闭/重开后换代的旧任务在执行时作废
  const generation = getSessionGeneration(docKey);

  // 只有 auto 策略才自动保存
  if (targetDoc.savePolicy !== 'auto') return;
  // 外部变更/断开状态不自动保存
  if (targetDoc.externalStatus === 'modified' || targetDoc.externalStatus === 'deleted') return;
  // 与基线一致无需保存
  const baseline = getBaseline(docKey);
  if (baseline.isClean(content)) {
    store.setDirty(docKey, false);
    useWindowStore.getState().setTabDirty(docKey, false);
    return;
  }

  const encoding = targetDoc.encoding;
  const eol = targetDoc.eol;
  // 捕获本次写入对应的 revision（写盘期间的新编辑由后续任务/脏态重算处理）
  const revision = getDocumentRevision(docKey);

  await enqueueDocumentWrite(docKey, async () => {
    // 🔴 R03：排队到执行之间重新验证生命周期——文档仍存在、策略仍 auto、
    //    外部状态未变（用户切手动策略/文件被外部修改后，旧排队任务不得落盘）
    // 🔴 N04：会话代际校验——同路径关闭重开后，旧会话排队任务不得覆盖新会话写盘
    if (!isSessionCurrent(docKey, generation)) return;
    const doc = useDocumentStore.getState().getDocument(docKey);
    if (!doc) return;
    if (doc.savePolicy !== 'auto') return;
    if (doc.externalStatus === 'modified' || doc.externalStatus === 'deleted') return;
    const result = await ipc.writeDocument(docKey, content, encoding, eol);
    // 写盘 I/O 返回后再次校验：等待磁盘期间会话换代则不推进基线/暂存清理
    if (!isSessionCurrent(docKey, generation)) return;
    noteSelfWrite(docKey);
    if (result.ok) {
      // 🔴 基线只更新为实际写成功的文本
      useDocumentStore.getState().updateBaseline(docKey, content, result.mtime, result.size);
      baseline.updateBaseline(content);
      savedRevisions.set(docKey, revision);
      // 精确重算脏态（写盘期间的新输入仍为脏；改回基线则清脏）
      await refreshDirtyAfterWrite(docKey);
      // 携带内容证明的暂存清理：只删被覆盖的副本
      await onDocumentSaved(docKey, content);
    }
  }).catch((e) => {
    console.error('自动保存失败:', e);
  });
}

// ── 手动保存的共享写盘路径 ──

/**
 * 手动保存（Ctrl+S）的写盘执行：在每文档写队列内完成写盘、基线更新、
 * 脏态重算与暂存清理。调用方（saveDocument）负责 flush 与前置检查。
 */
export async function writeDocumentWithBarrier(
  docKey: string,
  content: string,
): Promise<boolean> {
  // 🔴 R3-05/C09：closing 状态的旧会话拒绝写盘（返回 false——调用方得到明确失败，
  //    不以异常炸保存链；排空中的在途任务仍正常完成）
  if (isClosing(docKey)) return false;
  const store = useDocumentStore.getState();
  const doc = store.getDocument(docKey);
  if (!doc) return false;
  const encoding = doc.encoding;
  const eol = doc.eol;
  const revision = getDocumentRevision(docKey);
  // 🔴 N04：排队时捕获会话代际（同路径重开后旧任务作废）
  const generation = getSessionGeneration(docKey);

  return enqueueDocumentWrite(docKey, async () => {
    // 🔴 N04：会话代际校验（排队到执行之间可能已换代）
    if (!isSessionCurrent(docKey, generation)) return false;
    const current = useDocumentStore.getState().getDocument(docKey);
    if (!current) return false;
    const result = await ipc.writeDocument(docKey, content, encoding, eol);
    // 🔴 N04：写盘 I/O 返回后再校验（等待磁盘期间换代则不推进基线）
    if (!isSessionCurrent(docKey, generation)) return false;
    noteSelfWrite(docKey);
    if (!result.ok) {
      if (result.error) {
        const { showWriteError } = await import(
          '../editor-code/orchestration/saveDocument'
        );
        showWriteError(result.error);
      }
      return false;
    }
    useDocumentStore.getState().updateBaseline(docKey, content, result.mtime, result.size);
    getBaseline(docKey).updateBaseline(content);
    savedRevisions.set(docKey, revision);
    await refreshDirtyAfterWrite(docKey);
    await onDocumentSaved(docKey, content);
    return true;
  });
}

/** 仅供测试：读取会话/队列/关闭内部状态 */
export function __debugSessionState(): { active: Map<string, number>; queues: Map<string, unknown>; closing: Map<string, number> } {
  return { active: new Map(activeSessionGenerations), queues: new Map(writeQueues), closing: new Map(closingGenerations) };
}
