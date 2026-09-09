// NoteBoard S10 会话恢复轻量描述符测试
// 覆盖判定：Home 不创建编辑器（零读盘/零编辑器加载）、点击才加载正文、
//           恢复不抢焦点、缺失文件跳过、暂存副本的关闭保护。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { restoreLastClosedWindow, loadRestoredTab } from '@/features/session/closedWindowSession';
import * as ipc from '@/core/ipc/commands';
import { getEditorCapabilities, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { useLayoutStore } from '@/stores/layoutStore';

// Mock openDocument（loadRestoredTab 走完整打开链；恢复本身不得调用）
const openDocumentMock = vi.fn();
vi.mock('@/features/editor-code/orchestration/openDocument', () => ({
  openDocument: (...args: unknown[]) => openDocumentMock(...args),
}));

vi.mock('@/core/ipc/commands', () => ({
  loadSession: vi.fn(),
  saveSession: vi.fn().mockResolvedValue(undefined),
  clearSession: vi.fn().mockResolvedValue(undefined),
  pathExists: vi.fn(),
  readDir: vi.fn().mockResolvedValue([]),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'nb-main' }),
}));

const KEY_A = 'C:\\t\\a.md';
const KEY_MISSING = 'C:\\t\\missing.md';

function snapshotWith(tabs: Array<{ key: string; sourcePath?: string | null; stagedPath?: string | null }>) {
  return {
    schemaVersion: 1,
    savedAt: Date.now(),
    windows: [{
      seq: 0,
      explorerRoot: '',
      layout: {
        explorerVisible: true,
        explorerWidth: 260,
        outlineVisible: false,
        outlineWidth: 240,
      },
      tabs: tabs.map((t) => ({
        key: t.key,
        isPinned: false,
        viewMode: null,
        sourcePath: t.sourcePath ?? null,
        stagedPath: t.stagedPath ?? null,
        displayName: t.key.split('\\').pop() ?? t.key,
      })),
      activeKey: tabs[0]?.key ?? '',
    }],
  };
}

describe('S10 会话恢复轻量描述符', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
    useLayoutStore.setState({ explorerVisible: false, outlineVisible: false });
    resetEditorRegistryForTest();
    openDocumentMock.mockResolvedValue('opened');
  });

  it('Home 不创建编辑器：恢复只建轻量描述符（零读盘、零编辑器能力注册）', async () => {
    vi.mocked(ipc.loadSession).mockResolvedValue(
      snapshotWith([{ key: KEY_A, sourcePath: KEY_A }]) as never,
    );
    vi.mocked(ipc.pathExists).mockResolvedValue({ exists: true, isDir: false });

    const restored = await restoreLastClosedWindow();
    expect(restored).toBe(true);

    const store = useWindowStore.getState();
    // 标签建立、Home 保持首屏（activeKey 未被恢复流程改动）
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0].lazySource).toBe(KEY_A);
    expect(store.activeKey).toBeNull();
    // 🔴 零编辑器加载：能力注册表为空
    expect(getEditorCapabilities(KEY_A)).toBeNull();
    // 🔴 零正文读盘：openDocument 未被调用
    expect(openDocumentMock).not.toHaveBeenCalled();
    // 轻量 Document：正文为空
    expect(useDocumentStore.getState().getDocument(KEY_A)?.content).toBeNull();
  });

  it('点击才加载：激活懒标签触发完整打开链并清除懒标记', async () => {
    useWindowStore.setState({
      tabs: [{
        key: KEY_A,
        displayName: 'a.md',
        path: KEY_A,
        kind: 'markdown',
        language: 'markdown',
        isDirty: false,
        isPreview: false,
        viewMode: null,
        externalStatus: null,
        isDetached: false,
        lazySource: KEY_A,
        lazyStagedPath: null,
      }],
      activeKey: KEY_A,
    });
    // 🔴 N02 接线：真实打开链成功时会把正文交付到 documentStore——
    //    返回值本身不证明正文交付，mock 同步 upsert 正文
    openDocumentMock.mockImplementation(async () => {
      useDocumentStore.getState().upsertFromPayload({
        key: KEY_A,
        displayName: 'a.md',
        dirPath: 'C:\\t',
        kind: 'markdown',
        language: 'markdown',
        content: '# 正文',
        encoding: 'utf8',
        eol: 'lf',
        size: 8,
        mtime: 0,
        readonly: false,
      });
      return 'opened';
    });

    await loadRestoredTab(KEY_A);

    // 走完整打开链（读盘/注册/编辑器预取）
    expect(openDocumentMock).toHaveBeenCalledWith(KEY_A);
    // 懒标记清除
    expect(useWindowStore.getState().getTab(KEY_A)?.lazySource).toBeUndefined();
  });

  it('🔴 N02：openDocument 返回成功但正文未交付时不得清除懒标记（返回值不证明交付）', async () => {
    useWindowStore.setState({
      tabs: [{
        key: KEY_A,
        displayName: 'a.md',
        path: KEY_A,
        kind: 'markdown',
        language: 'markdown',
        isDirty: false,
        isPreview: false,
        viewMode: null,
        externalStatus: null,
        isDetached: false,
        lazySource: KEY_A,
        lazyStagedPath: null,
      }],
      activeKey: KEY_A,
    });
    // mock 只返回 opened、不交付正文（模拟 focused/取消等旁路结果）
    openDocumentMock.mockResolvedValue('focused');

    const result = await loadRestoredTab(KEY_A);
    // 懒标记保留（正文仍未交付，不能把占位当已加载）
    expect(result).toBe('stale');
    expect(useWindowStore.getState().getTab(KEY_A)?.lazySource).toBe(KEY_A);
  });

  it('恢复期间不抢焦点：用户交互的 activeKey 不被恢复流程覆盖', async () => {
    // 预置用户已激活的一个标签（模拟恢复完成前用户交互）
    const userTab: import('@/stores/windowStore').Tab = {
      key: 'C:\\t\\user.md',
      displayName: 'user.md',
      path: 'C:\\t\\user.md',
      kind: 'markdown',
      language: 'markdown',
      isDirty: false,
      isPreview: false,
      viewMode: null,
      externalStatus: null,
      isDetached: false,
    };
    useWindowStore.setState({ tabs: [userTab], activeKey: 'C:\\t\\user.md' });

    vi.mocked(ipc.loadSession).mockResolvedValue(
      snapshotWith([{ key: KEY_A, sourcePath: KEY_A }]) as never,
    );
    vi.mocked(ipc.pathExists).mockResolvedValue({ exists: true, isDir: false });

    await restoreLastClosedWindow();
    // 用户激活的标签保持焦点
    expect(useWindowStore.getState().activeKey).toBe('C:\\t\\user.md');
    expect(useWindowStore.getState().tabs).toHaveLength(2);
  });

  it('缺失文件跳过；命名文件带暂存副本恢复为干净（暂存保留暂存区），未命名 staged 恢复进入关闭保护', async () => {
    vi.mocked(ipc.loadSession).mockResolvedValue(
      snapshotWith([
        { key: KEY_MISSING, sourcePath: KEY_MISSING },
        { key: KEY_A, sourcePath: KEY_A, stagedPath: 'C:\\staging\\a.md' },
        { key: 'untitled:md-9', sourcePath: null, stagedPath: 'C:\\staging\\untitled-9.md' },
      ]) as never,
    );
    vi.mocked(ipc.pathExists).mockImplementation(async (path: string) => ({
      exists: path === KEY_A || path === 'C:\\staging\\untitled-9.md',
      isDir: false,
    }));

    const restored = await restoreLastClosedWindow();
    expect(restored).toBe(true);

    const store = useWindowStore.getState();
    expect(store.tabs).toHaveLength(2);
    const named = store.tabs.find((t) => t.key === KEY_A)!;
    const unnamed = store.tabs.find((t) => t.key === 'C:\\staging\\untitled-9.md')!;
    // 🔴 R01：命名文件按原路径恢复（磁盘为权威基线）→ 干净；暂存副本保留在暂存区（lazyStagedPath 引用）
    expect(named.isDirty).toBe(false);
    expect(named.lazyStagedPath).toBe('C:\\staging\\a.md');
    // 未命名标签以暂存路径为打开来源 → 有未保存工作（关闭保护）
    expect(unnamed.isDirty).toBe(true);
    expect(unnamed.lazyStagedPath).toBe('C:\\staging\\untitled-9.md');
    // 正文未知用 null（不得用空字符串进入写入链）
    expect(useDocumentStore.getState().getDocument(KEY_A)?.content).toBeNull();
    expect(useDocumentStore.getState().getDocument('C:\\staging\\untitled-9.md')?.content).toBeNull();
  });

  it('恢复失败（openDocument failed）保留懒标签可重试', async () => {
    useWindowStore.setState({
      tabs: [{
        key: KEY_A,
        displayName: 'a.md',
        path: KEY_A,
        kind: 'markdown',
        language: 'markdown',
        isDirty: false,
        isPreview: false,
        viewMode: null,
        externalStatus: null,
        isDetached: false,
        lazySource: KEY_A,
        lazyStagedPath: null,
      }],
      activeKey: KEY_A,
    });
    openDocumentMock.mockResolvedValue('failed');

    await loadRestoredTab(KEY_A);
    // 懒标记保留（可重试）
    expect(useWindowStore.getState().getTab(KEY_A)?.lazySource).toBe(KEY_A);
  });
});
