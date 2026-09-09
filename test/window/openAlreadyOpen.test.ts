// NoteBoard S07 打开链路测试：重复打开不读正文、跨窗口聚焦、失败不建标签
// 覆盖 G 节判定：重复打开只激活原文档；读失败完成失败显示；无幽灵所有权

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWindowStore } from '../../src/stores/windowStore';
import { useDocumentStore } from '../../src/stores/documentStore';
import { useExplorerStore } from '../../src/features/explorer/explorerStore';
import { openDocument } from '../../src/features/editor-code/orchestration/openDocument';
import * as ipc from '../../src/core/ipc/commands';

// Mock ipc 接口
vi.mock('../../src/core/ipc/commands', () => ({
  prepareDocument: vi.fn(),
  registerDocument: vi.fn(),
  readDir: vi.fn(),
  pushRecent: vi.fn().mockResolvedValue(undefined),
  focusWindow: vi.fn().mockResolvedValue(undefined),
}));

// Mock @tauri-apps/api/window
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'nb-main' }),
}));

describe('S07 打开链路（统一文件准备）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
    useExplorerStore.setState({ root: null, expanded: new Map(), revealed: null });
  });

  it('本窗口已打开的文件再次打开：只激活原标签，不重复读正文不建新标签', async () => {
    const mdPath = 'C:\\t\\a.md';
    // 预置已打开的标签（activeKey 先指向其它标签，验证激活切换）
    useWindowStore.setState({
      tabs: [
        {
          key: mdPath,
          displayName: 'a.md',
          path: mdPath,
          kind: 'markdown',
          language: 'markdown',
          isDirty: false,
          isPreview: false,
          viewMode: null,
          externalStatus: null,
          isDetached: false,
        },
        {
          key: 'C:\\t\\b.md',
          displayName: 'b.md',
          path: 'C:\\t\\b.md',
          kind: 'markdown',
          language: 'markdown',
          isDirty: false,
          isPreview: false,
          viewMode: null,
          externalStatus: null,
          isDetached: false,
        },
      ],
      activeKey: 'C:\\t\\b.md',
    });
    vi.mocked(ipc.prepareDocument).mockResolvedValue({
      type: 'already-open',
      key: mdPath,
      ownerLabel: 'nb-main',
      ownerIsSelf: true,
    });

    const result = await openDocument(mdPath);
    expect(result).toBe('focused');
    // 激活原标签；标签数量不变
    expect(useWindowStore.getState().activeKey).toBe(mdPath);
    expect(useWindowStore.getState().tabs).toHaveLength(2);
    // 🔴 不重复读正文：register/readDir/pushRecent 均不调用
    expect(ipc.registerDocument).not.toHaveBeenCalled();
    expect(ipc.readDir).not.toHaveBeenCalled();
    expect(ipc.pushRecent).not.toHaveBeenCalled();
  });

  it('其他窗口已打开：聚焦所有者窗口，本窗口不建标签', async () => {
    const mdPath = 'C:\\t\\shared.md';
    vi.mocked(ipc.prepareDocument).mockResolvedValue({
      type: 'already-open',
      key: mdPath,
      ownerLabel: 'nb-2',
      ownerIsSelf: false,
    });

    const result = await openDocument(mdPath);
    expect(result).toBe('focused');
    expect(ipc.focusWindow).toHaveBeenCalledWith('nb-2');
    expect(useWindowStore.getState().tabs).toHaveLength(0);
    expect(useDocumentStore.getState().documents.size).toBe(0);
  });

  it('读取失败：显示失败提示并返回 failed，不建标签不留所有权', async () => {
    const missingPath = 'C:\\t\\missing.md';
    vi.mocked(ipc.prepareDocument).mockResolvedValue({
      type: 'failed',
      message: '文件不存在或无法访问',
      missing: true,
    });

    const result = await openDocument(missingPath);
    expect(result).toBe('failed');
    expect(useWindowStore.getState().tabs).toHaveLength(0);
    // 失败不注册文档（无幽灵所有权）
    expect(ipc.registerDocument).not.toHaveBeenCalled();
  });
});
