// NoteBoard windowStore
// tab 列表 + 激活 tab（每窗口一份，纯 UI 状态）
// 详见 docs/05-ADR/ADR-010-状态管理与跨窗口同步.md §2

import { create } from 'zustand';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { DocumentKind } from '../core/ipc/types';
import { normalizePath } from '../features/explorer/pathUtils';
// 🔴 R4-05/D05：disposeTabLifecycleAsync 独立入口需终结 documents 记录
//    （documentStore 不依赖 windowStore——单向依赖无循环）
import { useDocumentStore } from './documentStore';
// 🔴 R04：关闭标签时立即注销 Rust 文档归属（fire-and-forget；幂等），
//    否则下一次打开同文件被 prepare 判为 already-open 而无法重建标签。
//    静态 import：不引入组件依赖，仅命令封装。
import * as ipc from '../core/ipc/commands';
// 🔴 R13：标签最终关闭时释放文档会话资源（revision/写队列/恢复状态）
// 🔴 N04：disposeDocumentSession 推进会话代际（作废旧会话在途任务）；
//    removeDocumentIfSessionMatches 携带关闭后代际做条件删除（同路径已重开时不误删）
// 🔴 R3-05：统一关闭事务（beginClosing 停止接纳 → 排空 → 代际条件注销）
import {
  disposeDocumentSession,
  removeDocumentIfSessionMatches,
  getSessionGeneration,
  drainDocumentWrites,
  beginClosing,
  endClosing,
  getClosingGeneration,
  releaseSessionAfterClosing,
} from '../features/session/documentSession';
import { markClosed } from '../features/session/editorSuspension';

export interface Tab {
  /** 唯一 ID（用文件路径规范化 key） */
  key: string;
  /** 显示名（文件名含扩展名） */
  displayName: string;
  /** 文档路径，null 表示未命名 */
  path: string | null;
  /** 文档类型 */
  kind: DocumentKind;
  /** 语言 ID */
  language: string;
  /** 是否脏（有未保存修改） */
  isDirty: boolean;
  /** 是否预览态（单击树节点打开时为 true） */
  isPreview: boolean;
  /** 视图模式（Markdown 用） */
  viewMode: 'visual' | 'source' | null;
  /** 外部变更状态 */
  externalStatus: 'clean' | 'modified' | 'deleted' | 'renamed' | null;
  /** 文件已断开（被删除） */
  isDetached: boolean;
  // ── S10 会话恢复轻量描述符 ──
  /** 未加载正文的恢复标签：激活时才真正打开（读盘/注册/编辑器加载） */
  lazySource?: string | null;
  /** 恢复标签携带的暂存副本路径（关闭保护与恢复链使用） */
  lazyStagedPath?: string | null;
}

interface WindowStore {
  tabs: Tab[];
  activeKey: string | null;

  // ── 查询 ──
  activeTab: () => Tab | null;
  getTab: (key: string) => Tab | null;

  // ── 操作 ──
  openTab: (tab: Tab) => void;
  closeTab: (key: string) => void;
  closeOtherTabs: (key: string) => void;
  closeTabsLeft: (key: string) => void;
  closeTabsRight: (key: string) => void;
  closeAllTabs: () => void;
  activateTab: (key: string) => void;
  setTabDirty: (key: string, isDirty: boolean) => void;
  setTabPreview: (key: string, isPreview: boolean) => void;
  setTabViewMode: (key: string, mode: 'visual' | 'source') => void;
  setTabExternalStatus: (key: string, status: Tab['externalStatus']) => void;
  setTabDetached: (key: string, isDetached: boolean) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  updateTabPath: (key: string, newPath: string, newDisplayName: string) => void;
  renameTabsDirectory: (oldDir: string, newDir: string) => void;
  // ── 安全关闭拦截操作（若含未保存修改则弹窗确认） ──
  requestCloseTab: (key: string) => void;
  requestCloseOther: (key: string) => void;
  requestCloseLeft: (key: string) => void;
  requestCloseRight: (key: string) => void;
  requestCloseAll: () => void;
  /** 窗口级关闭请求 */
  requestWindowClose: (keys: string[]) => void;
  /** 窗口级关闭标记 */
  isWindowClosing: boolean;
  /** 批量待关闭 keys */
  pendingCloseKeys: string[];
  /** 批量请求关闭多个 tab */
  requestCloseBatch: (keys: string[]) => void;
  /** 清除 pendingCloseKeys */
  clearPendingClose: () => void;
  /** 标记关闭完成后真正关 tab 并清理 documentStore */
  confirmCloseBatch: (keys: string[]) => void;
  // ── S10 会话恢复轻量描述符 ──
  /** 批量加入恢复标签（不激活、不动 activeKey；Home 保持首屏） */
  addRestoredTabs: (tabs: Tab[]) => void;
  /** 清除标签的懒加载标记（正文加载完成后调用；dirty 等状态保持现值） */
  clearLazy: (key: string) => void;
  // ── 迁移保护（S04 transferId 协议）──
  /** 正在迁移到新窗口的文档 key 集合：期间阻止该文档新编辑与关闭竞争 */
  transferringKeys: string[];
  /** 进入迁移保护（UI 显示"正在移动到新窗口"并阻断编辑输入） */
  enterTransfer: (key: string) => void;
  /** 解除迁移保护（committed/aborted 后） */
  exitTransfer: (key: string) => void;
  /** 查询文档是否处于迁移保护中 */
  isTransferring: (key: string) => boolean;
}

/**
 * 🔴 R04/R13/N04/N05/R3-05：标签从前端移除后的统一清理（每个标签恰好一次）——
 *   同步完成停止接纳与本地状态释放；异步部分（排空写队列 → 代际条件注销）
 *   由 disposeTabLifecycleAsync 承接（fire-and-forget，幂等）。
 */
function disposeTabLifecycle(key: string): void {
  // 🔴 R3-05 关闭事务第一步（同步，任何 await 前）：进入 closing——停止接纳该会话的新写任务
  beginClosing(key);
  // 🔴 N05：阻止会话继续提交（markClosed 清恢复状态；dispose 推进代际作废旧任务）
  markClosed(key);
  disposeDocumentSession(key);
  // 🔴 B11：同步删除且携带关闭时的代际——若此刻同路径新会话已建立（代际推进）则跳过
  removeDocumentIfSessionMatches(key, getSessionGeneration(key));
  // 异步事务（排空→条件注销）不阻塞 UI
  void disposeTabLifecycleAsync(key);
}

/**
 * 🔴 R3-05 统一异步关闭事务（可等待，完整四步）：
 *   1. 停止接纳（closing——若未经过同步清理则在此进入，公开接口独立可用）
 *   2. 排空该文档在途写队列（晚到的旧写入不覆盖、不丢失）
 *   3. 按关闭时代际做条件注销——drain 期间同路径重开（新会话已注册归属）时
 *      跳过注销（旧关闭不得越权移除新会话的 Rust 归属，C08）
 *   4. 退出 closing（新会话可重新接纳写任务）
 * 幂等（重复调用安全）；窗口整体关闭/普通标签关闭统一走本接口。
 */
export async function disposeTabLifecycleAsync(key: string): Promise<void> {
  // 0. 🔴 R4-05/D05：公开入口独立调用时补齐会话终结（同步清理的等价步骤）——
  //    经 disposeTabLifecycle（closeTab 路径）进入时这些步骤已完成（幂等跳过）：
  //    beginClosing 同代无操作；disposeDocumentSession 已推进代际则
  //    removeDocumentIfSessionMatches 按新代际比对（已在 documents 移除后无操作）。
  //    未经同步清理直接调用（窗口关闭等）时在此确保：documents 移除 + 代际推进，
  //    第二次关闭的新会话同样被终结（迟到写入靠 token 失配作废）。
  beginClosing(key);
  const preGeneration = getSessionGeneration(key);
  const store = useDocumentStore.getState();
  if (store.documents.has(key) && getClosingGeneration(key) === preGeneration) {
    disposeDocumentSession(key);
    removeDocumentIfSessionMatches(key, getSessionGeneration(key));
  }
  // 捕获本次关闭事务的代际（注销与释放 closing 条件用）
  const closeGeneration = getSessionGeneration(key);
  try {
    // 2. 排空在途写（已作废任务立即跳过）
    await drainDocumentWrites(key).catch(() => {});
    // 3. 🔴 R3-05/C08：代际条件注销——drain 期间同路径重开（代际推进）则跳过，
    //    后端只校验窗口 label 无法区分新旧会话，旧关闭不得注销新归属
    if (getSessionGeneration(key) === closeGeneration) {
      const label = getCurrentWindowLabelSafe();
      if (label) {
        await ipc.unregisterDocument(label, key).catch(() => {});
      }
    }
  } finally {
    // 4. 🔴 R4-05/D04：关闭事务完成——**释放 closing 条目**（closing 是会话状态
    //    而非路径墓碑；旧会话迟到的写任务靠活动表 token 校验作废：
    //    disposeDocumentSession 已推进/清除代际，isSessionCurrent 必假）。
    //    只释放本事务代际的条目：drain 期间同路径重开且又开启新关闭（代际再变）
    //    时，条目已由新事务的 beginClosing 覆盖为新代际——不误清新事务。
    if (getClosingGeneration(key) === closeGeneration) {
      endClosing(key);
      // 🔴 R4-05/D04：closing 释放后活动表回落（孤立条目清理——30 个路径
      //    关闭后 active 表回落到 0，不留永久条目）
      releaseSessionAfterClosing(key);
    }
  }
}

/** 读取当前窗口 label（非 Tauri 环境安全降级为 null，不伪造身份） */
function getCurrentWindowLabelSafe(): string | null {
  try {
    return getCurrentWindow().label;
  } catch {
    return null;
  }
}

export const useWindowStore = create<WindowStore>((set, get) => ({
  tabs: [],
  activeKey: null,
  isWindowClosing: false,
  pendingCloseKeys: [],

  activeTab: () => {
    const { tabs, activeKey } = get();
    return tabs.find((t) => t.key === activeKey) ?? null;
  },

  getTab: (key) => {
    return get().tabs.find((t) => t.key === key) ?? null;
  },

  openTab: (tab) => {
    set((state) => {
      const existing = state.tabs.find((t) => t.key === tab.key);
      if (existing) {
        // 已存在，激活即可
        return { activeKey: tab.key };
      }
      return { tabs: [...state.tabs, tab], activeKey: tab.key };
    });
  },

  closeTab: (key) => {
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.key === key);
      if (idx < 0) return {};
      const newTabs = state.tabs.filter((t) => t.key !== key);
      let newActive = state.activeKey;
      if (state.activeKey === key) {
        // 激活相邻 tab
        newActive = newTabs[Math.min(idx, newTabs.length - 1)]?.key ?? null;
      }
      return { tabs: newTabs, activeKey: newActive };
    });
    // 🔴 R04/R13/N04：统一清理（注销归属 + 释放会话 + 条件删除文档；幂等、恰一次）
    disposeTabLifecycle(key);
  },

  // 关闭除目标标签页外的所有其他标签页
  closeOtherTabs: (key) => {
    const { tabs } = get();
    const removedKeys = tabs.filter((t) => t.key !== key).map((t) => t.key);
    set((state) => ({
      tabs: state.tabs.filter((t) => t.key === key),
      activeKey: key,
    }));
    // 🔴 N05：每个标签恰一次清理（此前四次重复遍历导致注销×4）
    removedKeys.forEach((k) => disposeTabLifecycle(k));
  },

  // 关闭目标标签页左侧的所有标签页
  closeTabsLeft: (key) => {
    const { tabs } = get();
    const idx = tabs.findIndex((t) => t.key === key);
    if (idx <= 0) return;
    const removedKeys = tabs.slice(0, idx).map((t) => t.key);
    set((state) => {
      const newTabs = state.tabs.slice(idx);
      let newActive = state.activeKey;
      if (state.activeKey && !newTabs.some((t) => t.key === state.activeKey)) {
        newActive = key;
      }
      return { tabs: newTabs, activeKey: newActive };
    });
    removedKeys.forEach((k) => disposeTabLifecycle(k));
  },

  // 关闭目标标签页右侧的所有标签页
  closeTabsRight: (key) => {
    const { tabs } = get();
    const idx = tabs.findIndex((t) => t.key === key);
    if (idx < 0) return;
    const removedKeys = tabs.slice(idx + 1).map((t) => t.key);
    set((state) => {
      const newTabs = state.tabs.slice(0, idx + 1);
      let newActive = state.activeKey;
      if (state.activeKey && !newTabs.some((t) => t.key === state.activeKey)) {
        newActive = key;
      }
      return { tabs: newTabs, activeKey: newActive };
    });
    removedKeys.forEach((k) => disposeTabLifecycle(k));
  },

  // 关闭全部标签页
  closeAllTabs: () => {
    const { tabs } = get();
    const removedKeys = tabs.map((t) => t.key);
    set({ tabs: [], activeKey: null });
    removedKeys.forEach((k) => disposeTabLifecycle(k));
  },

  // ── 安全关闭拦截操作（若含未保存修改则弹窗确认） ──

  requestCloseTab: (key) => {
    const { tabs, closeTab } = get();
    const target = tabs.find((t) => t.key === key);
    if (!target) return;
    // 🔴 迁移保护中的文档不能关闭（迁移未提交前不能销毁源内容）
    if (get().isTransferring(key)) return;
    if (target.isDirty) {
      set({ pendingCloseKeys: [key], isWindowClosing: false });
    } else {
      closeTab(key);
    }
  },

  requestCloseOther: (key) => {
    const { tabs, closeOtherTabs } = get();
    const targetTabs = tabs.filter((t) => t.key !== key);
    const hasDirty = targetTabs.some((t) => t.isDirty);
    if (hasDirty) {
      set({ pendingCloseKeys: targetTabs.map((t) => t.key), isWindowClosing: false });
    } else {
      closeOtherTabs(key);
    }
  },

  requestCloseLeft: (key) => {
    const { tabs, closeTabsLeft } = get();
    const idx = tabs.findIndex((t) => t.key === key);
    if (idx <= 0) return;
    const targetTabs = tabs.slice(0, idx);
    const hasDirty = targetTabs.some((t) => t.isDirty);
    if (hasDirty) {
      set({ pendingCloseKeys: targetTabs.map((t) => t.key), isWindowClosing: false });
    } else {
      closeTabsLeft(key);
    }
  },

  requestCloseRight: (key) => {
    const { tabs, closeTabsRight } = get();
    const idx = tabs.findIndex((t) => t.key === key);
    if (idx < 0 || idx >= tabs.length - 1) return;
    const targetTabs = tabs.slice(idx + 1);
    const hasDirty = targetTabs.some((t) => t.isDirty);
    if (hasDirty) {
      set({ pendingCloseKeys: targetTabs.map((t) => t.key), isWindowClosing: false });
    } else {
      closeTabsRight(key);
    }
  },

  requestCloseAll: () => {
    const { tabs, closeAllTabs } = get();
    const hasDirty = tabs.some((t) => t.isDirty);
    if (hasDirty) {
      set({ pendingCloseKeys: tabs.map((t) => t.key), isWindowClosing: false });
    } else {
      closeAllTabs();
    }
  },

  requestWindowClose: (keys) => {
    set({ pendingCloseKeys: keys, isWindowClosing: true });
  },

  activateTab: (key) => {
    set({ activeKey: key });
  },

  setTabDirty: (key, isDirty) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.key === key ? { ...t, isDirty } : t)),
    }));
  },

  setTabPreview: (key, isPreview) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.key === key ? { ...t, isPreview } : t)),
    }));
  },

  setTabViewMode: (key, mode) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.key === key ? { ...t, viewMode: mode } : t)),
    }));
  },

  setTabExternalStatus: (key, status) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.key === key ? { ...t, externalStatus: status } : t,
      ),
    }));
  },

  setTabDetached: (key, isDetached) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.key === key ? { ...t, isDetached } : t)),
    }));
  },

  reorderTabs: (fromIndex, toIndex) => {
    set((state) => {
      const newTabs = [...state.tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      if (!moved) return {};
      newTabs.splice(toIndex, 0, moved);
      return { tabs: newTabs };
    });
  },

  updateTabPath: (key, newPath, newDisplayName) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.key === key
          // 另存为建立了新的有效磁盘路径，同时解除原文件删除/断开状态。
          ? { ...t, path: newPath, displayName: newDisplayName, key: newPath, externalStatus: 'clean', isDetached: false }
          : t,
      ),
      activeKey: state.activeKey === key ? newPath : state.activeKey,
    }));
  },

  // 批量更新被重命名目录下所有 Tab 的路径与 key
  renameTabsDirectory: (oldDir, newDir) => {
    const normOld = normalizePath(oldDir).toLowerCase();
    const normNew = normalizePath(newDir);
    set((state) => {
      let changed = false;
      const newTabs = state.tabs.map((t) => {
        if (!t.path) return t;
        const normPath = normalizePath(t.path);
        if (normPath.toLowerCase().startsWith(normOld + '\\')) {
          changed = true;
          const rel = normPath.substring(normOld.length);
          const newPath = normNew + rel;
          return {
            ...t,
            key: newPath,
            path: newPath,
          };
        }
        return t;
      });
      let newActiveKey = state.activeKey;
      if (state.activeKey && normalizePath(state.activeKey).toLowerCase().startsWith(normOld + '\\')) {
        const rel = normalizePath(state.activeKey).substring(normOld.length);
        newActiveKey = normNew + rel;
      }
      return changed ? { tabs: newTabs, activeKey: newActiveKey } : {};
    });
  },

  requestCloseBatch: (keys) => {
    set({ pendingCloseKeys: keys, isWindowClosing: false });
  },

  clearPendingClose: () => {
    set({ pendingCloseKeys: [], isWindowClosing: false });
  },

  confirmCloseBatch: (keys) => {
    set((state) => {
      const newTabs = state.tabs.filter((t) => !keys.includes(t.key));
      let newActive = state.activeKey;
      if (state.activeKey && keys.includes(state.activeKey)) {
        newActive = newTabs[0]?.key ?? null;
      }
      return { tabs: newTabs, activeKey: newActive, pendingCloseKeys: [], isWindowClosing: false };
    });
    // 🔴 R04/R13/N04：批量关闭同样注销归属与释放会话（每个标签恰一次）
    keys.forEach((k) => disposeTabLifecycle(k));
  },

  addRestoredTabs: (tabs) => {
    set((state) => {
      // 追加不存在的标签；不改变 activeKey（恢复期间用户可能已交互）
      const existingKeys = new Set(state.tabs.map((t) => t.key));
      const additions = tabs.filter((t) => !existingKeys.has(t.key));
      if (additions.length === 0) return state;
      return { tabs: [...state.tabs, ...additions] };
    });
  },

  clearLazy: (key) => {
    set((state) => {
      const target = state.tabs.find((t) => t.key === key);
      if (!target || (!target.lazySource && !target.lazyStagedPath)) return state;
      return {
        tabs: state.tabs.map((t) => (
          t.key === key ? { ...t, lazySource: undefined, lazyStagedPath: undefined } : t
        )),
      };
    });
  },

  // ── 迁移保护（S04）──
  transferringKeys: [],

  enterTransfer: (key) => {
    set((state) => ({
      transferringKeys: state.transferringKeys.includes(key)
        ? state.transferringKeys
        : [...state.transferringKeys, key],
    }));
  },

  exitTransfer: (key) => {
    set((state) => ({
      transferringKeys: state.transferringKeys.filter((k) => k !== key),
    }));
  },

  isTransferring: (key) => get().transferringKeys.includes(key),
}));
