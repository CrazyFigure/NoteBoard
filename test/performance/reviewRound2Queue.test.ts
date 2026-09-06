// 二轮复审反例（B09/B10/B12，正式迁入）：队列故障和 StrictMode 在途初始化；所有 IPC 都是内存替身。
// 断言来自《二轮复审意见与整改清单.md》，期望为整改后的正确行为；不随缺陷调整期望。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '@/core/ipc/commands';
import * as events from '@/core/ipc/events';
import { acquireBootCoordinator, releaseBootCoordinator, requestDrain, resetBootCoordinatorForTest, setRequestProcessor, getConsumerId } from '@/app/bootCoordinator';
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main' }) }));
vi.mock('@/core/ipc/events', () => ({ onOpenRequestsAvailable: vi.fn(), onTransferAborted: vi.fn(), onTransferCommitted: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({ windowListenersReady: vi.fn(), listOpenRequests: vi.fn(), ackOpenRequest: vi.fn() }));

// 单纯推进微任务；不会真的等待重试间隔。
async function settleMicrotasks(): Promise<void> { for (let i = 0; i < 200; i++) await Promise.resolve(); }
const boot = (consumerId: string) => ({ consumerId, startupMode: 'explicit-open' as const, transferId: null, queueVersion: 1, protocolVersion: 1 });

describe('二轮复审：队列失效分支', () => {
  beforeEach(() => {
    vi.resetAllMocks(); resetBootCoordinatorForTest();
    vi.mocked(events.onOpenRequestsAvailable).mockResolvedValue(() => {});
    vi.mocked(ipc.windowListenersReady).mockResolvedValue(boot('current'));
  });
  afterEach(() => { resetBootCoordinatorForTest(); vi.restoreAllMocks(); });

  it.each(['reject', 'false'] as const)('B09：ACK 持续 %s 时单次 drain 不得反复执行同一请求', async mode => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let pages = 0;
    vi.mocked(ipc.listOpenRequests).mockImplementation(async () => {
      // 测试的断路器在第三页后中止；业务代码不能依赖这个断路器。
      if (++pages > 3) throw new Error('test-only circuit breaker');
      return [{ request: { requestId: 'pending-one', path: 'C:/round2/repeat.md' } }] as never;
    });
    if (mode === 'reject') vi.mocked(ipc.ackOpenRequest).mockRejectedValue(new Error('IPC unavailable'));
    else vi.mocked(ipc.ackOpenRequest).mockResolvedValue(false);
    await acquireBootCoordinator();
    const process = vi.fn().mockResolvedValue('opened');
    setRequestProcessor(process);
    requestDrain();
    await settleMicrotasks();
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('B10：旧挂载握手晚到不得覆盖新挂载 consumer', async () => {
    let finishOld!: (value: ReturnType<typeof boot>) => void;
    vi.mocked(ipc.windowListenersReady)
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce(boot('new-consumer'));
    const oldAcquire = acquireBootCoordinator();
    await settleMicrotasks();
    releaseBootCoordinator();
    await acquireBootCoordinator();
    expect(getConsumerId()).toBe('new-consumer');
    finishOld(boot('old-consumer'));
    await oldAcquire.catch(() => {});
    expect(getConsumerId()).toBe('new-consumer');
  });

  it('B12：设置和壳尚未就绪时，唤醒事件只能留下请求不能开始打开', async () => {
    vi.mocked(ipc.listOpenRequests).mockResolvedValueOnce([{ request: { requestId: 'early', path: 'C:/round2/early.md' } }] as never).mockResolvedValue([]);
    vi.mocked(ipc.ackOpenRequest).mockResolvedValue(true);
    // 对应 initWindow 返回、App 正在 await settings.init 的真实阶段。
    await acquireBootCoordinator();
    const process = vi.fn().mockResolvedValue('opened');
    setRequestProcessor(process);
    const wake = vi.mocked(events.onOpenRequestsAvailable).mock.calls[0][0];
    wake({} as never);
    await settleMicrotasks();
    expect(process).not.toHaveBeenCalled();
  });
});
