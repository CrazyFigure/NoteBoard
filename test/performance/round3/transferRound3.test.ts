// 三轮复审反例（正式迁入自 test-results/performance/review-20260906-round3/）——断言为整改后正确行为。
// 三轮复审：经真实目标窗口启动链接收迁移；事件与 IPC 均为内存替身。
import { afterEach, expect, it, vi } from 'vitest';
import { initWindow, requestShellReadyAndDrain, disposeWindowManager } from '@/features/window/windowManager';
import { useWindowStore } from '@/stores/windowStore';
import { useDocumentStore } from '@/stores/documentStore';
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-target' }) }));
// 窗口初始化会先订阅迁移与拖动事件；替身必须覆盖这些边界，才能进入待验证的确认失败分支。
vi.mock('@/core/ipc/events', () => ({
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onFocusTab: vi.fn().mockResolvedValue(() => {}),
  onDragDrop: vi.fn().mockResolvedValue(() => {}),
  onTransferAvailable: vi.fn().mockResolvedValue(() => {}),
  onTabDragState: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock('@/app/bootCoordinator', () => ({ acquireBootCoordinator: vi.fn().mockResolvedValue({ startupMode: 'handoff', transferId: 'round3-target', consumerId: 'target' }), releaseBootCoordinator: vi.fn(), setRequestProcessor: vi.fn(), subscribeTransferEvents: vi.fn().mockResolvedValue([]), requestDrain: vi.fn(), markBusinessReady: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({
  // shell-ready 会补拉已有窗口的迁移队列；本例只处理启动握手携带的迁移。
  listIncomingTransfers: vi.fn().mockResolvedValue([]),
  takeTransferPayload: vi.fn().mockResolvedValue({ key: 'C:/round3/target.md', content: 'unsaved-text', kind: 'markdown', language: 'markdown', isDirty: true, revision: 1, baseline: 'base' }),
  prepareTransferComplete: vi.fn().mockRejectedValue(new Error('commit response lost')),
  queryTransfer: vi.fn().mockRejectedValue(new Error('state unavailable')),
  windowShellReady: vi.fn().mockResolvedValue(undefined),
}));

import * as ipc from '@/core/ipc/commands';
afterEach(() => { disposeWindowManager(); });
it('C13：目标 prepare 和 query 都失败时必须保留迁移写保护', async () => {
  useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] }); useDocumentStore.setState({ documents: new Map() });
  await initWindow(); await requestShellReadyAndDrain();
  // 确认两次失败均实际发生，避免测试因启动替身缺失而未覆盖迁移写保护。
  expect(ipc.prepareTransferComplete).toHaveBeenCalledWith('nb-target', 'round3-target', 1);
  expect(ipc.queryTransfer).toHaveBeenCalledWith('round3-target');
  expect(useDocumentStore.getState().getDocument('C:/round3/target.md')?.content).toBe('unsaved-text');
  expect(useWindowStore.getState().isTransferring('C:/round3/target.md')).toBe(true);
});
