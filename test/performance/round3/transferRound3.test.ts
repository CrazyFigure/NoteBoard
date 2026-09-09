// 三轮复审反例（正式迁入自 test-results/performance/review-20260906-round3/）——断言为整改后正确行为。
// 三轮复审：经真实目标窗口启动链接收迁移；事件与 IPC 均为内存替身。
import { afterEach, expect, it, vi } from 'vitest';
import { initWindow, requestShellReadyAndDrain, disposeWindowManager } from '@/features/window/windowManager';
import { useWindowStore } from '@/stores/windowStore';
import { useDocumentStore } from '@/stores/documentStore';
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-target' }) }));
vi.mock('@/core/ipc/events', () => ({ onCloseRequested: vi.fn().mockResolvedValue(() => {}), onFocusTab: vi.fn().mockResolvedValue(() => {}), onDragDrop: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/app/bootCoordinator', () => ({ acquireBootCoordinator: vi.fn().mockResolvedValue({ startupMode: 'handoff', transferId: 'round3-target', consumerId: 'target' }), releaseBootCoordinator: vi.fn(), setRequestProcessor: vi.fn(), subscribeTransferEvents: vi.fn().mockResolvedValue([]), requestDrain: vi.fn(), markBusinessReady: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({
  takeTransferPayload: vi.fn().mockResolvedValue({ key: 'C:/round3/target.md', content: 'unsaved-text', kind: 'markdown', language: 'markdown', isDirty: true, revision: 1, baseline: 'base' }),
  prepareTransferComplete: vi.fn().mockRejectedValue(new Error('commit response lost')),
  queryTransfer: vi.fn().mockRejectedValue(new Error('state unavailable')),
  windowShellReady: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => { disposeWindowManager(); });
it('C13：目标 prepare 和 query 都失败时必须保留迁移写保护', async () => {
  useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] }); useDocumentStore.setState({ documents: new Map() });
  await initWindow(); await requestShellReadyAndDrain();
  expect(useDocumentStore.getState().getDocument('C:/round3/target.md')?.content).toBe('unsaved-text');
  expect(useWindowStore.getState().isTransferring('C:/round3/target.md')).toBe(true);
});
