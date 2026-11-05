// 弹窗的键盘、重复操作与取消行为同时适用于桌面、移动外壳。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { ExternalChangeDialog } from '@/features/external/ExternalChangeDialog';
import { reloadFromDisk } from '@/features/external/externalChangeActions';
import { saveAs } from '@/features/editor-code/orchestration/saveDocument';

vi.mock('@/features/external/useExternalFileChanges', () => ({ useExternalFileChanges: vi.fn() }));
vi.mock('@/features/external/externalChangeActions', () => ({ reloadFromDisk: vi.fn() }));
vi.mock('@/features/editor-code/orchestration/saveDocument', () => ({ saveAs: vi.fn() }));
const KEY = 'C:\\notes\\a.json';

describe('磁盘修改弹窗', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.resetAllMocks();
    useWindowStore.setState({ tabs: [], activeKey: null });
    useDocumentStore.setState({ documents: new Map() });
    useDocumentStore.getState().upsertFromPayload({ key: KEY, displayName: 'a.json', dirPath: 'C:\\notes', kind: 'code',
      language: 'json', content: '{}', encoding: 'utf8', eol: 'lf', mtime: 1, size: 2, readonly: false });
    useDocumentStore.getState().setExternalStatus(KEY, 'modified');
    useWindowStore.getState().openTab({ key: KEY, path: KEY, displayName: 'a.json', kind: 'code', language: 'json',
      isDirty: false, isPreview: false, viewMode: null, externalStatus: 'modified', isDetached: false });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<ExternalChangeDialog />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  const button = (label: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === label)!;

  it('代码文件同样显示提示，默认聚焦另存，干净文档不谎报未保存修改', () => {
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('a.json');
    expect(document.body.textContent).not.toContain('当前有未保存的修改');
    expect(document.activeElement).toBe(button('另存为'));
  });
  it('脏文档显示重载会替换编辑内容的说明', () => {
    act(() => useDocumentStore.getState().setDirty(KEY, true));
    expect(document.body.textContent).toContain('当前有未保存的修改');
  });
  it('重载失败保留提示并支持重试，快速双击只调用一次', async () => {
    vi.mocked(reloadFromDisk).mockResolvedValue(false);
    await act(async () => { button('重新加载').click(); button('重新加载').click(); });
    expect(reloadFromDisk).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('未能重新加载');
    await act(async () => button('重新加载').click());
    expect(reloadFromDisk).toHaveBeenCalledTimes(2);
  });
  it('另存选择器期间让出模态层，取消后重新显示冲突', async () => {
    let finish!: (ok: boolean) => void;
    vi.mocked(saveAs).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    act(() => button('另存为').click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => finish(false));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(useDocumentStore.getState().getDocument(KEY)?.externalStatus).toBe('modified');
  });
  it('Escape 不替用户选择重载，冲突解决后自动关闭', async () => {
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(reloadFromDisk).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => useDocumentStore.getState().setExternalStatus(KEY, 'clean'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
