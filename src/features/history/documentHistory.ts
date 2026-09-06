// NoteBoard 文档级统一撤销/重做历史
// 历史归属于文件而非具体编辑器内核，保证 Markdown 可视化、源码和代码编辑模式共享同一条时间线
//
// 🔴 S13/J1 存储压缩（docs/启动性能与低内存根治计划.md §J1）：
//   内部文本历史改为「检查点 + 可逆文本替换补丁」：
//   - 相邻节点求最长公共前/后缀，记录 UTF-16 offset、删除片段与插入片段，重建逐字一致；
//   - 默认每 20 个历史组一个检查点；首节点始终为检查点；
//   - 淘汰最老节点前把新首节点物化为检查点，保证剩余补丁仍有基准；
//   - 撤销后输入删除旧重做分支；synchronizeCurrentDocumentHistoryContent 修改当前节点时
//     先把依赖旧内容的第一个后继物化为检查点，再修改前驱；
//   - 公开 API（DocumentHistoryEntry.content 等）与 201 节点上限、分组语义完全不变。

import { useState, useEffect } from 'react';

/** 单条历史所在的编辑模式，用于尽可能恢复同内核的光标位置 */
export type DocumentHistoryMode = 'visual' | 'source' | 'code' | 'board' | 'mindmap' | 'drawio' | 'bitable';

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

/** 可逆文本替换补丁：next = prev[0..prefixLen) + inserted + prev[prefixLen+removed.length..) */
interface TextPatch {
  prefixLen: number;
  removed: string;
  inserted: string;
}

/**
 * 历史节点（内部存储）：检查点存全文；补丁节点存相对前一节点的变化。
 * 公开的 DocumentHistoryEntry（含全文 content）经物化函数按需生成。
 */
interface HistoryNode {
  /** 检查点：完整内容；补丁节点为 null */
  checkpoint: string | null;
  /** 相对前一节点的补丁；检查点节点为 null */
  patch: TextPatch | null;
  mode: DocumentHistoryMode;
  undoSelection?: DocumentHistorySelection;
  selection?: DocumentHistorySelection;
}

interface DocumentHistoryState {
  entries: HistoryNode[];
  index: number;
  lastEditMode: DocumentHistoryMode | null;
  /** 撤销、重做或模式切换后，下一次真实编辑必须开启新组 */
  forceNextGroup: boolean;
  /** 应用历史快照期间只更新界面和脏态，不允许反向记录成新步骤 */
  isApplying: boolean;
  /** 自上个检查点以来的组数（达 CHECKPOINT_INTERVAL 物化新检查点） */
  checkpointDistance: number;
  /** 相邻物化缓存（当前/相邻节点一次物化，避免链式回溯） */
  lastMaterialized: { index: number; content: string } | null;
}

/** 单文档最多保留的历史节点，包含初始节点 */
const MAX_HISTORY_ENTRIES = 201;
/** 检查点间隔：每 20 个历史组物化一个检查点（J 节起始调优值） */
const CHECKPOINT_INTERVAL = 20;

// ── 补丁原语 ──

/** 计算相邻两个文本的最小替换补丁（最长公共前/后缀；UTF-16 code unit 逐字一致） */
function diffText(prev: string, next: string): TextPatch {
  const maxPrefix = Math.min(prev.length, next.length);
  let prefixLen = 0;
  while (prefixLen < maxPrefix && prev.charCodeAt(prefixLen) === next.charCodeAt(prefixLen)) {
    prefixLen += 1;
  }
  // 前后缀不重叠：公共后缀最多延伸到 prefixLen
  let suffixLen = 0;
  const maxSuffix = maxPrefix - prefixLen;
  while (
    suffixLen < maxSuffix &&
    prev.charCodeAt(prev.length - 1 - suffixLen) === next.charCodeAt(next.length - 1 - suffixLen)
  ) {
    suffixLen += 1;
  }
  return {
    prefixLen,
    removed: prev.slice(prefixLen, prev.length - suffixLen),
    inserted: next.slice(prefixLen, next.length - suffixLen),
  };
}

/** 应用补丁：基于前一节点内容重建本节点内容 */
function applyPatch(base: string, patch: TextPatch): string {
  return base.slice(0, patch.prefixLen) + patch.inserted + base.slice(patch.prefixLen + patch.removed.length);
}

/** 取补丁的逆（撤销方向重放用） */
function reversePatch(patch: TextPatch): TextPatch {
  return { prefixLen: patch.prefixLen, removed: patch.inserted, inserted: patch.removed };
}

/** 物化指定节点的完整内容（带相邻缓存与链式回溯） */
function materializeNode(state: DocumentHistoryState, index: number): string {
  const node = state.entries[index];
  if (node.checkpoint !== null) return node.checkpoint;

  // 相邻缓存：目标恰为缓存节点的前驱（逆向撤销路径）或后继（正向路径）
  const cached = state.lastMaterialized;
  if (cached) {
    if (cached.index === index + 1 && state.entries[index + 1]?.patch) {
      const content = applyPatch(cached.content, reversePatch(state.entries[index + 1].patch!));
      state.lastMaterialized = { index, content };
      return content;
    }
    if (cached.index === index - 1 && node.patch) {
      const content = applyPatch(cached.content, node.patch);
      state.lastMaterialized = { index, content };
      return content;
    }
  }

  // 链式回溯：找到最近的检查点，正向应用补丁
  let start = index;
  while (start > 0 && state.entries[start].checkpoint === null) {
    start -= 1;
  }
  let content = state.entries[start].checkpoint ?? '';
  for (let i = start + 1; i <= index; i++) {
    content = applyPatch(content, state.entries[i].patch!);
  }
  state.lastMaterialized = { index, content };
  return content;
}

/** 生成公开的历史条目视图（物化全文；公开 API 兼容层） */
function toPublicEntry(state: DocumentHistoryState, index: number): DocumentHistoryEntry {
  const node = state.entries[index];
  return {
    content: materializeNode(state, index),
    mode: node.mode,
    undoSelection: node.undoSelection,
    selection: node.selection,
  };
}

/** 构造存储节点：补丁比全文大时直接物化为检查点（J 节规则） */
function createNode(state: DocumentHistoryState, content: string, mode: DocumentHistoryMode, undoSelection?: DocumentHistorySelection, selection?: DocumentHistorySelection): HistoryNode {
  const prevContent = materializeNode(state, state.entries.length - 1);
  const patch = diffText(prevContent, content);
  // 补丁体积超过全文：存检查点（顺序距离由调用方推进）
  if (patch.removed.length + patch.inserted.length >= content.length) {
    return { checkpoint: content, patch: null, mode, undoSelection, selection };
  }
  return { checkpoint: null, patch, mode, undoSelection, selection };
}

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

/** 创建新的文档历史状态（首节点始终为可独立恢复的检查点） */
function createHistory(content: string, mode: DocumentHistoryMode): DocumentHistoryState {
  return {
    entries: [{ checkpoint: content, patch: null, mode }],
    index: 0,
    lastEditMode: null,
    forceNextGroup: true,
    isApplying: false,
    checkpointDistance: 0,
    lastMaterialized: { index: 0, content },
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
  if (existing && materializeNode(existing, existing.index) === content) {
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

// ── 🔴 J2 导航/读取前的物化钩子 ──
//
// 输入热路径只暂存不可变快照（不序列化）；历史组末端延迟物化。
// undo/redo/读取当前内容/模式同步/迁移导出等入口必须先物化暂存快照，
// 否则导航会跳过未物化的当前组。

/** 编辑器侧注册的物化钩子（多实例并存；卸载时注销） */
const materializeHooks = new Set<(docKey: string) => void>();

/** 注册物化钩子（编辑器挂载时调用；钩子内部幂等——无暂存为 no-op） */
export function registerHistoryMaterializeHook(hook: (docKey: string) => void): () => void {
  materializeHooks.add(hook);
  return () => {
    materializeHooks.delete(hook);
  };
}

/** 物化指定文档的暂存快照（无钩子/异常不阻断导航） */
function materializePending(docKey: string): void {
  for (const hook of materializeHooks) {
    try {
      hook(docKey);
    } catch (error) {
      console.error('[NoteBoard] 物化暂存快照失败（历史导航继续）:', error);
    }
  }
}

/** 获取当前统一历史节点的内容 */
export function getCurrentDocumentHistoryContent(docKey: string): string | null {
  // 🔴 J2：读取当前内容前先物化暂存快照（未物化的组末端不可跳过）
  materializePending(docKey);
  const state = histories.get(docKey);
  return state ? materializeNode(state, state.index) : null;
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
  // 🔴 J2：模式同步可能重写当前节点——先物化暂存快照避免覆盖未物化组末
  materializePending(docKey);
  const state = histories.get(docKey);
  if (!state) return;
  const current = state.entries[state.index];
  if (materializeNode(state, state.index) === content && current.mode === mode) return;

  // 🔴 J1：修改当前节点前，依赖旧内容的第一个后继物化为检查点，
  //    保证仍保留的重做分支逐字保持原逻辑内容
  if (state.index < state.entries.length - 1) {
    const successor = state.entries[state.index + 1];
    if (successor.checkpoint === null) {
      successor.checkpoint = materializeNode(state, state.index + 1);
      successor.patch = null;
    }
  }

  // 当前节点重写：检查点直接替换；补丁节点基于前驱重算
  const prevContent = state.index > 0 ? materializeNode(state, state.index - 1) : null;
  const nextNode: HistoryNode =
    prevContent === null || state.entries[state.index].checkpoint !== null
      ? { checkpoint: content, patch: null, mode }
      : (() => {
          const patch = diffText(prevContent, content);
          if (patch.removed.length + patch.inserted.length >= content.length) {
            return { checkpoint: content, patch: null, mode };
          }
          return { checkpoint: null, patch, mode };
        })();
  nextNode.undoSelection = state.entries[state.index].undoSelection;
  nextNode.selection = state.entries[state.index].selection;
  state.entries[state.index] = nextNode;
  state.lastMaterialized = { index: state.index, content };
  state.lastEditMode = mode;
  notifyHistoryChange(docKey);
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

  if (materializeNode(state, state.index) === content) {
    if (options.selection) state.entries[state.index].selection = options.selection;
    return;
  }

  // 在历史中间开始输入代表创建新分支，旧的重做方向必须丢弃
  const isBranching = state.index < state.entries.length - 1;
  if (isBranching) {
    state.entries.splice(state.index + 1);
    state.lastMaterialized = { index: state.index, content: materializeNode(state, state.index) };
  }

  const startsNewGroup =
    isBranching ||
    state.forceNextGroup ||
    options.startsNewGroup ||
    state.lastEditMode !== options.mode;

  if (startsNewGroup || state.index === 0) {
    // 新分组追加（补丁基于链尾物化；顺序距离达阈值物化为检查点）
    const node = createNode(state, content, options.mode, options.beforeSelection, options.selection);
    state.entries.push(node);
    state.index = state.entries.length - 1;
    if (node.checkpoint !== null) {
      state.checkpointDistance = 0;
    } else {
      state.checkpointDistance += 1;
      if (state.checkpointDistance >= CHECKPOINT_INTERVAL) {
        // 每 20 组物化一个检查点（截断回溯上限受控）
        node.checkpoint = content;
        node.patch = null;
        state.checkpointDistance = 0;
      }
    }
  } else if (state.index > 0) {
    // 同一输入分组持续更新终点，撤销时仍回到该分组开始前的节点；
    // 保留本组 undoSelection（分组起点），重算补丁/检查点
    const prevContent = materializeNode(state, state.index - 1);
    const wasCheckpoint = state.entries[state.index].checkpoint !== null;
    const patch = diffText(prevContent, content);
    const asCheckpoint = wasCheckpoint || patch.removed.length + patch.inserted.length >= content.length;
    state.entries[state.index] = {
      checkpoint: asCheckpoint ? content : null,
      patch: asCheckpoint ? null : patch,
      mode: options.mode,
      undoSelection: state.entries[state.index].undoSelection ?? options.beforeSelection,
      selection: options.selection,
    };
  } else {
    // index === 0 且未开新组（首节点即当前组）：重写首节点（保持检查点语义）
    state.entries[0] = {
      checkpoint: content,
      patch: null,
      mode: options.mode,
      undoSelection: state.entries[0].undoSelection ?? options.beforeSelection,
      selection: options.selection,
    };
    state.checkpointDistance = 0;
  }
  state.lastMaterialized = { index: state.index, content };

  if (state.entries.length > MAX_HISTORY_ENTRIES) {
    const overflow = state.entries.length - MAX_HISTORY_ENTRIES;
    // 🔴 J1：淘汰最老节点前先物化"将保留的最老节点"——
    //    它的补丁基准（原前驱）即将被裁掉，splice 之后无法再重建
    const survivingFirstContent = materializeNode(state, overflow);
    state.entries.splice(0, overflow);
    state.index = Math.max(0, state.index - overflow);
    const newFirst = state.entries[0];
    if (newFirst.checkpoint === null) {
      newFirst.checkpoint = survivingFirstContent;
      newFirst.patch = null;
    }
    // 重算距离（从新首开始数）
    state.checkpointDistance = 0;
    for (let i = 1; i <= state.index; i++) {
      if (state.entries[i].checkpoint !== null) {
        state.checkpointDistance = 0;
      } else {
        state.checkpointDistance += 1;
      }
    }
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
  const previousContent = materializeNode(state, previousIndex);
  const nextContent = materializeNode(state, nextIndex);
  const navigation: DocumentHistoryNavigation = {
    direction: isUndo ? 'undo' : 'redo',
    changeOffset: findFirstChangeOffset(previousContent, nextContent),
    selection: preferredSelection,
    selectionMode: preferredSelection ? preferredSelectionMode : undefined,
  };
  state.index = nextIndex;
  state.isApplying = true;
  try {
    adapter.applyEntry(toPublicEntry(state, nextIndex), navigation);
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
  // 🔴 J2：导航前先物化暂存快照（当前组末端必须先进历史才能正确回退一步）
  materializePending(docKey);
  return moveHistory(docKey, -1);
}

/** 沿文件统一时间线重做一个编辑分组 */
export function redoDocumentHistory(docKey: string): boolean {
  materializePending(docKey);
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

// ── 迁移序列化（R06：跨窗口迁移完整历史） ──

/** 可序列化的历史快照（检查点/补丁可直接 JSON 化） */
export interface SerializableHistory {
  entries: HistoryNode[];
  index: number;
  lastEditMode: DocumentHistoryMode | null;
}

/** 导出指定文档的历史（无历史返回 null）；用于跨窗口迁移 */
export function serializeDocumentHistory(docKey: string): SerializableHistory | null {
  // 🔴 J2：迁移导出前先物化暂存快照（组末端不能丢）
  materializePending(docKey);
  const state = histories.get(docKey);
  if (!state) return null;
  return {
    entries: state.entries,
    index: state.index,
    lastEditMode: state.lastEditMode,
  };
}

/** 恢复（迁移导入）历史：仅当目标无历史时导入；导入后强制下一次输入开新组 */
export function restoreDocumentHistory(docKey: string, data: SerializableHistory): boolean {
  if (histories.has(docKey)) return false;
  if (!Array.isArray(data.entries) || data.entries.length === 0) return false;
  histories.set(docKey, {
    entries: data.entries,
    index: Math.max(0, Math.min(data.index, data.entries.length - 1)),
    lastEditMode: data.lastEditMode ?? null,
    forceNextGroup: true,
    isApplying: false,
    checkpointDistance: 0,
    lastMaterialized: null,
  });
  notifyHistoryChange(docKey);
  return true;
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

/** 仅测试/诊断：窥视内部存储状态 */
export function __debugGetState(docKey: string): DocumentHistoryState | undefined {
  return histories.get(docKey);
}
