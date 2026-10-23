// NoteBoard 文档历史记录：还原历史版本
//
// 流程：
//   1. 读取所选版本正文
//   2. 捕获编辑器当前内容并记为「还原前的编辑」（未保存的修改也不会丢）
//   3. 以一次新编辑的方式替换编辑器内容（Ctrl+Z 可撤销还原）
//   4. 标记下一次写盘为「还原」，再走普通保存流程写盘（编码、行尾、写队列与其他保存一致）

import * as ipc from '../../core/ipc/commands';
import type { HistoryEntry } from '../../core/ipc/types';
import { flushDocument } from '../session/documentSession';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { applyDocumentContentAsChange } from '../history/documentHistory';
import { saveDocument } from '../editor-code/orchestration/saveDocument';
import { loadVersionContent } from './versionContent';

export type RestoreResult = { ok: true } | { ok: false; message: string };

/** 不能还原的原因；可以还原时返回 null */
export function restoreBlockedReason(docKey: string | null): string | null {
  if (!docKey) return '文档已关闭';
  const tab = useWindowStore.getState().getTab(docKey);
  if (!tab || !tab.path) return '文档已关闭';
  if (tab.isDetached || tab.externalStatus === 'deleted') return '原文件已删除';
  const doc = useDocumentStore.getState().getDocument(docKey);
  if (doc?.readonly) return '文件为只读';
  return null;
}

export async function restoreVersion(docKey: string, entry: HistoryEntry): Promise<RestoreResult> {
  const blocked = restoreBlockedReason(docKey);
  if (blocked) return { ok: false, message: blocked };
  const tab = useWindowStore.getState().getTab(docKey);
  const path = tab?.path;
  if (!path) return { ok: false, message: '文档已关闭' };

  let content: string;
  try {
    content = await loadVersionContent(path, entry.id, !entry.open);
  } catch (error) {
    return { ok: false, message: `读取历史版本失败：${error instanceof Error ? error.message : String(error)}` };
  }

  // 当前内容（含未保存的修改）先留一版
  const captured = await flushDocument(docKey, 'save');
  const current = captured?.content ?? useDocumentStore.getState().getDocument(docKey)?.content ?? null;
  if (current !== null && current !== content) {
    await ipc.historyCheckpoint(path, 'before-restore', current).catch(() => {});
  }

  if (!applyDocumentContentAsChange(docKey, content)) {
    return { ok: false, message: '编辑器尚未就绪，请稍后再试' };
  }
  await ipc.historyCheckpoint(path, 'restore', null, entry.id).catch(() => {});
  const saved = await saveDocument(docKey);
  if (!saved) return { ok: false, message: '已还原到编辑器，但保存失败' };
  return { ok: true };
}
