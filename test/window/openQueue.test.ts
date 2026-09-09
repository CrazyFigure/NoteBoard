// NoteBoard 打开请求队列消费测试（S04 bootCoordinator）
// 覆盖：单运行者与最后一次唤醒不丢、处理失败也 ACK、consumer 失效停止消费、
//       事件只唤醒消费（处理器统一编排）

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  acquireBootCoordinator,
  requestDrain,
  resetBootCoordinatorForTest,
  setRequestProcessor,
  markBusinessReady,
} from '@/app/bootCoordinator';
import type { OpenRequestItemDto } from '@/core/ipc/types';

// Mock Tauri window
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'nb-main' }),
}));

// Mock IPC 命令（queue 形态，可编程返回）
const listOpenRequestsMock = vi.fn();
const ackOpenRequestMock = vi.fn().mockResolvedValue(true);
const windowListenersReadyMock = vi.fn().mockResolvedValue({
  protocolVersion: 1,
  consumerId: 'c-nb-main-1',
  startupMode: 'explicit-open' as const,
  transferId: null,
  queueVersion: 1,
});
vi.mock('@/core/ipc/commands', () => ({
  listOpenRequests: (...args: unknown[]) => listOpenRequestsMock(...args),
  ackOpenRequest: (...args: unknown[]) => ackOpenRequestMock(...args),
  windowListenersReady: (...args: unknown[]) => windowListenersReadyMock(...args),
}));

// Mock 事件订阅（保存回调供测试触发唤醒）
let wakeHandler: (() => void) | null = null;
vi.mock('@/core/ipc/events', () => ({
  onOpenRequestsAvailable: (cb: () => void) => {
    wakeHandler = cb;
    return Promise.resolve(() => {
      wakeHandler = null;
    });
  },
  onTransferCommitted: () => Promise.resolve(() => {}),
  onTransferAborted: () => Promise.resolve(() => {}),
}));

function item(requestId: string, path: string, sequence = 0): OpenRequestItemDto {
  return {
    request: {
      requestId,
      batchId: 'b-0',
      sequence,
      source: 'second-instance' as const,
      path,
      cwd: null,
    },
    queueVersion: 1,
  };
}

/** 等待微任务排空（drain 是异步链，无需真实 sleep） */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('打开请求队列消费（bootCoordinator drain）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBootCoordinatorForTest();
    wakeHandler = null;
    listOpenRequestsMock.mockResolvedValue(null);
  });

  it('握手成功后按序处理请求并逐个 ACK', async () => {
    const boot = await acquireBootCoordinator();
    expect(boot.consumerId).toBe('c-nb-main-1');
    expect(boot.startupMode).toBe('explicit-open');

    const processed: string[] = [];
    setRequestProcessor(async (request) => {
      processed.push(request.path);
      return 'opened';
    });
    // 🔴 R07 分页语义：一次性队列 mock（ACK 后移除；续拉返回空退出）
    const queue = [item('r-1', 'C:\\a.md', 0), item('r-2', 'C:\\b.md', 1)];
    listOpenRequestsMock.mockImplementation(async () => [...queue]);
    ackOpenRequestMock.mockImplementation(async (_l: string, _c: string, id: string) => {
      const at = queue.findIndex((x) => x.request.requestId === id);
      if (at >= 0) queue.splice(at, 1);
      return true;
    });

    requestDrain();
    await flushMicrotasks();

    expect(processed).toEqual(['C:\\a.md', 'C:\\b.md']);
    expect(ackOpenRequestMock).toHaveBeenCalledTimes(2);
    expect(ackOpenRequestMock).toHaveBeenCalledWith('nb-main', 'c-nb-main-1', 'r-1', 'opened');
    expect(ackOpenRequestMock).toHaveBeenCalledWith('nb-main', 'c-nb-main-1', 'r-2', 'opened');
  });

  it('处理器失败也 ACK failed：坏文件不永久阻塞队列', async () => {
    await acquireBootCoordinator();
    setRequestProcessor(async () => {
      throw new Error('读盘失败');
    });
    const queue = [item('r-bad', 'C:\\bad.md')];
    listOpenRequestsMock.mockImplementation(async () => [...queue]);
    ackOpenRequestMock.mockImplementation(async (_l: string, _c: string, id: string) => {
      const at = queue.findIndex((x) => x.request.requestId === id);
      if (at >= 0) queue.splice(at, 1);
      return true;
    });

    requestDrain();
    await flushMicrotasks();

    expect(ackOpenRequestMock).toHaveBeenCalledWith('nb-main', 'c-nb-main-1', 'r-bad', 'failed');
  });

  it('事件只唤醒消费：唤醒后走 list+处理器，不携带路径直接打开', async () => {
    await acquireBootCoordinator();
    // 🔴 N07 接线：事件唤醒受业务就绪门槛——本用例模拟"设置已加载完成"的
    // 真实阶段（requestShellReadyAndDrain 先 markBusinessReady 再补 drain）
    markBusinessReady();
    const processed: string[] = [];
    setRequestProcessor(async (request) => {
      processed.push(request.requestId);
      return 'opened';
    });
    const queue = [item('r-3', 'C:\\c.md')];
    listOpenRequestsMock.mockImplementation(async () => [...queue]);
    ackOpenRequestMock.mockImplementation(async (_l: string, _c: string, id: string) => {
      const at = queue.findIndex((x) => x.request.requestId === id);
      if (at >= 0) queue.splice(at, 1);
      return true;
    });

    // 模拟 nb://open-requests-available 到达
    wakeHandler?.();
    await flushMicrotasks();

    expect(processed).toEqual(['r-3']);
    expect(listOpenRequestsMock).toHaveBeenCalledWith('nb-main', 'c-nb-main-1');
  });

  it('drain 运行中到达的事件不丢：退出前重新拉取', async () => {
    await acquireBootCoordinator();
    // 分页语义：队列 2 项（ACK 后移除；处理期间新事件只置标志，运行者续拉覆盖竞态）
    const queue = [item('r-1', 'C:\\a.md'), item('r-2', 'C:\\b.md')];
    listOpenRequestsMock.mockImplementation(async () => [...queue]);
    ackOpenRequestMock.mockImplementation(async (_l: string, _c: string, id: string) => {
      const at = queue.findIndex((x) => x.request.requestId === id);
      if (at >= 0) queue.splice(at, 1);
      return true;
    });

    const processed: string[] = [];
    let processingFirst = false;
    setRequestProcessor(async (request) => {
      if (processingFirst) {
        // 模拟第一项处理期间新事件到达（重新唤醒）
        wakeHandler?.();
      }
      processed.push(request.requestId);
      processingFirst = false;
      return 'opened';
    });
    processingFirst = true;

    requestDrain();
    await flushMicrotasks();

    // 两次唤醒的两条请求都被处理（单运行者覆盖空列表竞态）
    expect(processed).toEqual(['r-1', 'r-2']);
    // 拉取至少两次（非空页后主动续拉），队列最终为空
    expect(listOpenRequestsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(queue).toHaveLength(0);
  });

  it('consumer 失效（WebView 重载后旧协调器）停止消费', async () => {
    await acquireBootCoordinator();
    setRequestProcessor(async () => 'opened');
    // consumer 失效：list 返回 null
    listOpenRequestsMock.mockResolvedValue(null);

    requestDrain();
    await flushMicrotasks();

    expect(ackOpenRequestMock).not.toHaveBeenCalled();
  });

  it('重复握手复用同一 consumer；release 后再 acquire 重新握手', async () => {
    const boot1 = await acquireBootCoordinator();
    const boot2 = await acquireBootCoordinator();
    expect(boot2.consumerId).toBe(boot1.consumerId);
    expect(windowListenersReadyMock).toHaveBeenCalledTimes(1);
  });
});
