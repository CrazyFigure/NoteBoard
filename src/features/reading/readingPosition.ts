// 按文件保存轻量阅读状态；不保存正文，不影响文档脏态、撤销历史或同步内容。
import type { EditorViewState } from '../../core/editor/editorTypes';
import { useSettingsStore } from '../../stores/settingsStore';
import { getWebAccount } from '../account/accountState';

type TextPosition = Extract<EditorViewState, { kind: 'code' | 'markdown' }>;
type SplitPosition = {
  kind: 'split-diagram';
  selection: { anchor: number; head: number } | null;
  scrollTop: number;
  layoutMode: 'split' | 'source' | 'preview';
  zoom: number;
  pan: { x: number; y: number };
};
export type ReadingPosition = TextPosition | SplitPosition;
type SavedPosition = { key: string; state: ReadingPosition; updatedAt: number };

// 有界保存最近 200 个文件；滚动期间合并写入，窗口失焦或关闭前同步落盘。
const MAX_FILES = 200;
const WRITE_DELAY_MS = 300;
const pending = new Map<string, Map<string, SavedPosition>>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;

/** 网页账号拥有不同的虚拟工作区，同一路径的阅读位置不能在账号间混用。 */
function storageKey(): string {
  return `nb-reading-positions:v1:${encodeURIComponent(getWebAccount()?.username ?? '')}`;
}

/** 只接受有限的非负坐标；损坏的本地缓存不能阻断文件打开。 */
function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 复制允许恢复的文本视图字段，排除正文以及其他编辑器的状态。 */
function normalizePosition(value: unknown): ReadingPosition | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  if (!isOffset(state.scrollTop)) return null;
  const selection = state.selection as { anchor?: unknown; head?: unknown } | null;
  if (selection !== null && (!selection || !isOffset(selection.anchor) || !isOffset(selection.head))) return null;
  const common = {
    selection: selection ? { anchor: Math.floor(selection.anchor as number), head: Math.floor(selection.head as number) } : null,
    scrollTop: state.scrollTop,
  };
  if (state.kind === 'markdown' && (state.mode === 'visual' || state.mode === 'source')) {
    return { kind: 'markdown', ...common, mode: state.mode };
  }
  if (state.kind === 'code') {
    // 折叠会改变正文高度，恢复阅读位置时须一并保留合法的折叠区间。
    const foldedRanges = Array.isArray(state.foldedRanges) ? state.foldedRanges.slice(0, 1000).filter((range) =>
      range && isOffset(range.from) && isOffset(range.to) && range.from < range.to,
    ).map(({ from, to }) => ({ from, to })) : [];
    return { kind: 'code', ...common, foldedRanges };
  }
  if (state.kind === 'split-diagram' && ['split', 'source', 'preview'].includes(String(state.layoutMode))) {
    const pan = state.pan as { x?: unknown; y?: unknown } | undefined;
    return {
      kind: 'split-diagram', ...common, layoutMode: state.layoutMode as SplitPosition['layoutMode'],
      zoom: isOffset(state.zoom) && state.zoom > 0 ? state.zoom : 1,
      pan: { x: typeof pan?.x === 'number' && Number.isFinite(pan.x) ? pan.x : 0, y: typeof pan?.y === 'number' && Number.isFinite(pan.y) ? pan.y : 0 },
    };
  }
  return null;
}

/** 存储不可用或数据损坏时退回空缓存，仍允许正常阅读、编辑和保存。 */
function readStored(key: string): SavedPosition[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(data)) return [];
    return data.slice(0, MAX_FILES).flatMap((item) => {
      const state = normalizePosition(item?.state);
      return typeof item?.key === 'string' && state && isOffset(item.updatedAt)
        ? [{ key: item.key, state, updatedAt: item.updatedAt }] : [];
    });
  } catch {
    return [];
  }
}

/** 关闭开关只影响重新打开；同一标签内的切换、回收恢复仍按原逻辑保留位置。 */
export function readReadingPosition(docKey: string): ReadingPosition | null {
  if (docKey.startsWith('untitled:') || useSettingsStore.getState().settings.file.restoreReadingPosition === false) return null;
  const key = storageKey();
  return pending.get(key)?.get(docKey)?.state ?? readStored(key).find((item) => item.key === docKey)?.state ?? null;
}

/** 只记录有文件身份的 Markdown / 文本视图，滚动热路径不序列化正文。 */
export function saveReadingPosition(docKey: string, value: unknown): void {
  if (docKey.startsWith('untitled:') || useSettingsStore.getState().settings.file.restoreReadingPosition === false) return;
  const state = normalizePosition(value);
  if (!state) return;
  const key = storageKey();
  const updates = pending.get(key) ?? new Map<string, SavedPosition>();
  updates.delete(docKey);
  updates.set(docKey, { key: docKey, state, updatedAt: Date.now() });
  if (updates.size > MAX_FILES) updates.delete(updates.keys().next().value!);
  pending.set(key, updates);
  // 固定窗口合并写入，持续滚动也会定期落盘，不一直推迟到停止滚动。
  if (!writeTimer) writeTimer = setTimeout(flushReadingPositions, WRITE_DELAY_MS);
}

/** 写入前合并其他窗口已保存的文件，避免一份陈旧全量缓存覆盖另一窗口的记录。 */
export function flushReadingPositions(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  for (const [key, updates] of pending) {
    const merged = new Map(readStored(key).map((item) => [item.key, item]));
    for (const [docKey, item] of updates) merged.set(docKey, item);
    try {
      localStorage.setItem(key, JSON.stringify([...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_FILES)));
      pending.delete(key);
    } catch {
      // 存储被禁用或空间不足时保留本次进程内的有界记录，不影响文档操作。
    }
  }
}

/** 仅测试：清理待写队列，持久记录由测试自身的存储隔离控制。 */
export function resetReadingPositionsForTest(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  pending.clear();
}
