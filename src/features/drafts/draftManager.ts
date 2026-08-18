// NoteBoard 草稿机制
// 脏文档每 10s + 失焦写 drafts/；保存成功删除；启动扫描 + 恢复 UI；7 天孤儿清理
// 详见 docs/09-开发路线图.md 13.4

import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';

/** 草稿保存间隔（10s） */
const DRAFT_INTERVAL = 10_000;

/** 孤儿草稿清理天数（7天） */
const ORPHAN_DAYS = 7;

let draftTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 获取草稿目录路径
 */
function getDraftsDir(): string {
  // 草稿存储在应用数据目录的 drafts/ 子目录
  return 'drafts';
}

/**
 * 保存草稿
 */
async function saveDraft(docKey: string, content: string): Promise<void> {
  try {
    const draftPath = `${getDraftsDir()}/${docKey.replace(/[\\/:*?"<>|]/g, '_')}.draft`;
    await ipc.writeDocument(draftPath, content, 'utf8', 'lf');
  } catch (e) {
    console.error('[draftManager] 草稿保存失败:', e);
  }
}

/**
 * 删除草稿（保存成功后调用）
 */
async function deleteDraft(docKey: string): Promise<void> {
  try {
    const draftPath = `${getDraftsDir()}/${docKey.replace(/[\\/:*?"<>|]/g, '_')}.draft`;
    // 尝试删除，不存在则忽略
    await ipc.moveToTrash(draftPath).catch(() => {});
  } catch {
    // 忽略
  }
}

/**
 * 扫描草稿目录
 */
export async function scanDrafts(): Promise<{ docKey: string; content: string; mtime: number }[]> {
  try {
    const entries = await ipc.readDir(getDraftsDir(), false);
    const drafts: { docKey: string; content: string; mtime: number }[] = [];
    const now = Date.now();
    const orphanThreshold = now - ORPHAN_DAYS * 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      if (!entry.name.endsWith('.draft')) continue;
      const mtime = entry.mtime ?? 0;
      if (mtime < orphanThreshold) {
        // 7天孤儿，删除
        await ipc.moveToTrash(`${getDraftsDir()}/${entry.name}`).catch(() => {});
        continue;
      }

      const docKey = entry.name.replace('.draft', '').replace(/_/g, '/');
      const content = ''; // 需要读取文件内容
      drafts.push({ docKey, content, mtime: mtime });
    }

    return drafts;
  } catch {
    return [];
  }
}

/**
 * 启动草稿定时保存
 */
export function startDraftManager(): () => void {
  if (draftTimer) clearInterval(draftTimer);

  draftTimer = setInterval(async () => {
    const store = useDocumentStore.getState();
    const docs = store.documents;

    for (const [key, doc] of docs) {
      if (doc.isDirty && doc.content) {
        await saveDraft(key, doc.content);
      }
    }
  }, DRAFT_INTERVAL);

  // 失焦时保存
  const handleBlur = () => {
    const store = useDocumentStore.getState();
    for (const [key, doc] of store.documents) {
      if (doc.isDirty && doc.content) {
        saveDraft(key, doc.content);
      }
    }
  };

  window.addEventListener('blur', handleBlur);

  return () => {
    if (draftTimer) clearInterval(draftTimer);
    window.removeEventListener('blur', handleBlur);
  };
}

/**
 * 保存成功后清理草稿
 */
export async function onDocumentSaved(docKey: string): Promise<void> {
  await deleteDraft(docKey);
}
