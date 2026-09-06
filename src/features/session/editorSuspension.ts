// NoteBoard 编辑器回收调度（S11 I 节：生命周期与回收状态）
//
// 🔴 不变量（docs/启动性能与低内存根治计划.md §I）：
//   1. 默认缓存 = 活动文档 + 最近 1 个已验证可回收的轻量实例；重型实例不保活。
//   2. 回收流程：canSuspend → flush（权威内容进 store）→ 捕获视图状态 →
//      校验 revision/instanceId 未变 → 更新保活集合（渲染层随后卸载）。
//      关键内容捕获不依赖 useEffect cleanup（React 不等待异步清理）；
//      cleanup 只做已交接资源的幂等释放。
//   3. suspended 只表示渲染实例已释放：文档所有权、历史、内容仍在（store/history 模块）。
//   4. 视图状态在卸载前同步捕获（选区/滚动/折叠/查看变换），挂载时一次性恢复。
//   5. dirty 不是禁止回收的理由：flush 已捕获权威内容；迁移保护中的文档不回收。

import { getEditorCapabilities } from '../../core/editor/editorRegistry';
import { useWindowStore } from '../../stores/windowStore';

/** 恢复状态存储：docKey → 编辑器视图状态（挂载恢复后取走） */
const suspendedViewStates = new Map<string, unknown>();

/** 最近 1 个验证可回收的轻量实例（保活） */
let keepAliveKey: string | null = null;

/** 视图状态保存（卸载前调用；编辑器侧同步捕获） */
export function saveViewState(docKey: string, state: unknown): void {
  suspendedViewStates.set(docKey, state);
}

/**
 * 取走保存的视图状态（挂载恢复后调用，一次性消费）。
 * 同路径文档关闭再打开是新的文档生命周期，旧状态不再适用。
 */
export function takeViewState(docKey: string): unknown | null {
  const state = suspendedViewStates.get(docKey) ?? null;
  if (state !== null) suspendedViewStates.delete(docKey);
  return state;
}

/** 清除某文档的恢复状态（关闭/丢弃） */
export function clearViewState(docKey: string): void {
  suspendedViewStates.delete(docKey);
}

/** 标签关闭时清恢复状态与保活标记 */
export function markClosed(docKey: string): void {
  suspendedViewStates.delete(docKey);
  if (keepAliveKey === docKey) keepAliveKey = null;
}

/** 读取保活 key（渲染层保活判断） */
export function getKeepAliveKey(): string | null {
  return keepAliveKey;
}

/**
 * 回收调度：对切走的标签执行 flush → 视图状态捕获 → 保活更新。
 * 返回 true 表示该标签已完成回收准备（渲染层可卸载）。
 * 🔴 非活动标签上通常没有进行中的 IME/拖拽（焦点已切走）；
 *    迁移保护中的文档不回收（transferringKeys 检查）。
 */
export async function suspendEditorInstance(docKey: string): Promise<boolean> {
  // 迁移保护中不回收
  if (useWindowStore.getState().isTransferring(docKey)) return false;

  const capabilities = getEditorCapabilities(docKey);
  if (!capabilities) {
    // 无实例（如懒标签）：无内容/状态需要捕获
    return true;
  }
  // 未验证回收能力的类型不回收（保留实例）
  if (!capabilities.canSuspend()) return false;

  // 1. flush：权威内容进 store（脏内容受保护；历史当前内容同步）
  const captured = await capabilities.flush('evict');
  if (!captured) return false;

  // 2. 校验 flush 期间 revision 未变（变化说明有并发编辑，本次不回收）
  const revisionAfter = capabilities.getRevision();
  if (revisionAfter !== captured.revision) return false;

  // 3. 视图状态捕获（编辑器侧同步读取内核状态）
  const viewState = capabilities.captureViewState?.() ?? null;
  if (viewState !== null) {
    saveViewState(docKey, viewState);
  }

  // 4. 保活更新：新回收者成为最近保活（旧保活者由渲染层在下一次收敛中卸载）
  keepAliveKey = docKey;
  return true;
}

/** 仅测试：重置全部回收状态 */
export function resetSuspensionForTest(): void {
  suspendedViewStates.clear();
  keepAliveKey = null;
}
