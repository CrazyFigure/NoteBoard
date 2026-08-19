// NoteBoard 窗口管理（前端）
// window_ready 握手 + 取意图 + 单实例响应 + FR-606 迁移
// 详见 docs/09-开发路线图.md 阶段6

import { getCurrentWindow } from '@tauri-apps/api/window';
import * as ipc from '../../core/ipc/commands';
import { onOpenFiles, onHandoffComplete, onCloseRequested, onFocusTab } from '../../core/ipc/events';
import type { WindowIntent, TransferredDocument } from '../../core/ipc/types';
import { openDocument } from '../editor-code/orchestration/openDocument';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import { useDocumentStore } from '../../stores/documentStore';
import { kindFromPath, languageFromPath } from '../../core/docKind';

// ── 初始化窗口（拉取模型）──

/**
 * 前端挂载后调用 window_ready 取走意图
 * 这是拉取模型的关键：前端主动取，不依赖事件
 */
export async function initWindow(): Promise<WindowIntent> {
  const label = getCurrentWindow().label;

  // 通知活跃
  try {
    await ipc.notifyWindowActive(label);
  } catch {
    // 非关键
  }

  // 取走意图
  let intent: WindowIntent = { type: 'empty' };
  try {
    intent = await ipc.windowReady(label);
  } catch (e) {
    console.error('window_ready 握手失败:', e);
  }

  // 处理意图
  await handleIntent(intent);

  return intent;
}

// ── 处理窗口意图 ──

async function handleIntent(intent: WindowIntent): Promise<void> {
  switch (intent.type) {
    case 'empty':
      // 无操作
      break;

    case 'open-files':
      // 逐个打开文件
      for (const path of intent.paths) {
        await openDocument(path);
      }
      break;

    case 'adopt-documents':
      // 接收迁移的文档
      for (const doc of intent.docs) {
        adoptDocument(doc);
      }
      break;
  }
}

// ── 接收迁移的文档 ──

function adoptDocument(doc: TransferredDocument): void {
  const name = doc.key.split(/[\\/]/).pop() ?? doc.key;

  // 创建 Document
  const docStore = useDocumentStore.getState();
  docStore.upsertFromPayload({
    key: doc.key,
    displayName: name,
    dirPath: doc.key.substring(0, doc.key.lastIndexOf('\\')) || doc.key,
    kind: kindFromPath(doc.key),
    language: languageFromPath(doc.key),
    content: doc.content,
    encoding: 'utf8',
    eol: 'lf',
    size: doc.content?.length ?? 0,
    mtime: 0,
    readonly: false,
  });

  // 创建 Tab
  const tab: Tab = {
    key: doc.key,
    displayName: name,
    path: doc.key,
    kind: kindFromPath(doc.key),
    language: languageFromPath(doc.key),
    isDirty: doc.isDirty,
    isPreview: false,
    viewMode: doc.viewMode,
    externalStatus: null,
    isDetached: false,
  };

  useWindowStore.getState().openTab(tab);
}

// ── 单实例事件监听 ──

let unlistenOpenFiles: (() => void) | null = null;
let unlistenHandoff: (() => void) | null = null;
let unlistenCloseRequested: (() => void) | null = null;
let unlistenFocusTab: (() => void) | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

// ── 窗口关闭流程（6.8）──
// tauri://close-requested → preventDefault → 收集脏文档 → 批量拦截 → 写会话 → 注销文档 → close()

/**
 * 窗口关闭处理：检查脏文档 → 弹拦截 → 最终关闭
 */
async function handleCloseRequested(): Promise<void> {
  const tabStore = useWindowStore.getState();
  const docStore = useDocumentStore.getState();
  const label = getCurrentWindow().label;

  // 收集脏文档
  const dirtyTabs = tabStore.tabs.filter((t) => t.isDirty);

  if (dirtyTabs.length > 0) {
    // 触发拦截对话框
    // 通过 windowStore 设置 pendingCloseKeys 与 isWindowClosing 状态让 UnsavedGuardDialog 响应
    tabStore.requestWindowClose(dirtyTabs.map((t) => t.key));
    return; // 不继续关闭，等待用户选择
  }

  // 无脏文档，直接执行关闭流程
  await performWindowClose(label);
}

/**
 * 执行实际窗口关闭：注销文档 → 通知后端注销并关闭窗口/退出进程
 */
export async function performWindowClose(label: string): Promise<void> {
  const tabStore = useWindowStore.getState();

  // 注销本窗口所有文档的所有权
  for (const tab of tabStore.tabs) {
    try {
      await ipc.unregisterDocument(label, tab.key);
    } catch {
      // 非关键
    }
  }

  // 通知 Rust 关闭本窗口并安全退出（不提前清空 store，避免出现全白空白画面滞留）
  try {
    await ipc.closeWindow(label);
  } catch (e) {
    console.error('关闭窗口失败:', e);
  }
}

/**
 * 启动单实例事件监听
 */
export function startEventListeners(): void {
  if (!unlistenOpenFiles) {
    onOpenFiles(async ({ paths }) => {
      // 第二实例发来的文件路径
      for (const path of paths) {
        await openDocument(path);
      }
    }).then((fn) => {
      unlistenOpenFiles = fn;
    });
  }

  if (!unlistenHandoff) {
    onHandoffComplete(async ({ keys }) => {
      // 文档已迁移到新窗口，本窗口关闭这些 tab
      const store = useWindowStore.getState();
      for (const key of keys) {
        store.closeTab(key);
        useDocumentStore.getState().remove(key);
      }
    }).then((fn) => {
      unlistenHandoff = fn;
    });
  }

  if (!unlistenCloseRequested) {
    onCloseRequested((targetLabel) => {
      // 仅当目标窗口为当前窗口时才处理关闭拦截，避免多窗口间广播误触发
      const currentLabel = getCurrentWindow().label;
      if (targetLabel && targetLabel !== currentLabel) {
        return;
      }
      handleCloseRequested();
    }).then((fn) => {
      unlistenCloseRequested = fn;
    });
  }

  if (!unlistenFocusTab) {
    onFocusTab(({ key }) => {
      // 其他窗口请求聚焦某个 tab（跨窗口唯一性）
      useWindowStore.getState().activateTab(key);
    }).then((fn) => {
      unlistenFocusTab = fn;
    });
  }

  // 6.7: 对账定时器 — 每 30 秒调用 reconcile_documents
  if (!reconcileTimer) {
    reconcileTimer = setInterval(async () => {
      const label = getCurrentWindow().label;
      const tabStore = useWindowStore.getState();
      const keys = tabStore.tabs.map((t) => t.key);
      if (keys.length === 0) return;

      try {
        const result = await ipc.reconcileDocuments(label, keys);
        // 清理被移除的文档
        for (const removedKey of result.removed) {
          tabStore.closeTab(removedKey);
          useDocumentStore.getState().remove(removedKey);
        }
      } catch {
        // 非关键
      }
    }, 30_000);
  }
}

/**
 * 停止事件监听
 */
export function stopEventListeners(): void {
  unlistenOpenFiles?.();
  unlistenHandoff?.();
  unlistenCloseRequested?.();
  unlistenFocusTab?.();
  unlistenOpenFiles = null;
  unlistenHandoff = null;
  unlistenCloseRequested = null;
  unlistenFocusTab = null;

  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

// ── FR-606：迁移到新窗口 ──

/**
 * 将当前 tab 迁移到新窗口
 * 不变式 I-10：先确认交接成功，再移除本地
 */
export async function moveToNewWindow(docKey: string): Promise<boolean> {
  const docStore = useDocumentStore.getState();
  const doc = docStore.getDocument(docKey);
  if (!doc) return false;

  const tabStore = useWindowStore.getState();
  const tab = tabStore.getTab(docKey);
  if (!tab) return false;

  // 构建迁移文档
  const transferred: TransferredDocument = {
    key: doc.key,
    content: doc.content,
    boardScene: null,
    isDirty: doc.isDirty,
    viewMode: tab.viewMode as 'visual' | 'source' | null,
    viewState: {
      selection: null,
      scrollTop: 0,
      boardViewport: null,
      foldedRanges: [],
    },
  };

  try {
    // 创建新窗口并交接文档
    const { label: newLabel } = await ipc.openInNewWindow([transferred]);

    // 轮询确认交接完成
    const maxRetries = 30; // 最多 30 次 × 200ms = 6s
    for (let i = 0; i < maxRetries; i++) {
      const result = await ipc.confirmHandoff(newLabel);
      if (result.done) {
        // 交接成功 → 移除本地（不变式 I-10）
        // 注意：这里不清除注册表，新窗口会注册
        tabStore.closeTab(docKey);
        docStore.remove(docKey);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // 超时未确认 → 回滚
    console.error('迁移超时：新窗口未在 6 秒内完成交接');
    return false;
  } catch (e) {
    console.error('迁移到新窗口失败:', e);
    return false;
  }
}

// ── 新建空窗口（Ctrl+Shift+N）──

export async function newEmptyWindow(): Promise<void> {
  try {
    await ipc.createWindow({ type: 'empty' });
  } catch (e) {
    console.error('新建窗口失败:', e);
  }
}
