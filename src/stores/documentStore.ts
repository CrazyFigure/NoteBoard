// NoteBoard documentStore
// documents Map + 脏态 + ViewState（每窗口一份）
// 编辑器内核持有内容的权威副本，store 里的 content 是防抖后的镜像
// 详见 docs/05-ADR/ADR-010-状态管理与跨窗口同步.md §2/§3

import { create } from 'zustand';
import type { DocumentPayload } from '../core/ipc/types';
import { useSettingsStore } from './settingsStore';

export interface Document {
  /** 规范化路径 key */
  key: string;
  /** 显示名 */
  displayName: string;
  /** 父目录 */
  dirPath: string;
  /** 文档类型 */
  kind: DocumentPayload['kind'];
  /** 语言 */
  language: DocumentPayload['language'];
  /** 内容镜像（防抖后，不是权威副本） */
  content: string | null;
  /** 编码 */
  encoding: DocumentPayload['encoding'];
  /** 行尾符 */
  eol: DocumentPayload['eol'];
  /** 文件大小 */
  size: number;
  /** 修改时间（毫秒） */
  mtime: number;
  /** 只读 */
  readonly: boolean;
  /** 脏态 */
  isDirty: boolean;
  /** 保存策略 */
  savePolicy: 'auto' | 'manual';
  /** 上次保存的基线内容（用于判断是否脏） */
  baselineContent: string | null;
  /** 外部变更状态 */
  externalStatus: 'clean' | 'modified' | 'deleted' | 'renamed' | null;
  /** 大文档判定结果 */
  largeDocVerdict: null | { isLarge: boolean; charCount: number; threshold: number };
}

interface DocumentStore {
  documents: Map<string, Document>;

  // ── 查询 ──
  getDocument: (key: string) => Document | undefined;
  hasDocument: (key: string) => boolean;

  // ── 操作 ──
  /** 从 DocumentPayload 创建 Document */
  upsertFromPayload: (payload: DocumentPayload) => Document;
  /** 更新内容镜像（防抖后调用） */
  setContent: (key: string, content: string) => void;
  /** 标记为脏/干净 */
  setDirty: (key: string, isDirty: boolean) => void;
  /** 设置基准内容并对齐脏态 */
  setBaselineContent: (key: string, baselineContent: string) => void;
  /** 更新基线（保存后调用） */
  updateBaseline: (key: string, mtime: number, size: number) => void;
  /** 同步刷新所有文档的保存策略（设置改变时调用） */
  syncSavePolicies: () => void;
  /** 设置外部变更状态 */
  setExternalStatus: (key: string, status: Document['externalStatus']) => void;
  /** 设置大文档判定 */
  setLargeDocVerdict: (key: string, verdict: Document['largeDocVerdict']) => void;
  /** 删除文档 */
  remove: (key: string) => void;
  /** 重置 */
  clear: () => void;
}

function normalizeEol(text: string | null | undefined): string {
  if (text == null) return '';
  return text.replace(/\r\n/g, '\n');
}

/**
 * 根据文件设置判定指定文档类型的保存策略（auto / manual）
 */
export function resolveSavePolicy(kind: DocumentPayload['kind']): 'auto' | 'manual' {
  const fileSettings = useSettingsStore.getState().settings.file;
  if (!fileSettings) return 'manual';
  if (kind === 'markdown') {
    return fileSettings.autoSaveMarkdown ? 'auto' : 'manual';
  }
  if (kind === 'board') {
    return fileSettings.autoSaveBoard ? 'auto' : 'manual';
  }
  if (kind === 'code') {
    return fileSettings.autoSaveOther ? 'auto' : 'manual';
  }
  return 'manual';
}

export const useDocumentStore = create<DocumentStore>((set, get) => ({
  documents: new Map(),

  getDocument: (key) => get().documents.get(key),
  hasDocument: (key) => get().documents.has(key),

  upsertFromPayload: (payload) => {
    const existing = get().documents.get(payload.key);
    const doc: Document = {
      key: payload.key,
      displayName: payload.displayName,
      dirPath: payload.dirPath,
      kind: payload.kind,
      language: payload.language,
      content: payload.content,
      encoding: payload.encoding,
      eol: payload.eol,
      size: payload.size,
      mtime: payload.mtime,
      readonly: payload.readonly,
      isDirty: existing?.isDirty ?? false,
      savePolicy: existing?.savePolicy ?? resolveSavePolicy(payload.kind),
      baselineContent: existing?.baselineContent ?? payload.content,
      externalStatus: 'clean',
      largeDocVerdict: existing?.largeDocVerdict ?? null,
    };

    set((state) => {
      const newMap = new Map(state.documents);
      newMap.set(payload.key, doc);
      return { documents: newMap };
    });

    return doc;
  },

  setContent: (key, content) => {
    set((state) => {
      const doc = state.documents.get(key);
      if (!doc) return {};
      const newMap = new Map(state.documents);
      // 判断脏态：规范化换行符后内容与基线不同 = 脏（杜绝 Windows CRLF 导致假脏态）
      const isDirty = normalizeEol(content) !== normalizeEol(doc.baselineContent);
      newMap.set(key, { ...doc, content, isDirty });
      return { documents: newMap };
    });
  },

  setDirty: (key, isDirty) => {
    set((state) => {
      const doc = state.documents.get(key);
      if (!doc) return {};
      const newMap = new Map(state.documents);
      newMap.set(key, { ...doc, isDirty });
      return { documents: newMap };
    });
  },

  setBaselineContent: (key, baselineContent) => {
    set((state) => {
      const doc = state.documents.get(key);
      if (!doc) return {};
      const newMap = new Map(state.documents);
      const isDirty = normalizeEol(doc.content) !== normalizeEol(baselineContent);
      newMap.set(key, { ...doc, baselineContent, isDirty });
      return { documents: newMap };
    });
  },

  updateBaseline: (key, mtime, size) => {
    set((state) => {
      const doc = state.documents.get(key);
      if (!doc) return {};
      const newMap = new Map(state.documents);
      newMap.set(key, {
        ...doc,
        baselineContent: doc.content,
        mtime,
        size,
        isDirty: false,
      });
      return { documents: newMap };
    });
  },

  syncSavePolicies: () => {
    set((state) => {
      let changed = false;
      const newMap = new Map(state.documents);
      newMap.forEach((doc, key) => {
        const expected = resolveSavePolicy(doc.kind);
        if (doc.savePolicy !== expected) {
          newMap.set(key, { ...doc, savePolicy: expected });
          changed = true;
        }
      });
      return changed ? { documents: newMap } : {};
    });
  },

  setExternalStatus: (key, status) => {
    set((state) => {
      const doc = state.documents.get(key);
      if (!doc) return {};
      const newMap = new Map(state.documents);
      newMap.set(key, { ...doc, externalStatus: status });
      return { documents: newMap };
    });
  },

  setLargeDocVerdict: (key, verdict) => {
    set((state) => {
      const doc = state.documents.get(key);
      if (!doc) return {};
      const newMap = new Map(state.documents);
      newMap.set(key, { ...doc, largeDocVerdict: verdict });
      return { documents: newMap };
    });
  },

  remove: (key) => {
    set((state) => {
      const newMap = new Map(state.documents);
      newMap.delete(key);
      return { documents: newMap };
    });
  },

  clear: () => set({ documents: new Map() }),
}));
