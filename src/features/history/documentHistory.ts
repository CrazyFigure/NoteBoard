// NoteBoard 文档级统一撤销/重做历史
// 历史归属于文件而非具体编辑器内核，保证 Markdown 可视化、源码和代码编辑模式共享同一条时间线

import { useState, useEffect } from 'react';

/** 单条历史所在的编辑模式，用于尽可能恢复同内核的光标位置 */
export type DocumentHistoryMode = 'visual' | 'source' | 'code' | 'board';

/** 编辑器光标或选区快照；跨内核恢复时会自动裁剪到合法范围 */
export interface DocumentHistorySelection {
  anchor: number;
  head: number;
}

/** 文档在某个可撤销节点上的完整快照 */
export interface DocumentHistoryEntry {
  content: string;
  mode: DocumentHistoryMode;
  /** 该分组开始前的光标位置，撤销本分组时用于回到真实修改处 */
  undoSelection?: DocumentHistorySelection;
  /** 该分组结束后的光标位置，重做本分组时用于回到真实修改处 */
  selection?: DocumentHistorySelection;
}

/** 记录一次编辑时由编辑器内核提供的分组信息 */
export interface RecordDocumentChangeOptions {
  mode: DocumentHistoryMode;
  /** 本次事务开始前的光标位置；同一分组只保留首个事务的值 */
  beforeSelection?: DocumentHistorySelection;
  selection?: DocumentHistorySelection;
  /** 内核确认本次事务开启了新的原生历史分组 */
  startsNewGroup: boolean;
}

/** 撤销/重做应用快照时提供给当前编辑器的定位信息 */
export interface DocumentHistoryNavigation {
  direction: 'undo' | 'redo';
  /** 前后快照首个差异的文本偏移，跨编辑器内核时作为通用定位坐标 */
  changeOffset: number;
  /** 同一编辑器内核可直接恢复的精确光标位置 */
  selection?: DocumentHistorySelection;
  selectionMode?: DocumentHistoryMode;
}

/** 当前挂载编辑器提供的快照应用器 */
export interface DocumentHistoryAdapter {
  applyEntry: (entry: DocumentHistoryEntry, navigation: DocumentHistoryNavigation) => void;
}

interface DocumentHistoryState {
  entries: DocumentHistoryEntry[];
  index: number;
  lastEditMode: DocumentHistoryMode | null;
  /** 撤销、重做或模式切换后，下一次真实编辑必须开启新组 */
  forceNextGroup: boolean;
  /** 应用历史快照期间只更新界面和脏态，不允许反向记录成新步骤 */
  isApplying: boolean;
}

/** 单文档最多保留的历史节点，包含初始节点 */
const MAX_HISTORY_ENTRIES = 201;

const histories = new Map<string, DocumentHistoryState>();
const adapters = new Map<string, DocumentHistoryAdapter>();

// ── 历史变更响应式订阅机制 ──

type HistoryChangeListener = (
  docKey: string,
  availability: { canUndo: boolean; canRedo: boolean },
) => void;

const historyListeners = new Set<HistoryChangeListener>();

/** 订阅文档历史可用性变更 */
export function subscribeDocumentHistory(listener: HistoryChangeListener): () => void {
  historyListeners.add(listener);
  return () => {
    historyListeners.delete(listener);
  };
}

/** 通知所有订阅者当前文档的撤销/重做可用状态 */
function notifyHistoryChange(docKey: string): void {
  const availability = getDocumentHistoryAvailability(docKey);
  for (const listener of historyListeners) {
    try {
      listener(docKey, availability);
    } catch (e) {
      console.error('历史监听器执行异常:', e);
    }
  }
}

/** React Hook: 实时响应当前文档的撤销/重做可用状态 */
export function useDocumentHistory(docKey: string): {
  canUndo: boolean;
  canRedo: boolean;
} {
  const [availability, setAvailability] = useState(() => getDocumentHistoryAvailability(docKey));

  useEffect(() => {
    setAvailability(getDocumentHistoryAvailability(docKey));
    return subscribeDocumentHistory((changedKey, newAvail) => {
      if (changedKey === docKey) {
        setAvailability(newAvail);
      }
    });
  }, [docKey]);

  return availability;
}

/** 创建新的文档历史状态 */
function createHistory(content: string, mode: DocumentHistoryMode): DocumentHistoryState {
  return {
    entries: [{ content, mode }],
    index: 0,
    lastEditMode: null,
    forceNextGroup: true,
    isApplying: false,
  };
}

/**
 * 初始化文档历史。
 * 标签页切换导致组件重挂载时，若内容仍等于当前节点则保留原时间线；外部内容已替换时重新建线。
 */
export function initializeDocumentHistory(
  docKey: string,
  content: string,
  mode: DocumentHistoryMode,
): void {
  const existing = histories.get(docKey);
  if (existing?.entries[existing.index]?.content === content) {
    notifyHistoryChange(docKey);
    return;
  }
  histories.set(docKey, createHistory(content, mode));
  notifyHistoryChange(docKey);
}

/** 注册当前挂载编辑器的历史快照应用器 */
export function registerDocumentHistoryAdapter(
  docKey: string,
  adapter: DocumentHistoryAdapter,
): () => void {
  adapters.set(docKey, adapter);
  return () => {
    if (adapters.get(docKey) === adapter) {
      adapters.delete(docKey);
    }
  };
}

/** 当前是否正在由撤销/重做程序化应用快照 */
export function isApplyingDocumentHistory(docKey: string): boolean {
  return histories.get(docKey)?.isApplying ?? false;
}

/** 获取当前统一历史节点的内容 */
export function getCurrentDocumentHistoryContent(docKey: string): string | null {
  const state = histories.get(docKey);
  return state?.entries[state.index]?.content ?? null;
}

/** 获取当前文档是否还能撤销或重做，供编辑器工具栏同步按钮状态 */
export function getDocumentHistoryAvailability(docKey: string): {
  canUndo: boolean;
  canRedo: boolean;
} {
  const state = histories.get(docKey);
  if (!state) return { canUndo: false, canRedo: false };
  return {
    canUndo: state.index > 0,
    canRedo: state.index < state.entries.length - 1,
  };
}

/**
 * 模式解析只改变同一节点的文本表示时，就地对齐当前快照而不创建新步骤。
 * 例如 Markdown 源码转为可视化后可能被序列化为等价的规范格式。
 */
export function synchronizeCurrentDocumentHistoryContent(
  docKey: string,
  content: string,
  mode: DocumentHistoryMode,
): void {
  const state = histories.get(docKey);
  if (!state) return;
  const current = state.entries[state.index];
  if (!current) return;
  // 坐标只在产生它的编辑器内核中有效；表示模式变化时清空精确坐标，后续按内容差异跨内核定位
  state.entries[state.index] = current.mode === mode
    ? { ...current, content }
    : {
        content,
        mode,
      };
}

/**
 * 记录一次真实文档变化。
 * 同一内核原生历史组内的连续事务只更新当前节点；新组、跨模式编辑和撤销后的分支都会新增节点。
 */
export function recordDocumentChange(
  docKey: string,
  content: string,
  options: RecordDocumentChangeOptions,
): void {
  let state = histories.get(docKey);
  if (!state) {
    state = createHistory(content, options.mode);
    histories.set(docKey, state);
    return;
  }
  if (state.isApplying) return;

  const current = state.entries[state.index];
  if (current?.content === content) {
    if (options.selection) current.selection = options.selection;
    return;
  }

  // 在历史中间开始输入代表创建新分支，旧的重做方向必须丢弃
  const isBranching = state.index < state.entries.length - 1;
  if (isBranching) {
    state.entries.splice(state.index + 1);
  }

  const startsNewGroup =
    isBranching ||
    state.forceNextGroup ||
    options.startsNewGroup ||
    state.lastEditMode !== options.mode;
  const nextEntry: DocumentHistoryEntry = {
    content,
    mode: options.mode,
    undoSelection: options.beforeSelection,
    selection: options.selection,
  };

  if (startsNewGroup || state.index === 0) {
    state.entries.push(nextEntry);
    state.index = state.entries.length - 1;
  } else {
    // 同一输入分组持续更新终点，撤销时仍回到该分组开始前的节点
    state.entries[state.index] = {
      ...nextEntry,
      undoSelection: state.entries[state.index]?.undoSelection ?? options.beforeSelection,
    };
  }

  if (state.entries.length > MAX_HISTORY_ENTRIES) {
    const overflow = state.entries.length - MAX_HISTORY_ENTRIES;
    state.entries.splice(0, overflow);
    state.index = Math.max(0, state.index - overflow);
  }
  state.lastEditMode = options.mode;
  state.forceNextGroup = false;
  notifyHistoryChange(docKey);
}

/** 计算前后文本第一个不同字符的位置，作为跨编辑器内核都能理解的导航坐标 */
function findFirstChangeOffset(previousContent: string, nextContent: string): number {
  const comparableLength = Math.min(previousContent.length, nextContent.length);
  let offset = 0;
  while (offset < comparableLength && previousContent[offset] === nextContent[offset]) {
    offset += 1;
  }
  return offset;
}

/** 应用指定方向的历史节点，并保证应用事务不会被再次记录 */
function moveHistory(docKey: string, offset: -1 | 1): boolean {
  const state = histories.get(docKey);
  const adapter = adapters.get(docKey);
  if (!state || !adapter || state.isApplying) return false;

  const nextIndex = state.index + offset;
  if (nextIndex < 0 || nextIndex >= state.entries.length) return false;

  const previousIndex = state.index;
  const previousEntry = state.entries[previousIndex];
  const nextEntry = state.entries[nextIndex];
  const isUndo = offset === -1;
  // 撤销要恢复“被撤销分组”的起点；重做要恢复“被重做分组”的终点
  const preferredSelection = isUndo ? previousEntry.undoSelection : nextEntry.selection;
  const preferredSelectionMode = isUndo ? previousEntry.mode : nextEntry.mode;
  const navigation: DocumentHistoryNavigation = {
    direction: isUndo ? 'undo' : 'redo',
    changeOffset: findFirstChangeOffset(previousEntry.content, nextEntry.content),
    selection: preferredSelection,
    selectionMode: preferredSelection ? preferredSelectionMode : undefined,
  };
  state.index = nextIndex;
  state.isApplying = true;
  try {
    adapter.applyEntry(nextEntry, navigation);
    state.forceNextGroup = true;
    state.lastEditMode = null;
    notifyHistoryChange(docKey);
    return true;
  } catch (error) {
    state.index = previousIndex;
    console.error('应用文档撤销/重做快照失败:', error);
    return false;
  } finally {
    state.isApplying = false;
  }
}

/** 沿文件统一时间线撤销一个编辑分组 */
export function undoDocumentHistory(docKey: string): boolean {
  return moveHistory(docKey, -1);
}

/** 沿文件统一时间线重做一个编辑分组 */
export function redoDocumentHistory(docKey: string): boolean {
  return moveHistory(docKey, 1);
}

/** 模式切换本身不产生步骤，但下一次真实输入不能并入切换前的分组 */
export function markDocumentHistoryModeBoundary(docKey: string): void {
  const state = histories.get(docKey);
  if (state) state.forceNextGroup = true;
}

/** 另存为后迁移整条历史，保证首次保存前后的内容仍可前后移动 */
export function moveDocumentHistory(originalKey: string, nextKey: string): void {
  if (!originalKey || originalKey === nextKey) return;
  const state = histories.get(originalKey);
  if (state) {
    histories.delete(originalKey);
    histories.set(nextKey, state);
    notifyHistoryChange(originalKey);
    notifyHistoryChange(nextKey);
  }
}

/** 文档真正关闭后释放其历史 */
export function clearDocumentHistory(docKey: string): void {
  histories.delete(docKey);
  adapters.delete(docKey);
  notifyHistoryChange(docKey);
}

/** 测试及窗口整体清理使用：释放全部文档历史 */
export function clearAllDocumentHistories(): void {
  histories.clear();
  adapters.clear();
  for (const listener of historyListeners) {
    try {
      listener('', { canUndo: false, canRedo: false });
    } catch {
      // 忽略清理异常
    }
  }
}
