// NoteBoard 🔴 N09 外部正文修改核对链测试
// 覆盖：watcher 事件 → 受影响已打开文档的有界核对（等长替换检出、去抖合并、
//       自身写静默延迟复核、冲突状态阻止自动覆盖、文件树同步刷新）。

import { describe, it, expect, beforeEach, vi } from 'vitest';

// 捕获 watcher 回调（模拟 plugin-fs watchImmediate）
let watchHandler: ((event: { type: string; paths: string[]; attrs?: unknown }) => void) | null = null;
vi.mock('@tauri-apps/plugin-fs', () => ({
  watchImmediate: vi.fn(async (_dir: string, cb: (event: unknown) => void) => {
    watchHandler = cb as typeof watchHandler;
    return () => {
      watchHandler = null;
    };
  }),
}));

// IPC 替身：readDocument 可编程（外部修改核对的读盘源）
const readDirMock = vi.fn().mockResolvedValue([]);
const readDocumentMock = vi.fn();
const pathExistsMock = vi.fn();
vi.mock('@/core/ipc/commands', () => ({
  readDir: (...args: unknown[]) => readDirMock(...args),
  readDocument: (...args: unknown[]) => readDocumentMock(...args),
  pathExists: (...args: unknown[]) => pathExistsMock(...args),
}));

import { watchDirectory } from '@/features/explorer/directoryWatcher';
import { noteSelfWrite } from '@/features/explorer/directoryWatcher';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { useExplorerStore } from '@/features/explorer/explorerStore';
import { queuedAutoSave } from '@/features/session/documentSession';
import { getBaseline } from '@/features/editor-md/serialize';
import { resetEditorRegistryForTest } from '@/core/editor/editorRegistry';

const DIR = 'C:\\t\\docs';
const KEY = 'C:\\t\\docs\\note.md';

/** 建立已打开（已加载）文档会话 */
function seedOpenDocument(content: string, baseline: string): void {
  useDocumentStore.getState().upsertFromPayload({
    key: KEY,
    displayName: 'note.md',
    dirPath: DIR,
    kind: 'markdown',
    language: 'markdown',
    content,
    encoding: 'utf8',
    eol: 'lf',
    size: content.length,
    mtime: 1,
    readonly: false,
  });
  useDocumentStore.getState().updateBaseline(KEY, baseline, 1, baseline.length);
  getBaseline(KEY).updateBaseline(baseline);
  useWindowStore.getState().openTab({
    key: KEY,
    displayName: 'note.md',
    path: KEY,
    kind: 'markdown',
    language: 'markdown',
    isDirty: false,
    isPreview: false,
    viewMode: 'visual',
    externalStatus: null,
    isDetached: false,
  });
}

describe('🔴 N09 外部正文修改核对链', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    watchHandler = null;
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
    useExplorerStore.setState({ root: null, children: new Map() });
    resetEditorRegistryForTest();
  });

  it('外部修改同名文件（含等长替换）→ 核对后置 modified，自动保存被阻止', async () => {
    // 用户已打开：正文与基线一致（干净）
    seedOpenDocument('hello world', 'hello world');
    const release = watchDirectory(DIR);
    await vi.advanceTimersByTimeAsync(10);

    // 外部软件做等长替换（mtime/size 不变也必须检出——内容与基线逐字比较）
    readDocumentMock.mockResolvedValue({
      key: KEY, displayName: 'note.md', dirPath: DIR, kind: 'markdown',
      language: 'markdown', content: 'HELLO WORLD', encoding: 'utf8', eol: 'lf',
      size: 11, mtime: 2, readonly: false,
    });
    watchHandler?.({ type: 'write', paths: [KEY] });

    // 去抖窗口（600ms）内合并；推进后执行核对
    await vi.advanceTimersByTimeAsync(700);

    expect(readDocumentMock).toHaveBeenCalledWith(KEY);
    expect(useDocumentStore.getState().getDocument(KEY)?.externalStatus).toBe('modified');
    expect(useWindowStore.getState().getTab(KEY)?.externalStatus).toBe('modified');
    // 文件树同步刷新（watcher 直连 readDir + updateChildren）
    expect(readDirMock).toHaveBeenCalled();

    // 🔴 冲突保护：modified 状态下旧自动保存不得写盘（不覆盖外部修改）
    await queuedAutoSave(KEY, 'hello world');
    await vi.advanceTimersByTimeAsync(50);
    expect(readDocumentMock.mock.calls.length).toBe(1); // 无额外写盘链路触发

    release();
  });

  it('外部写回与基线一致的内容 → 恢复 clean（不误报冲突）', async () => {
    seedOpenDocument('hello world', 'hello world');
    const release = watchDirectory(DIR);
    await vi.advanceTimersByTimeAsync(10);

    readDocumentMock.mockResolvedValue({
      key: KEY, displayName: 'note.md', dirPath: DIR, kind: 'markdown',
      language: 'markdown', content: 'hello world', encoding: 'utf8', eol: 'lf',
      size: 11, mtime: 2, readonly: false,
    });
    watchHandler?.({ type: 'write', paths: [KEY] });
    await vi.advanceTimersByTimeAsync(700);

    expect(useDocumentStore.getState().getDocument(KEY)?.externalStatus).toBe('clean');
    release();
  });

  it('事件风暴去抖合并：多事件一次读取（不逐事件读盘）', async () => {
    seedOpenDocument('a', 'a');
    const release = watchDirectory(DIR);
    await vi.advanceTimersByTimeAsync(10);

    readDocumentMock.mockResolvedValue({
      key: KEY, displayName: 'note.md', dirPath: DIR, kind: 'markdown',
      language: 'markdown', content: 'a', encoding: 'utf8', eol: 'lf',
      size: 1, mtime: 2, readonly: false,
    });
    // 同一文件风暴式 10 个事件
    for (let i = 0; i < 10; i++) {
      watchHandler?.({ type: 'write', paths: [KEY] });
    }
    await vi.advanceTimersByTimeAsync(700);

    // 🔴 去抖合并：600ms 窗口内多事件只有一次 readDocument
    expect(readDocumentMock).toHaveBeenCalledTimes(1);
    release();
  });

  it('自身写入静默窗口内的事件延迟复核：外部紧随修改不被吞', async () => {
    seedOpenDocument('draft', 'draft');
    const release = watchDirectory(DIR);
    await vi.advanceTimersByTimeAsync(10);

    // 自身写盘（登记静默）→ watcher 事件命中静默窗口
    noteSelfWrite(KEY);
    watchHandler?.({ type: 'write', paths: [KEY] });
    await vi.advanceTimersByTimeAsync(700);
    // 静默窗口（1500ms）内：尚未核对
    expect(readDocumentMock).not.toHaveBeenCalled();

    // 静默窗口结束后复核——此时读到的内容与基线不同（外部软件在保存后 100ms 改写）
    readDocumentMock.mockResolvedValue({
      key: KEY, displayName: 'note.md', dirPath: DIR, kind: 'markdown',
      language: 'markdown', content: 'externally-edited', encoding: 'utf8', eol: 'lf',
      size: 17, mtime: 3, readonly: false,
    });
    await vi.advanceTimersByTimeAsync(1000);

    // 🔴 复核检出外部修改（不吞）——等长与否无关，内容逐字比较
    expect(readDocumentMock).toHaveBeenCalledWith(KEY);
    expect(useDocumentStore.getState().getDocument(KEY)?.externalStatus).toBe('modified');
    release();
  });

  it('文件被外部删除 → 核对读取失败且确认不存在后置 deleted', async () => {
    seedOpenDocument('gone', 'gone');
    const release = watchDirectory(DIR);
    await vi.advanceTimersByTimeAsync(10);

    // readDocument 失败 + pathExists 确认已删除
    readDocumentMock.mockRejectedValue(new Error('not found'));
    pathExistsMock.mockResolvedValue({ exists: false, isDir: false });
    watchHandler?.({ type: 'remove', paths: [KEY] });
    await vi.advanceTimersByTimeAsync(700);

    expect(useDocumentStore.getState().getDocument(KEY)?.externalStatus).toBe('deleted');
    expect(useWindowStore.getState().getTab(KEY)?.externalStatus).toBe('deleted');
    release();
  });
});
