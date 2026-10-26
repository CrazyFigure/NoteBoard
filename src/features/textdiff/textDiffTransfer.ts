// 文本对比不进入文档保存/暂存链；窗口迁移只捕获内存快照。
export interface TextDiffSnapshot {
  a: { doc: string; selection?: unknown; history?: unknown };
  b: { doc: string; selection?: unknown; history?: unknown };
  leftName: string;
  rightName: string;
  collapseOn: boolean;
  softWrap: boolean;
  leftWidth: string;
  scrollA: { top: number; left: number };
  scrollB: { top: number; left: number };
}

const captures = new Map<string, () => TextDiffSnapshot>();
const pending = new Map<string, TextDiffSnapshot>();

/** 挂载的工具注册权威捕获器；卸载必须移除，避免保留编辑器实例。 */
export function registerTextDiffCapture(key: string, capture: () => TextDiffSnapshot): () => void {
  captures.set(key, capture);
  return () => { if (captures.get(key) === capture) captures.delete(key); };
}

/** 未挂载的空工具也可迁移，缺省快照在目标使用正常初始状态。 */
export function captureTextDiff(key: string): TextDiffSnapshot | null {
  return captures.get(key)?.() ?? pending.get(key) ?? null;
}

/** 接收时先保存，目标组件挂载后读取；不写 localStorage 或磁盘。 */
export function restoreTextDiff(key: string, snapshot: TextDiffSnapshot | null): void {
  if (snapshot) pending.set(key, snapshot);
}

/** 组件已接纳或目标迁移中止时释放待恢复的正文引用。 */
export function clearTextDiffTransfer(key: string): void { pending.delete(key); }
