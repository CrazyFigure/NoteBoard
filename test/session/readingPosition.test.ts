// 阅读位置独立于文档正文与标签会话，覆盖持久化、关闭开关、损坏数据和多窗口合并。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushReadingPositions, readReadingPosition, resetReadingPositionsForTest, saveReadingPosition,
} from '@/features/reading/readingPosition';
import { setWebAccount } from '@/features/account/accountState';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { markClosed, resetSuspensionForTest, saveViewState, takeReadingViewState, takeViewState } from '@/features/session/editorSuspension';
import { resetEditorRegistryForTest } from '@/core/editor/editorRegistry';

const KEY = 'C:/notes/readme.md';
const POSITION = { kind: 'markdown', mode: 'visual', selection: { anchor: 900, head: 900 }, scrollTop: 460 };
let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
  resetReadingPositionsForTest(); resetSuspensionForTest(); resetEditorRegistryForTest();
  setWebAccount(null);
});
afterEach(() => { resetReadingPositionsForTest(); setWebAccount(null); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('重新打开时恢复阅读位置', () => {
  it('默认开启；关闭后释放会话快照但保留独立阅读记录，重启也能恢复', () => {
    expect(DEFAULT_SETTINGS.file.restoreReadingPosition).toBe(true);
    saveReadingPosition(KEY, POSITION);
    saveViewState(KEY, POSITION);
    markClosed(KEY);
    expect(takeViewState(KEY)).toBeNull();
    resetReadingPositionsForTest(); // 模拟进程内队列已清空，只能从持久存储读取。
    expect(readReadingPosition(KEY)).toEqual(POSITION);
    expect(takeReadingViewState(KEY)).toEqual(POSITION);
    expect(takeReadingViewState(KEY)).toBeNull();
  });

  it('旧配置缺少开关时默认启用；关闭开关后不读取或覆盖位置，标签内恢复仍保留', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    delete settings.file.restoreReadingPosition;
    useSettingsStore.setState({ settings });
    saveReadingPosition(KEY, POSITION); flushReadingPositions();
    expect(readReadingPosition(KEY)).toEqual(POSITION);
    useSettingsStore.setState({ settings: { ...settings, file: { ...settings.file, restoreReadingPosition: false } } });
    expect(readReadingPosition(KEY)).toBeNull();
    saveReadingPosition(KEY, { ...POSITION, scrollTop: 0 }); flushReadingPositions();
    expect([...storage.values()][0]).toContain('460');
    saveViewState(KEY, POSITION);
    expect(takeReadingViewState(KEY)).toEqual(POSITION);
  });

  it('回收/迁移的最新状态优先于旧阅读记录，模式切换不重复消费旧记录', () => {
    saveReadingPosition(KEY, POSITION);
    saveViewState(KEY, { ...POSITION, scrollTop: 730 });
    expect(takeReadingViewState(KEY)).toMatchObject({ scrollTop: 730 });
    expect(takeReadingViewState(KEY)).toBeNull();
  });

  it('阅读回到开头也会覆盖旧记录；未命名文档和画板不进入文件位置缓存', () => {
    saveReadingPosition(KEY, POSITION);
    saveReadingPosition(KEY, { ...POSITION, scrollTop: 0 });
    saveReadingPosition('untitled:markdown-1', POSITION);
    saveReadingPosition('C:/notes/a.board', { kind: 'board', viewport: {} });
    flushReadingPositions();
    expect(readReadingPosition(KEY)?.scrollTop).toBe(0);
    expect(readReadingPosition('untitled:markdown-1')).toBeNull();
    expect(readReadingPosition('C:/notes/a.board')).toBeNull();
  });

  it('持续滚动合并写入，跨窗口写入的其他文件记录不会被覆盖，缓存数量有上限', () => {
    vi.useFakeTimers();
    for (let index = 0; index < 201; index++) saveReadingPosition(`C:/notes/${index}.md`, POSITION);
    expect(storage.size).toBe(0);
    vi.advanceTimersByTime(300);
    const [key, value] = [...storage.entries()][0];
    expect(JSON.parse(value)).toHaveLength(200);
    expect(readReadingPosition('C:/notes/0.md')).toBeNull();
    // 模拟另一窗口先把自己的记录写入同一存储。
    storage.set(key, JSON.stringify([{ key: 'other.md', state: POSITION, updatedAt: Date.now() + 1 }]));
    saveReadingPosition(KEY, POSITION); flushReadingPositions();
    expect(readReadingPosition('other.md')).toEqual(POSITION);
    expect(readReadingPosition(KEY)).toEqual(POSITION);
  });

  it('不同网页账号的同一路径分别保存位置', () => {
    setWebAccount({ username: 'alice', role: 'user' });
    saveReadingPosition('/workspace/a.md', POSITION); flushReadingPositions();
    setWebAccount({ username: 'bob', role: 'user' });
    expect(readReadingPosition('/workspace/a.md')).toBeNull();
    saveReadingPosition('/workspace/a.md', { ...POSITION, scrollTop: 900 }); flushReadingPositions();
    setWebAccount({ username: 'alice', role: 'user' });
    expect(readReadingPosition('/workspace/a.md')?.scrollTop).toBe(460);
  });

  it('损坏缓存、非法坐标及存储不可用不会阻断文档操作', () => {
    storage.set('nb-reading-positions:v1:', '{invalid');
    expect(readReadingPosition(KEY)).toBeNull();
    saveReadingPosition(KEY, { ...POSITION, scrollTop: Number.NaN });
    expect(readReadingPosition(KEY)).toBeNull();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } });
    expect(() => { saveReadingPosition(KEY, POSITION); flushReadingPositions(); }).not.toThrow();
    expect(readReadingPosition(KEY)).toEqual(POSITION);
  });
});
