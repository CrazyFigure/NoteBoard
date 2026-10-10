// 多端同步落地处理测试：同步改动本机文件后，已打开文档与标签必须按规则跟随（删除/改名/移入回收站），
// 以及同步提示分组只保留最新一条。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/ipc/commands', () => ({
  readDir: vi.fn(async () => []),
  pathExists: vi.fn(async () => ({ exists: false, isDir: false })),
}));

import { applySyncChanges } from '../../src/features/sync/syncEffects';
import { checkOpenDocumentStillExists, isRecreateOnSaveAllowed } from '../../src/features/external/missingFileGuard';
import { useDocumentStore } from '../../src/stores/documentStore';
import { useSyncStore } from '../../src/stores/syncStore';
import { showToast, useToastStore } from '../../src/stores/toastStore';
import { useWindowStore, type Tab } from '../../src/stores/windowStore';
import type { SyncConfigFile } from '../../src/core/ipc/types';

const SEP = '\\';
const ROOT = ['C:', 'Notes'].join(SEP);
const at = (...parts: string[]) => [ROOT, ...parts].join(SEP);
const nameOf = (key: string) => key.split(SEP).pop() ?? key;

function openDoc(key: string, dirty: boolean): void {
  useDocumentStore.getState().upsertFromPayload({
    key,
    displayName: nameOf(key),
    dirPath: ROOT,
    kind: 'markdown',
    language: 'markdown',
    content: '# doc',
    encoding: 'utf8',
    eol: 'lf',
    size: 5,
    mtime: 1,
    readonly: false,
  });
  if (dirty) useDocumentStore.getState().setDirty(key, true);
  const tab: Tab = {
    key,
    displayName: nameOf(key),
    path: key,
    kind: 'markdown',
    language: 'markdown',
    isDirty: dirty,
    isPreview: false,
    viewMode: 'visual',
    externalStatus: null,
    isDetached: false,
  };
  useWindowStore.getState().openTab(tab);
}

describe('applySyncChanges', () => {
  beforeEach(() => {
    useDocumentStore.setState({ documents: new Map() });
    useWindowStore.setState({ tabs: [], activeKey: null, pendingCloseKeys: [], isWindowClosing: false });
    useToastStore.setState({ toasts: [] });
    useSyncStore.setState({
      config: { sync: { rootDir: ROOT, enabled: true, trashEnabled: true } } as unknown as SyncConfigFile,
    });
  });

  it('未修改的文档被其他设备删除：进入「文件已被删除」流程', async () => {
    const key = at('clean.md');
    openDoc(key, false);
    await applySyncChanges([{ kind: 'deleted', path: key }]);
    expect(useWindowStore.getState().getTab(key)?.isDetached).toBe(true);
    expect(useDocumentStore.getState().getDocument(key)?.externalStatus).toBe('deleted');
  });

  it('有未保存修改的文档被其他设备删除：保持可编辑，保存时作为新文件重建', async () => {
    const key = at('dirty.md');
    openDoc(key, true);
    await applySyncChanges([{ kind: 'deleted', path: key }]);
    expect(useWindowStore.getState().getTab(key)?.isDetached).toBe(false);
    expect(isRecreateOnSaveAllowed(key)).toBe(true);
    // 窗口聚焦等时机的存在性检查不得再把它标记为已删除
    expect(await checkOpenDocumentStillExists(key, true)).toBe(true);
    expect(useWindowStore.getState().getTab(key)?.isDetached).toBe(false);
    expect(useToastStore.getState().toasts.some((t) => t.message.includes('重新创建'))).toBe(true);
  });

  it('被移入同步回收站等同删除，不会把标签迁移到回收站路径', async () => {
    const key = at('a.md');
    openDoc(key, false);
    await applySyncChanges([{ kind: 'moved', from: key, path: at('.nb-trash', 'a.md') }]);
    expect(useWindowStore.getState().getTab(key)?.isDetached).toBe(true);
    expect(useWindowStore.getState().tabs.some((t) => t.path?.includes('.nb-trash'))).toBe(false);
  });

  it('被其他设备改名：标签与文档路径跟随迁移', async () => {
    const key = at('old.md');
    const next = at('子目录', 'new.md');
    openDoc(key, false);
    await applySyncChanges([{ kind: 'moved', from: key, path: next }]);
    expect(useDocumentStore.getState().getDocument(next)).toBeTruthy();
    expect(useWindowStore.getState().tabs.find((t) => t.path === next)?.displayName).toBe('new.md');
  });
});

describe('toast 分组', () => {
  beforeEach(() => useToastStore.setState({ toasts: [] }));

  it('同一分组只保留最新一条，其他提示不受影响', () => {
    showToast('普通提示', 'info', 0);
    showToast('同步完成 · 本机→云端：修改 1', 'success', 0, 'sync');
    showToast('同步失败：网络异常', 'error', 0, 'sync');
    const messages = useToastStore.getState().toasts.map((t) => t.message);
    expect(messages).toEqual(['普通提示', '同步失败：网络异常']);
  });
});
