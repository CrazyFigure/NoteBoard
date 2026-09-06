// NoteBoard 窗口启动协调器（S04 C 节协议）
//
// 🔴 职责与不变量：
//   1. 启动顺序固定：建立接收/关闭/焦点监听与数据保护 → 等监听确认 →
//      window_listeners_ready 握手（分配 consumer）→ 读取必要设置 →
//      显示主题正确的壳（window_shell_ready）→ drain 打开队列。
//   2. drain 只允许一个运行者；事件到达设置 drainRequested；运行者拉取、按序处理并
//      确认，退出前再次检查标志（覆盖“刚收到空列表、尚未释放运行标志时又来事件”）。
//   3. consumer 生命周期：StrictMode 挂载/卸载只改变引用计数；真正 WebView 重载才替换。
//      初始化重复调用复用同一 Promise；尚未完成的 listener Promise 在释放后返回时立刻 unlisten。
//   4. 窗口重新获得焦点和初始化完成时主动 drain（恢复机制）；正常运行不创建毫秒级轮询。
//   5. 初始化错误必须有可见、可关闭、可重试的错误界面（error 状态导出）。
//   6. 🔴 N06：同一 consumer 代际内每个 requestId 只执行一次打开副作用——ACK 失败
//      重拉时仅重试确认（有上限退避；预算耗尽退出本次 drain，受控定时重试）。
//   7. 🔴 N07：boot epoch——每次初始化递增的不可变代际；旧初始化的迟到监听/握手
//      响应不得写入新状态（StrictMode 在途初始化覆盖新 consumer）。业务就绪门槛：
//      握手完成 ≠ 可消费——事件唤醒在设置加载完成前仅记录待处理，显式放行后补 drain。

import { getCurrentWindow } from '@tauri-apps/api/window';
import * as ipc from '../core/ipc/commands';
import {
  onOpenRequestsAvailable,
  onTransferAborted,
  onTransferCommitted,
} from '../core/ipc/events';
import type { OpenRequestDto, WindowBootDto } from '../core/ipc/types';
import { perfMark } from '../core/perf/perfMarks';
// 🔴 N10.2：requestId → 编辑器实例就绪的关联登记（终点标记与打开请求对齐）
import { markEditorOpenRequest } from '../core/perf/editorReadyMark';

/** 单次处理请求的结果（映射到 ack 的 OpenOutcome） */
export type OpenRequestResult = 'opened' | 'focused' | 'cancelled' | 'failed';

/** 由 windowManager 提供的请求处理器（打开文件/目录的业务编排） */
export type OpenRequestProcessor = (request: OpenRequestDto) => Promise<OpenRequestResult>;

interface BootCoordinatorState {
  /** 引用计数（StrictMode 双挂载/卸载只增减计数，不销毁协调器） */
  refCount: number;
  /** 初始化 Promise（重复调用复用） */
  bootPromise: Promise<WindowBootDto> | null;
  /** 当前 consumer（WebView 重载时由新握手替换） */
  consumerId: string | null;
  startupMode: WindowBootDto['startupMode'] | null;
  transferId: string | null;
  /** 事件 unlisten 句柄 */
  unlisteners: Array<() => void>;
  /** drain 状态 */
  draining: boolean;
  drainRequested: boolean;
  /** 协调器已销毁（窗口关闭） */
  disposed: boolean;
  /** 初始化失败（供 UI 呈现可重试错误） */
  bootError: string | null;
  /** 🔴 N07：业务就绪门槛——设置加载完成前事件唤醒只记录待处理（shell ready 放行） */
  businessReady: boolean;
  /** 🔴 N06：本 consumer 代际内已处理请求的结果（ACK 失败重拉时只重试 ACK 不重执行） */
  processedRequests: Map<string, OpenRequestResult>;
}

const state: BootCoordinatorState = {
  refCount: 0,
  bootPromise: null,
  consumerId: null,
  startupMode: null,
  transferId: null,
  unlisteners: [],
  draining: false,
  drainRequested: false,
  disposed: false,
  bootError: null,
  businessReady: false,
  processedRequests: new Map(),
};

/**
 * 🔴 N07：boot epoch——每次初始化递增、永不复位的代际。
 * 旧初始化（监听建立/握手响应）与旧 drain 运行者在每个 await 后校验，
 * 被取代即作废，不得读写新状态。
 */
let bootEpoch = 0;

/** 请求处理器注册（windowManager 在启动时提供；避免循环依赖由外部注入） */
let requestProcessor: OpenRequestProcessor | null = null;

export function setRequestProcessor(processor: OpenRequestProcessor): void {
  requestProcessor = processor;
}

/** 当前 consumer（测试与迁移流程使用） */
export function getConsumerId(): string | null {
  return state.consumerId;
}

/** 当前启动模式 */
export function getStartupMode(): WindowBootDto['startupMode'] | null {
  return state.startupMode;
}

// ── drain：单运行者队列消费 ──

/**
 * 请求一次 drain（并发调用安全）。
 * @param gated true=事件唤醒路径：业务未就绪（设置加载完成前）时仅记录待处理，
 *              显式放行（markBusinessReady）后补消费——编辑文档不得在真实设置
 *              与保存策略就绪前启动；false/缺省=显式请求（调用方声明消费时机合适，
 *              如 shell ready、ACK 重试）。
 */
export function requestDrain(gated = false): void {
  if (state.disposed || !state.consumerId) return;
  state.drainRequested = true;
  // 🔴 N07：业务未就绪时事件唤醒只记录待处理
  if (gated && !state.businessReady) return;
  void runDrain();
}

/**
 * 🔴 N07：业务就绪放行（设置加载完成后由 requestShellReadyAndDrain 调用）。
 * 期间缓存的事件唤醒在此补消费；不等待字体或无关预热。
 */
export function markBusinessReady(): void {
  if (state.businessReady) return;
  state.businessReady = true;
  if (state.drainRequested && !state.disposed && state.consumerId) {
    void runDrain();
  }
}

/** 🔴 N06：ACK 预算耗尽后的受控定时重试（5 秒后重新 drain；新事件可提前触发） */
let drainRetryTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDrainRetry(): void {
  if (drainRetryTimer) return;
  drainRetryTimer = setTimeout(() => {
    drainRetryTimer = null;
    requestDrain();
  }, 5000);
}

/**
 * ACK 确认：立即一次 + 退避重试（100/300ms），成功返回 true。
 * 每个 await 后校验 epoch——被取代的 drain 不得继续确认。
 */
async function ackOpenRequestWithRetry(
  epoch: number,
  label: string,
  consumerId: string,
  requestId: string,
  outcome: OpenRequestResult,
): Promise<boolean> {
  const delays = [0, 100, 300];
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (epoch !== bootEpoch || state.disposed) return false; // 已被取代：停止确认
    try {
      const ok = await ipc.ackOpenRequest(label, consumerId, requestId, outcome);
      if (ok) return true;
      console.warn('确认打开请求返回未确认，准备重试:', requestId);
    } catch (e) {
      console.warn('确认打开请求失败，准备重试:', requestId, e);
    }
  }
  return false;
}

async function runDrain(): Promise<void> {
  // 已有运行者：drainRequested 已记录，由运行者退出前检查
  if (state.draining) return;
  state.draining = true;
  // 🔴 N06/N07：捕获本次 drain 的 epoch 与 consumer——旧运行者不读取可变全局
  //    consumerId（dispose/换代后不得为旧请求确认）
  const epoch = bootEpoch;
  const consumerId = state.consumerId!;
  const label = getCurrentWindow().label;
  try {
    for (;;) {
      if (state.disposed || epoch !== bootEpoch) break;
      // 🔴 先清标志再处理：处理期间到达的新事件会重新置位，退出前检查可覆盖空列表竞态
      state.drainRequested = false;
      let items: Awaited<ReturnType<typeof ipc.listOpenRequests>>;
      try {
        items = await ipc.listOpenRequests(label, consumerId);
      } catch (e) {
        console.error('拉取打开队列失败:', e);
        break;
      }
      // consumer 失效（WebView 重载后的旧协调器）或空列表
      if (!items) break;
      if (items.length === 0) {
        // 🔴 R07：空页只有当无新事件时才退出（覆盖"刚收到空列表、尚未释放运行标志时又来事件"）
        if (!state.drainRequested || state.disposed) break;
        continue;
      }
      let ackBudgetExhausted = false;
      for (const item of items) {
        if (state.disposed || epoch !== bootEpoch) return;
        const request = item.request;
        // 🔴 N06：本 consumer 内已处理过的请求（处理成功但 ACK 失败被重拉）——
        //    只重试 ACK，绝不重新执行打开副作用
        const handled = state.processedRequests.get(request.requestId);
        if (handled !== undefined) {
          const acked = await ackOpenRequestWithRetry(epoch, label, consumerId, request.requestId, handled);
          if (acked) state.processedRequests.delete(request.requestId);
          else { ackBudgetExhausted = true; break; }
          continue;
        }
        let outcome: OpenRequestResult = 'failed';
        // 🔴 R15：requestId 贯穿（处理开始/结束都带同一 ID，可与 Rust spans 对齐）
        perfMark('open_request_start', { requestId: request.requestId, path: `${request.path.slice(-40)}` });
        // 🔴 N10.2：登记 docKey → requestId——编辑器实例就绪的终点标记据此对齐
        markEditorOpenRequest(request.path, request.requestId);
        try {
          if (requestProcessor) {
            outcome = await requestProcessor(request);
          }
        } catch (e) {
          console.error('处理打开请求失败:', e);
          outcome = 'failed';
        }
        perfMark('open_request_end', { requestId: request.requestId, outcome });
        // 🔴 N06：先记录处理结果再 ACK——ACK 失败重拉时不重新执行副作用
        state.processedRequests.set(request.requestId, outcome);
        const acked = await ackOpenRequestWithRetry(epoch, label, consumerId, request.requestId, outcome);
        if (acked) state.processedRequests.delete(request.requestId);
        else { ackBudgetExhausted = true; break; }
      }
      if (ackBudgetExhausted) {
        // 🔴 N06：ACK 预算耗尽——退出本次 drain（pending 保留在 Rust 队列；
        //    processedRequests 保证下次只重试 ACK）；受控定时重试，不无限循环
        console.error('确认打开请求持续失败，本次消费暂停（5 秒后重试）');
        scheduleDrainRetry();
        break;
      }
      // 🔴 R07：成功处理非空页后主动续拉（分页队列一次唤醒拉完，不依赖新事件）
    }
  } finally {
    state.draining = false;
  }
}

// ── 启动：监听 → 握手 → 壳显示 ──

/**
 * 获取/创建窗口协调器（引用计数 +1）。
 * 顺序固定：建立必要事件监听（含数据保护）→ 监听确认 → window_listeners_ready。
 * 返回 WindowBootDto（含 consumerId / startupMode / transferId）。
 * 🔴 N07：本次初始化捕获不可变 epoch——监听/握手的迟到响应被取代时立即作废，
 *    不写入 state（不覆盖新 consumer、不遗留旧监听）。
 */
export function acquireBootCoordinator(): Promise<WindowBootDto> {
  state.refCount += 1;
  // 🔴 R08：release 到 0 后再次 acquire（StrictMode unmount→remount / 前端重试）
  //    允许重新初始化——创建新监听与新握手（旧 consumer 已随 dispose 失效）
  if (state.disposed) {
    state.disposed = false;
    state.bootPromise = null;
    state.consumerId = null;
    state.startupMode = null;
    state.transferId = null;
    state.bootError = null;
    state.businessReady = false;
    state.processedRequests.clear();
  }
  if (state.bootPromise) return state.bootPromise;

  // 🔴 N07：本初始化的不可变 epoch（旧初始化的迟到结果据此作废）
  const epoch = ++bootEpoch;

  state.bootPromise = (async (): Promise<WindowBootDto> => {
    const label = getCurrentWindow().label;
    try {
      // 1. 建立必要事件监听（可等待的 Promise；全部就绪后才握手）
      const pendingUnlisteners: Array<Promise<() => void>> = [
        onOpenRequestsAvailable(() => {
          // 🔴 事件只唤醒消费，不在监听里直接 openDocument；
          // 🔴 N07：事件唤醒受业务就绪门槛（设置加载前仅记录待处理）
          requestDrain(true);
        }),
        // 迁移事件由 windowManager 的处理器承接（committed 清理源 / aborted 解锁）
      ];
      const unlisteners = await Promise.all(pendingUnlisteners);
      // 🔴 N07：等待期间已被取代（新初始化/dispose）——立即注销本批监听，不写入 state
      if (epoch !== bootEpoch || state.disposed) {
        unlisteners.forEach((fn) => fn());
        throw new Error('boot coordinator superseded during init');
      }
      state.unlisteners = unlisteners;

      // 2. 监听就绪 → 握手（分配 consumer 代际；旧 consumer 随即失效）
      const boot = await ipc.windowListenersReady(label);
      // 🔴 N07：握手响应迟到且已被取代——不得覆盖新 consumer
      if (epoch !== bootEpoch || state.disposed) {
        throw new Error('boot coordinator superseded during handshake');
      }
      state.consumerId = boot.consumerId;
      state.startupMode = boot.startupMode;
      state.transferId = boot.transferId;
      state.bootError = null;
      // 🔴 N07：新 consumer 从 pre-business 开始（设置加载完成才放行消费）
      state.businessReady = false;
      state.processedRequests.clear();
      perfMark('listeners_ready_handshake', { startupMode: boot.startupMode });
      return boot;
    } catch (e) {
      // 只有当前 epoch 的失败才写入 bootError（旧 epoch 的失败不影响新初始化）
      if (epoch === bootEpoch) {
        const message = e instanceof Error ? e.message : String(e);
        state.bootError = message;
        state.bootPromise = null;
      }
      throw e;
    }
  })();

  return state.bootPromise;
}

/**
 * 释放协调器（引用计数 -1；归零时注销全部监听）。
 * StrictMode 卸载/重挂载只减少计数，真正关闭由 refCount=0 或窗口销毁触发。
 */
export function releaseBootCoordinator(): void {
  state.refCount = Math.max(0, state.refCount - 1);
  if (state.refCount > 0) return;
  disposeCoordinator();
}

/** 彻底销毁协调器（窗口关闭时；未完成的 drain 自然失效） */
export function disposeCoordinator(): void {
  state.disposed = true;
  for (const unlisten of state.unlisteners) {
    try {
      unlisten();
    } catch {
      // 已注销
    }
  }
  state.unlisteners = [];
  state.bootPromise = null;
  state.consumerId = null;
}

/** 读取启动错误（供错误界面呈现与重试） */
export function getBootError(): string | null {
  return state.bootError;
}

/** 重试启动（错误界面调用；重新走监听→握手流程） */
export function retryBoot(): Promise<WindowBootDto> {
  state.bootError = null;
  state.bootPromise = null;
  state.disposed = false;
  return acquireBootCoordinator();
}

// ── 迁移事件桥接（供 windowManager 注册处理器时复用） ──

/** 订阅迁移提交/中止事件（windowManager 在启动时调用一次） */
export async function subscribeTransferEvents(handlers: {
  onCommitted: (payload: { transferId: string; key: string }) => void;
  onAborted: (payload: { transferId: string; reason: string }) => void;
}): Promise<Array<() => void>> {
  const unlisteners = await Promise.all([
    onTransferCommitted(handlers.onCommitted),
    onTransferAborted(handlers.onAborted),
  ]);
  return unlisteners;
}

/** 仅供测试：重置全部协调器状态 */
export function resetBootCoordinatorForTest(): void {
  for (const unlisten of state.unlisteners) {
    try {
      unlisten();
    } catch {
      // 已注销
    }
  }
  Object.assign(state, {
    refCount: 0,
    bootPromise: null,
    consumerId: null,
    startupMode: null,
    transferId: null,
    unlisteners: [],
    draining: false,
    drainRequested: false,
    disposed: false,
    bootError: null,
    businessReady: false,
    processedRequests: new Map(),
  });
  requestProcessor = null;
  // 🔴 N07：递增 epoch 作废所有挂起的 drain/初始化（防止跨测试泄漏）
  bootEpoch += 1;
}
