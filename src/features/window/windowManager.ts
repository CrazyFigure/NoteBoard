// NoteBoard 窗口管理（前端）
// S04 起采用 C 节协议：可靠打开队列（拉取 + 确认）+ 监听就绪握手 + transferId 迁移
// 🔴 关键不变量：
//   1. 事件只唤醒消费（nb://open-requests-available），不在监听里直接 openDocument；
//      请求在 Rust 队列中等待消费者拉取，前端未订阅时绝不丢失。
//   2. 迁移先 flush 权威内容（S03 能力注册表），携带完整元信息；
//      preparing 期间窗口进入迁移保护（transferringKeys 阻断编辑与关闭竞争）；
//      committed 前源不清理本地；不盲超时回滚，超时改为查询后端状态。
//   3. 源清理使用 transferred 语义：不注销目标所有权、不删除暂存。

import { getCurrentWindow } from '@tauri-apps/api/window';
import * as ipc from '../../core/ipc/commands';
import {
  onCloseRequested,
  onFocusTab,
  onDragDrop,
} from '../../core/ipc/events';
import type { OpenRequestDto, TransferredDocument, WindowBootDto } from '../../core/ipc/types';
import { openDocument } from '../editor-code/orchestration/openDocument';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import { useDocumentStore } from '../../stores/documentStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { kindFromPath, languageFromPath } from '../../core/docKind';
import { stashPendingDocuments } from '../staging/stagingManager';
import { showToast } from '../../stores/toastStore';
import { hasUnsavedWork } from '../staging/stagingPolicy';
import { saveCurrentWindowSnapshot, ensureWritableContent } from '../session/closedWindowSession';
// 🔴 N05：统一异步关闭协调器（可等待：停止接纳→排空写队列→注销归属）
import { disposeTabLifecycleAsync } from '../../stores/windowStore';
import { getEditorCapabilities } from '../../core/editor/editorRegistry';
import { clearDocumentRevision, getDocumentRevision } from '../../core/editor/editorRegistry';
// 🔴 R06：迁移携带可序列化统一历史
import { serializeDocumentHistory, restoreDocumentHistory } from '../history/documentHistory';
// 🔴 R06：迁移视图状态快照经回收恢复存储传递
import { saveViewState } from '../session/editorSuspension';
import { reportWebSpans } from '../../core/perf/reportWebSpans';
import {
  acquireBootCoordinator,
  releaseBootCoordinator,
  requestDrain,
  setRequestProcessor,
  subscribeTransferEvents,
  markBusinessReady,
  type OpenRequestResult,
} from '../../app/bootCoordinator';

// ── 启动（拉取模型 + C 节顺序）──

/**
 * 窗口启动：建立监听（含关闭保护）→ 等监听确认 → listeners-ready 握手 → 注册队列处理器。
 * 壳显示（windowShellReady）与 drain 由 App 在设置加载后调用 requestShellReadyAndDrain。
 * 🔴 N07：迁移接收（handoff）不在握手后立即提交可编辑会话——记录挂起迁移，
 *    待设置加载完成（businessReady 放行）后由 completePendingTransfers 处理，
 *    确保迁移会话使用用户的真实设置与保存策略。
 */
export async function initWindow(): Promise<WindowBootDto> {
  // 1. 建立必要事件监听（可等待：全部 unlisten 就绪后才握手）
  await startEventListeners();
  // 2. 握手（bootCoordinator 内部：监听确认 → window_listeners_ready）
  const boot = await acquireBootCoordinator();
  // 3. 注册打开请求处理器（事件仅唤醒 drain，处理器在此统一编排）
  setRequestProcessor(processOpenRequest);
  // 4. 迁移接收（handoff 场景）：记录挂起迁移，设置就绪后再拉取载荷建会话
  if (boot.startupMode === 'handoff' && boot.transferId) {
    pendingStartupTransfers.push(boot.transferId);
  }
  return boot;
}

/** 挂起的启动迁移（handoff 载荷在设置就绪后才提交为可编辑会话） */
const pendingStartupTransfers: string[] = [];

/**
 * 提交挂起的启动迁移（设置加载完成后调用）。
 * 逐个拉取载荷并建立会话；失败的迁移按 adoptTransferredDocument 内部
 * 的权威状态查询处理（committed 保留 / aborted 清理 / 未知保留）。
 */
export async function completePendingTransfers(): Promise<void> {
  const transfers = pendingStartupTransfers.splice(0);
  for (const transferId of transfers) {
    try {
      await adoptTransferredDocument(transferId);
    } catch (e) {
      console.error('处理挂起迁移失败:', e);
    }
  }
}

/**
 * 显示主题正确的壳并开始消费打开队列（App 在设置初始化完成后调用）。
 * 设置不等字体；显示不等全部文件读完；实际编辑等设置、模型与能力就绪。
 */
export async function requestShellReadyAndDrain(): Promise<void> {
  const label = getCurrentWindow().label;
  // 🔴 N07：业务就绪放行——设置已加载（调用时机由 App 保证）；
  //    期间缓存的事件唤醒在此补消费，迁移接收延后到设置之后
  markBusinessReady();
  // 🔴 N07：挂起的启动迁移在真实设置就绪后提交（此前仅记录）
  await completePendingTransfers();
  try {
    await ipc.windowShellReady(label);
  } catch (e) {
    console.error('壳就绪通知失败:', e);
  }
  // 窗口重新可见/初始化完成时主动 drain（恢复机制）
  requestDrain();
}

/** 打开请求处理器：按序处理并返回结果（drain 循环负责 ACK） */
async function processOpenRequest(request: OpenRequestDto): Promise<OpenRequestResult> {
  try {
    return await openDocument(request.path);
  } catch (e) {
    console.error('打开请求处理失败:', e);
    return 'failed';
  }
}

// ── 接收迁移的文档（目标窗口）──

/** 目标侧记录 transferId → key 的映射（aborted 事件不含 key，需本地反查） */
const adoptKeyByTransfer = new Map<string, string>();

async function adoptTransferredDocument(transferId: string): Promise<void> {
  const label = getCurrentWindow().label;
  // 一次性拉取迁移载荷（Rust 端拉取后清空正文引用）
  const doc = await ipc.takeTransferPayload(label, transferId);
  if (!doc) return; // 已被拉取 / 已中止

  const name = doc.key.split(/[\\/]/).pop() ?? doc.key;
  const dirPath = doc.key.substring(0, doc.key.lastIndexOf('\\')) || doc.key;
  // 缺省策略集中在此：类型/语言按 key 推断，编码缺省 utf8/lf，基线缺省取内容
  const kind = (doc.kind ?? kindFromPath(doc.key)) as Tab['kind'];
  // 迁移载荷的 language 为 string（由源窗口的 LanguageId 序列化而来），此处收窄回 LanguageId
  const language = (doc.language ?? languageFromPath(doc.key)) as ReturnType<typeof languageFromPath>;
  const content = doc.content ?? '';

  const docStore = useDocumentStore.getState();
  docStore.upsertFromPayload({
    key: doc.key,
    displayName: name,
    dirPath,
    kind,
    language,
    content,
    encoding: (doc.encoding ?? 'utf8') as 'utf8',
    eol: (doc.eol ?? 'lf') as 'lf',
    size: doc.size ?? content.length,
    mtime: doc.mtime ?? 0,
    readonly: doc.readonly ?? false,
  });
  // 脏文档必须携带基线：迁移载荷的 content 是最新内容而非基线，需显式恢复
  if (doc.baseline != null && doc.isDirty) {
    docStore.updateBaseline(doc.key, doc.baseline, doc.mtime ?? 0, doc.size ?? 0);
  }

  // 🔴 R06：恢复可序列化统一历史（目标无历史时导入；检查点+补丁链整体迁移）
  if (doc.history && typeof doc.history === 'object') {
    try {
      restoreDocumentHistory(doc.key, doc.history as import('../history/documentHistory').SerializableHistory);
    } catch (e) {
      console.error('迁移恢复历史失败（文档内容不受影响，仅缺撤销历史）:', e);
    }
  }

  // 迁移保护：committed 前目标不可编辑（Rust 已切换所有权后才解锁）
  useWindowStore.getState().enterTransfer(doc.key);
  adoptKeyByTransfer.set(transferId, doc.key);

  const tab: Tab = {
    key: doc.key,
    displayName: name,
    path: doc.key,
    kind,
    language,
    isDirty: doc.isDirty,
    isPreview: false,
    viewMode: doc.viewMode ?? null,
    externalStatus: null,
    isDetached: false,
  };
  useWindowStore.getState().openTab(tab);

  // 🔴 R06：视图状态快照存入回收恢复存储（编辑器挂载时按类型恢复选区/滚动/折叠）
  if (doc.viewStateSnapshot != null) {
    saveViewState(doc.key, doc.viewStateSnapshot);
  }

  // 目标回报 prepared：后端原子校验并切换所有权，committed 后本窗口解锁。
  // 🔴 N01：携带目标从载荷读取的修订版本——后端与源捕获的 expected_revision
  //    对账（不一致=载荷被替换，按中止处理），不能把字段存在当成冲突保护
  try {
    const status = await ipc.prepareTransferComplete(label, transferId, doc.revision ?? undefined);
    if (status.state === 'committed') {
      useWindowStore.getState().exitTransfer(doc.key);
      adoptKeyByTransfer.delete(transferId);
    }
  } catch (e) {
    // 🔴 R06：prepare IPC 失败不假定后端 aborted——先查询权威状态：
    //    committed→文档已属本窗口，保留并解锁；aborted/无记录→清理临时 session；
    //    查询也失败（状态不明）→保留临时 session 不删（安全侧），源保留原标签
    console.error('迁移准备确认失败，查询后端状态:', e);
    let state: 'committed' | 'aborted' | 'unknown' = 'unknown';
    try {
      const status = await ipc.queryTransfer(transferId);
      // preparing/target-prepared 也按未知处理（后端可能仍在处理 prepare 请求）
      state = status?.state === 'committed' ? 'committed'
        : status?.state === 'aborted' ? 'aborted'
          : 'unknown';
    } catch {
      state = 'unknown';
    }
    const tabStore = useWindowStore.getState();
    if (state === 'committed') {
      tabStore.exitTransfer(doc.key);
      adoptKeyByTransfer.delete(transferId);
    } else if (state === 'aborted') {
      tabStore.closeTab(doc.key);
      useDocumentStore.getState().remove(doc.key);
      tabStore.exitTransfer(doc.key);
      adoptKeyByTransfer.delete(transferId);
      showToast('接收迁移文档失败，已保留在原窗口', 'error');
    } else {
      // 🔴 R3-08/C13：状态不明（prepare 与 query 均失败）——**保留写保护**
      //    （不 exitTransfer：双方均不能因"未知"恢复写入——源侧的 unknown 分支
      //    同样保持保护，见 moveToNewWindow/scheduleTransferReconcle；权威终态
      //    事件（committed/aborted 迟到）或后续对账到达时再解锁/清理），
      //    标签与内容保留（可能已 committed，等事件/用户确认）
      showToast('迁移状态暂时未知，文档暂时锁定；状态确认后将自动完成或还原', 'warning');
    }
  }
}

// ── 事件监听 ──

let unlistenCloseRequested: (() => void) | null = null;
let unlistenFocusTab: (() => void) | null = null;
let unlistenDragDrop: (() => void) | null = null;
let unlistenTransferEvents: Array<() => void> = [];
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
// 🔴 N07：事件监听建立代际——StrictMode 快速卸载/重挂载时，旧 start 的迟到
//    监听 Promise 不写入模块句柄（否则覆盖新监听造成泄漏/幽灵回调）
let listenersEpoch = 0;

/**
 * 启动必要事件监听（可等待：返回时全部订阅已完成）。
 * 包含：关闭拦截（数据保护）、跨窗口聚焦、拖拽（入队 + 唤醒）、迁移事件、对账定时器。
 * open-requests-available 由 bootCoordinator 在握手前订阅。
 */
export async function startEventListeners(): Promise<void> {
  const label = getCurrentWindow().label;
  // 🔴 N07：本批监听的代际——每个 await 后校验，被新 start 取代时立即注销
  const epoch = ++listenersEpoch;

  const accept = (currentEpoch: number): boolean => currentEpoch === listenersEpoch;

  // 🔴 关闭拦截（数据保护）：必须在任何打开/迁移之前建立
  if (!unlistenCloseRequested) {
    const unlisten = await onCloseRequested((targetLabel) => {
      // 仅当目标窗口为当前窗口时才处理关闭拦截，避免多窗口间广播误触发
      const currentLabel = getCurrentWindow().label;
      if (targetLabel && targetLabel !== currentLabel) {
        return;
      }
      requestCurrentWindowClose();
    });
    if (!accept(epoch)) {
      try { unlisten(); } catch { /* 已注销 */ }
      return;
    }
    unlistenCloseRequested = unlisten;
  }

  if (!unlistenFocusTab) {
    const unlisten = await onFocusTab(({ key }) => {
      // 其他窗口请求聚焦某个 tab（跨窗口唯一性）
      useWindowStore.getState().activateTab(key);
    });
    if (!accept(epoch)) {
      try { unlisten(); } catch { /* 已注销 */ }
      return;
    }
    unlistenFocusTab = unlisten;
  }

  // 拖拽：drop 事件入队本窗口打开队列并唤醒消费（不再在监听里直接打开）
  if (!unlistenDragDrop) {
    const unlisten = await onDragDrop(async (payload) => {
      if (payload.type === 'enter' || payload.type === 'over') {
        useLayoutStore.getState().setIsDraggingFile(true);
      } else if (payload.type === 'leave') {
        useLayoutStore.getState().setIsDraggingFile(false);
      } else if (payload.type === 'drop') {
        useLayoutStore.getState().setIsDraggingFile(false);
        if (payload.paths.length > 0) {
          try {
            await ipc.enqueueOpenRequests(label, payload.paths, 'drop');
          } catch (e) {
            console.error('拖拽入队失败:', e);
          }
          requestDrain();
        }
      }
    });
    if (!accept(epoch)) {
      try { unlisten(); } catch { /* 已注销 */ }
      return;
    }
    unlistenDragDrop = unlisten;
  }

  // 迁移事件（committed/aborted）：源侧等待收尾、目标侧解锁/清理
  if (unlistenTransferEvents.length === 0) {
    const unlisteners = await subscribeTransferEvents({
      onCommitted: ({ transferId, key }) => {
        // 源侧：解除等待（moveToNewWindow 的 Promise resolve / 对账回调收尾）
        const resolve = pendingTransferWaits.get(transferId);
        if (resolve) {
          pendingTransferWaits.delete(transferId);
          resolve('committed');
        }
        // 目标侧（非等待方）：committed 通知到达时解锁（幂等）
        useWindowStore.getState().exitTransfer(key);
        adoptKeyByTransfer.delete(transferId);
      },
      onAborted: ({ transferId }) => {
        const resolve = pendingTransferWaits.get(transferId);
        if (resolve) {
          pendingTransferWaits.delete(transferId);
          resolve('aborted');
        }
        // 目标侧：删除临时 session（aborted 事件不含 key，用本地映射反查）
        const key = adoptKeyByTransfer.get(transferId);
        if (key) {
          adoptKeyByTransfer.delete(transferId);
          const tabStore = useWindowStore.getState();
          tabStore.closeTab(key);
          useDocumentStore.getState().remove(key);
          tabStore.exitTransfer(key);
        }
      },
    });
    if (!accept(epoch)) {
      for (const unlisten of unlisteners) {
        try { unlisten(); } catch { /* 已注销 */ }
      }
      return;
    }
    unlistenTransferEvents = unlisteners;
  }

  // 对账定时器 — 每 30 秒调用 reconcile_documents
  if (!reconcileTimer) {
    reconcileTimer = setInterval(async () => {
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
 * 停止事件监听（卸载时；bootCoordinator 的队列监听由 releaseBootCoordinator 管理）
 */
export function stopEventListeners(): void {
  unlistenCloseRequested?.();
  unlistenFocusTab?.();
  unlistenDragDrop?.();
  unlistenCloseRequested = null;
  unlistenFocusTab = null;
  unlistenDragDrop = null;
  for (const unlisten of unlistenTransferEvents) {
    try {
      unlisten();
    } catch {
      // 已注销
    }
  }
  unlistenTransferEvents = [];

  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

// ── 窗口关闭流程 ──

/**
 * 请求关闭当前窗口：统一承接标题栏按钮与系统关闭事件。
 * 若存在未保存文档则保留窗口关闭意图并弹出确认框；否则立即执行实际关闭流程。
 * 迁移保护中的文档不进入关闭确认（迁移未提交前不能销毁源内容）。
 */
export async function requestCurrentWindowClose(): Promise<void> {
  const tabStore = useWindowStore.getState();
  const label = getCurrentWindow().label;

  // 空白未命名文件可直接关闭；只有脏态或确有内容的未命名文件进入关闭保护。
  const dirtyTabs = tabStore.tabs.filter(
    (tab) => !tabStore.isTransferring(tab.key) && hasUnsavedWork(tab.key),
  );

  if (dirtyTabs.length > 0) {
    // 系统关闭请求到达时先立即刷新副本；即使用户尚未在确认框中选择，内容也已受保护。
    try {
      await stashPendingDocuments({ keys: dirtyTabs.map((tab) => tab.key) });
    } catch (error) {
      console.error('关闭前暂存失败:', error);
      showToast(`关闭前暂存失败：${error instanceof Error ? error.message : String(error)}`, 'error', 5000);
    }
    // 触发拦截对话框
    tabStore.requestWindowClose(dirtyTabs.map((t) => t.key));
    return; // 不继续关闭，等待用户选择
  }

  // 无脏文档，直接执行关闭流程
  await performWindowClose(label);
}

/**
 * 执行实际窗口关闭：注销文档 → 通知后端注销并关闭窗口/退出进程
 */
export async function performWindowClose(label: string, snapshotSaved = false): Promise<void> {
  const tabStore = useWindowStore.getState();

  // 无确认框的干净窗口在这里记录；有确认框的分支会在移除标签前提前记录。
  if (!snapshotSaved) {
    try {
      await saveCurrentWindowSnapshot();
    } catch (error) {
      console.error('保存最近文件快照失败:', error);
      showToast('最近文件记录失败，但不会影响本次关闭', 'warning');
    }
  }

  // 🔴 N05：统一异步关闭协调（可等待）——逐标签完成
  //    停止接纳（标签移除时已同步完成）→ 排空在途写队列 → 按真实身份注销归属。
  //    逐个 await 保证注销序列稳定（drain 完成后再关窗，晚到的旧写入不覆盖）。
  for (const tab of tabStore.tabs) {
    await disposeTabLifecycleAsync(tab.key);
  }

  // 通知 Rust 关闭本窗口并安全退出（不提前清空 store，避免出现全白空白画面滞留）
  // 🔴 性能诊断：窗口关闭前批量上报剩余 web spans（Rust 侧退出时统一落盘）
  await reportWebSpans('window-close');
  try {
    await ipc.closeWindow(label);
  } catch (e) {
    console.error('关闭窗口失败:', e);
  }
}

// ── FR-606：迁移到新窗口（transferId 协议）──

/**
 * 将当前 tab 迁移到新窗口。
 * 流程（C 节 + N01 完整屏障）：迁移保护 → 移走焦点（IME 组合输入先落地）→
 * flush 权威内容 → 捕获 revision/历史/视图 → begin → 等待权威终态 →
 * committed 后源清理（transferred 语义）；aborted 后源解锁保留；
 * 未知终态保留数据并保持迁移保护，事件/查询对账后收尾。
 */
export async function moveToNewWindow(docKey: string): Promise<boolean> {
  const docStore = useDocumentStore.getState();
  const doc = docStore.getDocument(docKey);
  if (!doc) return false;

  const tabStore = useWindowStore.getState();
  const tab = tabStore.getTab(docKey);
  if (!tab) return false;
  if (tabStore.isTransferring(docKey)) return false; // 已有迁移在进行

  const label = getCurrentWindow().label;

  // 🔴 N02：迁移是正文出口——未加载的懒标签先按需加载；失败/未知一律中止
  //    （绝不用空占位镜像迁移，也不用 '' 补成合法空文档）
  const writable = await ensureWritableContent(docKey);
  if (writable === null) {
    showToast('正文尚未加载完成，无法迁移', 'warning');
    return false;
  }

  // 1. 🔴 N01 完整屏障：先进入迁移保护（阻断关闭竞争与界面输入），再移走焦点
  //    （pointerEvents 不挡已聚焦编辑器的键盘/IME——blur 让组合输入先提交），
  //    然后才 flush——保护先于捕获，捕获后不再有新输入混入
  tabStore.enterTransfer(docKey);
  try {
    (document.activeElement as HTMLElement | null)?.blur();
  } catch {
    // 忽略
  }

  const capabilities = getEditorCapabilities(docKey);
  const captured = capabilities ? await capabilities.flush('transfer') : null;
  const content = captured?.content ?? useDocumentStore.getState().getDocument(docKey)?.content;
  if (content == null) {
    // 🔴 N02：无权威正文（无实例且镜像未知）——中止迁移，源保持原状
    tabStore.exitTransfer(docKey);
    showToast('无法捕获文档正文，迁移已取消', 'error');
    return false;
  }
  const revision = captured?.revision ?? getDocumentRevision(docKey);

  // 🔴 R06：捕获真实视图状态（选区/滚动/折叠/查看变换；不可回收类型同样捕获）
  const capturedViewState = capabilities?.captureViewState?.() ?? null;
  // 🔴 R06：可序列化统一历史（检查点+补丁链整体迁移；目标无历史时导入）
  const serializedHistory = serializeDocumentHistory(docKey);

  // 2. 构建完整迁移载荷（不读滞后镜像；携带原 metadata、基线、视图状态与历史）
  const transferred: TransferredDocument = {
    key: doc.key,
    content,
    boardScene: null,
    isDirty: doc.isDirty,
    viewMode: tab.viewMode as 'visual' | 'source' | null,
    viewState: {
      selection: null,
      scrollTop: 0,
      boardViewport: null,
      foldedRanges: [],
    },
    kind: doc.kind,
    language: doc.language,
    encoding: doc.encoding,
    eol: doc.eol,
    readonly: doc.readonly,
    mtime: doc.mtime,
    size: doc.size,
    baseline: doc.baselineContent,
    revision,
    history: serializedHistory,
    // 额外视图状态（captureViewState 的判别联合快照）
    viewStateSnapshot: capturedViewState,
  };

  showToast('正在移动到新窗口…', 'info');

  // 🔴 N01：终态未知时保持迁移保护（finally 不解锁，由对账回调负责）
  let reconcileUnknown = false;
  try {
    // 3. 发起迁移（创建目标窗口 + 注册 Preparing 记录；所有权仍属源）
    const { transferId } = await ipc.beginDocumentTransfer(label, transferred, revision);

    // 4. 等待权威终态（事件优先 + 低频查询兜底；禁止盲目超时回滚）
    const outcome = await waitForTransferOutcome(transferId, label);
    if (outcome === 'committed') {
      // 5. 源清理（transferred 语义）：不移除目标所有权、不删暂存、不清空目标已接管的历史
      tabStore.closeTab(docKey);
      docStore.remove(docKey);
      clearDocumentRevision(docKey);
      return true;
    }
    if (outcome === 'aborted') {
      // 权威 aborted：源解锁，文档保留在原窗口
      showToast('迁移未完成，文档已保留在当前窗口', 'warning');
      return false;
    }
    // 🔴 N01：终态未知——保留数据并保持迁移保护（源/目标均不恢复写入，防止
    //    两个会话同时持有写权限）；事件与低频查询对账到达权威终态后再收尾
    reconcileUnknown = true;
    scheduleTransferReconcile(transferId, docKey);
    showToast('迁移状态暂时未知，文档暂时锁定；状态确认后将自动完成或还原', 'warning');
    return false;
  } catch (e) {
    console.error('迁移到新窗口失败:', e);
    showToast('迁移到新窗口失败，文档已保留在当前窗口', 'error');
    return false;
  } finally {
    // 🔴 N01：终态未知时保持迁移保护（对账回调负责解锁），其余终态正常解锁
    if (!reconcileUnknown) tabStore.exitTransfer(docKey);
  }
}

/** 迁移等待的权威终态（unknown = 后端状态不可知，必须保守处理） */
export type TransferOutcome = 'committed' | 'aborted' | 'unknown';

/** 迁移等待中的 Promise（transferId → 终态回调） */
const pendingTransferWaits = new Map<string, (outcome: 'committed' | 'aborted') => void>();

/** 仅供测试：读取当前迁移等待注册表（事件驱动路径断言用） */
export function pendingTransferWaitsForTest(): ReadonlyMap<string, (outcome: 'committed' | 'aborted') => void> {
  return pendingTransferWaits;
}

/**
 * 等待迁移终态：事件（committed/aborted）优先；
 * 事件丢失时每 2 秒查询一次后端状态（最多 15 次 = 30 秒）；
 * 30 秒仍无终态——查询权威状态：committed→成功；未提交→主动 CAS abort
 * （后端拒绝已提交）；查询/中止均失败→unknown（保守，不删任何数据）。
 */
function waitForTransferOutcome(transferId: string, sourceLabel: string): Promise<TransferOutcome> {
  return new Promise<TransferOutcome>((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    // 🔴 N01：settle 一次性清理轮询与超时两个句柄——成功提前 settle 后
    //    30 秒 timeout 不得再执行查询/中止
    const settle = (outcome: TransferOutcome) => {
      if (settled) return;
      settled = true;
      pendingTransferWaits.delete(transferId);
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(outcome);
    };
    // 事件驱动（startEventListeners 的 onCommitted/onAborted 调用 settle）
    pendingTransferWaits.set(transferId, (outcome) => settle(outcome));
    // 低频查询兜底：事件通道异常时以后端状态为准
    pollTimer = setInterval(() => {
      ipc
        .queryTransfer(transferId)
        .then((status) => {
          if (status?.state === 'committed') settle('committed');
          else if (status?.state === 'aborted') settle('aborted');
        })
        .catch(() => {
          // 查询失败：保持等待（窗口销毁等场景由事件/unmount 收尾）
        });
    }, 2000);
    // 🔴 N01：30 秒仍无终态——先查询后端权威状态再决定，绝不把"中止成功"
    //    当成"提交成功"（布尔混淆正是 B08 数据丢失的根因）
    timeoutHandle = setTimeout(() => {
      void (async () => {
        try {
          const status = await ipc.queryTransfer(transferId);
          if (status?.state === 'committed') {
            settle('committed');
            return;
          }
          if (status?.state === 'aborted') {
            settle('aborted');
            return;
          }
          if (status && (status.state === 'preparing' || status.state === 'target-prepared')) {
            try {
              const aborted = await ipc.abortTransfer(sourceLabel, transferId, 'transfer-timeout');
              // 🔴 N01：以后端返回的权威状态为准——abort 成功返回 aborted；
              //    抢占失败返回 committed（迁移已提交，不得按失败删源）
              if (aborted.state === 'aborted') settle('aborted');
              else if (aborted.state === 'committed') settle('committed');
              else settle('unknown');
            } catch {
              // abort 请求本身失败：可能刚好 committed——重新查询权威状态
              settle(await resolveOutcomeByQuery(transferId));
            }
            return;
          }
          settle('unknown'); // 无记录/未知状态：保守处理
        } catch {
          settle('unknown'); // 查询失败：状态不明，保留数据
        }
      })();
    }, 30_000);
  });
}

/** 通过查询解决不确定终态（abort IPC 失败后的二次确认） */
async function resolveOutcomeByQuery(transferId: string): Promise<TransferOutcome> {
  try {
    const status = await ipc.queryTransfer(transferId);
    if (status?.state === 'committed') return 'committed';
    if (status?.state === 'aborted') return 'aborted';
  } catch {
    // 查询失败
  }
  return 'unknown';
}

/**
 * 🔴 N01：终态未知时的对账——源保持迁移保护与全部数据（正文/历史/视图），
 * 事件（可能迟到）与低频查询到达权威终态后按对应语义收尾：
 * committed→源清理（transferred 语义）；aborted→解锁源恢复编辑。
 * 上限 60 秒无终态则停止轮询并提示（事件注册保留——事件最终到达时仍可收尾）。
 */
function scheduleTransferReconcile(transferId: string, docKey: string): void {
  if (pendingTransferWaits.has(transferId)) return; // 已有对账进行中
  let elapsed = 0;
  const reconcile = (outcome: 'committed' | 'aborted') => {
    const tabStore = useWindowStore.getState();
    if (outcome === 'committed') {
      // 权威 committed：源清理（与 moveToNewWindow 成功路径同语义）
      tabStore.closeTab(docKey);
      useDocumentStore.getState().remove(docKey);
      clearDocumentRevision(docKey);
      tabStore.exitTransfer(docKey);
      showToast('迁移已确认完成，文档已移至新窗口', 'success');
    } else {
      // 权威 aborted：解锁源，文档保留
      tabStore.exitTransfer(docKey);
      showToast('迁移未完成，文档已恢复编辑', 'info');
    }
  };
  pendingTransferWaits.set(transferId, reconcile);
  const timer = setInterval(() => {
    elapsed += 5000;
    if (elapsed > 60_000) {
      // 超时上限：停止主动轮询（事件注册保留），提示用户
      clearInterval(timer);
      if (pendingTransferWaits.get(transferId) === reconcile) {
        showToast('迁移状态长时间未确认，文档保持锁定；请稍后重试或重启应用', 'error', 6000);
      }
      return;
    }
    ipc
      .queryTransfer(transferId)
      .then((status) => {
        if (status?.state === 'committed' || status?.state === 'aborted') {
          clearInterval(timer);
          const cb = pendingTransferWaits.get(transferId);
          if (cb === reconcile) {
            pendingTransferWaits.delete(transferId);
            reconcile(status.state);
          }
        }
      })
      .catch(() => {
        // 查询失败：下一轮重试
      });
  }, 5000);
}

// ── 新建空窗口（Ctrl+Shift+N）──

export async function newEmptyWindow(): Promise<void> {
  try {
    await ipc.createWindow({ type: 'empty' });
  } catch (e) {
    console.error('新建窗口失败:', e);
  }
}

// ── 卸载（窗口关闭/组件销毁）──

export function disposeWindowManager(): void {
  stopEventListeners();
  releaseBootCoordinator();
}
