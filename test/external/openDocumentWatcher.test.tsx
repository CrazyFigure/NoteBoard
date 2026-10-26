// 应用级监听在无资源管理器和 POSIX 平台下也生效，按目录共享并正确释放。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchImmediate } from '@tauri-apps/plugin-fs';
import * as ipc from '@/core/ipc/commands';
import { useExternalFileChanges } from '@/features/external/useExternalFileChanges';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';

vi.mock('@/core/platform', () => ({ USES_WINDOWS_PATHS: false }));
vi.mock('@tauri-apps/plugin-fs', () => ({ watchImmediate: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({ readDocument: vi.fn(), readDir: vi.fn(), pathExists: vi.fn() }));

/** 用 POSIX 路径覆盖 Linux、macOS、移动端及网页工作区的路径语义。 */
function seed(key: string) {
  const payload = { key, displayName: key.split('/').at(-1)!, dirPath: key.slice(0, key.lastIndexOf('/')), kind: 'code' as const,
    language: 'plaintext' as const, content: 'base', encoding: 'utf8' as const, eol: 'lf' as const, mtime: 1, size: 4, readonly: false };
  useDocumentStore.getState().upsertFromPayload(payload);
  useWindowStore.getState().openTab({ key, path: key, displayName: payload.displayName, kind: 'code', language: 'plaintext',
    isDirty: false, isPreview: false, viewMode: null, externalStatus: null, isDetached: false });
  return payload;
}
function Observer() { useExternalFileChanges(); return null; }

describe('已打开文档的独立目录监听', () => {
  let root: Root;
  let host: HTMLDivElement;
  const unwatch = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.mocked(watchImmediate).mockResolvedValue(unwatch);
    vi.mocked(ipc.readDir).mockResolvedValue([]);
    useDocumentStore.setState({ documents: new Map() });
    useWindowStore.setState({ tabs: [], activeKey: null });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const advance = () => act(async () => { await vi.advanceTimersByTimeAsync(700); });

  it('没有资源管理器也监听文件父目录，检测外部改动', async () => {
    const payload = seed('/workspace/deep/note.txt');
    vi.mocked(ipc.readDocument).mockResolvedValue({ ...payload, content: 'disk' });
    act(() => root.render(<Observer />));
    await advance();
    expect(watchImmediate).toHaveBeenCalledWith('/workspace/deep', expect.any(Function));
    expect(useDocumentStore.getState().getDocument(payload.key)?.externalStatus).toBe('modified');
  });

  it('同目录多个文件共用一个监听，卸载时释放；POSIX 大小写不同的目录分别监听', async () => {
    seed('/workspace/A/one.txt');
    seed('/workspace/A/two.txt');
    seed('/workspace/a/three.txt');
    vi.mocked(ipc.readDocument).mockImplementation(async (key) => ({ ...seedPayload(key), content: 'base' }));
    act(() => root.render(<Observer />));
    await advance();
    expect(watchImmediate).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    expect(unwatch).toHaveBeenCalledTimes(2);
  });

  it('恢复前台补查，隐藏期间不触发周期读取', async () => {
    const payload = seed('/workspace/note.txt');
    vi.mocked(ipc.readDocument).mockResolvedValue(payload);
    act(() => root.render(<Observer />));
    await advance();
    vi.mocked(ipc.readDocument).mockClear();
    vi.mocked(ipc.readDocument).mockResolvedValue({ ...payload, content: 'disk' });
    await act(async () => window.dispatchEvent(new Event('focus')));
    await advance();
    expect(useDocumentStore.getState().getDocument(payload.key)?.externalStatus).toBe('modified');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    vi.mocked(ipc.readDocument).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(ipc.readDocument).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

/** 只构造读盘结果，不通过 seed 改动正在被订阅的 store。 */
function seedPayload(key: string) {
  return { key, displayName: key.split('/').at(-1)!, dirPath: '/workspace', kind: 'code' as const, language: 'plaintext' as const,
    content: 'base', encoding: 'utf8' as const, eol: 'lf' as const, mtime: 1, size: 4, readonly: false };
}
