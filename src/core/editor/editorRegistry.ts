// NoteBoard 编辑器能力注册表（每 WebView 一份）
// 🔴 依赖红线：本模块只依赖 editorTypes 的轻量类型，
//    禁止 import 任何编辑器组件/内核，保证它可留在最小首屏闭包内。
//
// 键为 docKey；每个 key 至多一个"当前实例"的能力对象。
// 实例以 instanceId 代际区分：register 返回的 disposer 只在注册表中
// 仍是同代实例时才移除，旧实例的清理无权删除新实例（与 S02 实例表同规则）。
//
// revision 计数独立于注册表存活：编辑器重挂载不重置版本，
// 使 flush 快照可跨实例校验；文档最终关闭时由调用方 clear。

import type { EditorCapabilities } from './editorTypes';

interface RegisteredCapabilities {
  instanceId: string;
  capabilities: EditorCapabilities;
}

/** docKey → 当前实例能力 */
const registry = new Map<string, RegisteredCapabilities>();

/** docKey → 内容版本计数（重挂载不重置，文档关闭才清理） */
const revisions = new Map<string, number>();

/**
 * 注册当前实例的能力对象，返回 disposer。
 * 同 key 重复注册以后注册者为准（新实例覆盖旧实例）。
 */
export function registerEditorCapabilities(capabilities: EditorCapabilities): () => void {
  const { docKey, instanceId } = capabilities;
  registry.set(docKey, { instanceId, capabilities });
  return () => {
    // 🔴 代际保护：仅当注册表中仍是本实例时才移除
    const current = registry.get(docKey);
    if (current?.instanceId === instanceId) {
      registry.delete(docKey);
    }
  };
}

/** 查询指定文档当前挂载实例的能力；未挂载返回 null（区分：session 可能仍有可靠内容） */
export function getEditorCapabilities(docKey: string): EditorCapabilities | null {
  return registry.get(docKey)?.capabilities ?? null;
}

/** 内容版本递增（编辑器侧在每次真实内容修改时调用），返回新版本号 */
export function bumpDocumentRevision(docKey: string): number {
  const next = (revisions.get(docKey) ?? 0) + 1;
  revisions.set(docKey, next);
  return next;
}

/** 读取当前内容版本号（未修改过的文档为 0） */
export function getDocumentRevision(docKey: string): number {
  return revisions.get(docKey) ?? 0;
}

// 🔴 N04：身份迁移（另存为）时转移内容版本——内容未变，版本号随身份连续，
//    新会话的 savedRevision/mirroredRevision 校验才有真实版本可比。
export function moveDocumentRevision(fromKey: string, toKey: string): void {
  const revision = revisions.get(fromKey);
  if (revision !== undefined) revisions.set(toKey, revision);
  revisions.delete(fromKey);
}

/** 文档最终关闭（非标签切换）时清理版本计数，避免长期运行累积 */
export function clearDocumentRevision(docKey: string): void {
  revisions.delete(docKey);
}

/** 仅供测试：重置全部注册表状态 */
export function resetEditorRegistryForTest(): void {
  registry.clear();
  revisions.clear();
}
