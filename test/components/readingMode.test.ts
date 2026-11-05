// 通用沉浸阅读：支持的格式、只作用于活动文档、窗口大小进入、阅读内全屏切换与退出还原
import { beforeEach, describe, expect, it, vi } from 'vitest';

let nativeFullscreen = false;
const setFullscreen = vi.fn(async (enabled: boolean) => { nativeFullscreen = enabled; });
const isFullscreen = vi.fn(async () => nativeFullscreen);
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main', setFullscreen, isFullscreen }) }));

import { isDocumentReading, requestReadingMode, supportsReadingMode, toggleReadingFullscreen } from '../../src/features/reading/readingMode';
import { useLayoutStore } from '../../src/stores/layoutStore';
import { useWindowStore } from '../../src/stores/windowStore';

/** 等待已排队的全屏操作执行完 */
const flushOperations = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  requestReadingMode(false);
  await flushOperations();
  nativeFullscreen = false;
  setFullscreen.mockClear();
  isFullscreen.mockClear();
});

describe('沉浸阅读', () => {
  it('除画板、文本对比、待加载标签与不支持类型外均提供入口', () => {
    for (const kind of ['markdown', 'code', 'image', 'mindmap', 'drawio', 'bitable', 'preview'] as const) {
      expect(supportsReadingMode({ kind })).toBe(true);
    }
    expect(supportsReadingMode({ kind: 'board' })).toBe(false);
    expect(supportsReadingMode({ kind: 'unsupported' })).toBe(false);
    expect(supportsReadingMode({ kind: 'code', toolKind: 'textdiff' })).toBe(false);
    expect(supportsReadingMode({ kind: 'markdown', lazySource: 'a.md' })).toBe(false);
    expect(supportsReadingMode(null)).toBe(false);
  });

  it('只有活动文档处于阅读状态', () => {
    useWindowStore.setState({ activeKey: 'a.md' });
    requestReadingMode(true);
    expect(useLayoutStore.getState().readingMode).toBe(true);
    expect(isDocumentReading('a.md')).toBe(true);
    expect(isDocumentReading('b.pdf')).toBe(false);
  });

  it('进入与退出阅读都保持当前窗口大小', async () => {
    requestReadingMode(true);
    await flushOperations();
    requestReadingMode(false);
    await flushOperations();
    expect(setFullscreen).not.toHaveBeenCalled();
    expect(useLayoutStore.getState().readingMode).toBe(false);
  });

  it('全屏按钮在全屏与窗口之间切换', async () => {
    requestReadingMode(true);
    await toggleReadingFullscreen();
    expect(setFullscreen).toHaveBeenLastCalledWith(true);
    await toggleReadingFullscreen();
    expect(setFullscreen).toHaveBeenLastCalledWith(false);
    expect(useLayoutStore.getState().readingMode).toBe(true);
  });

  it('退出阅读时撤销阅读内打开的全屏', async () => {
    requestReadingMode(true);
    await toggleReadingFullscreen();
    requestReadingMode(false);
    await flushOperations();
    expect(setFullscreen.mock.calls.map(([value]) => value)).toEqual([true, false]);
    expect(nativeFullscreen).toBe(false);
  });

  it('退出阅读不影响进入前已有的全屏', async () => {
    nativeFullscreen = true;
    requestReadingMode(true);
    requestReadingMode(false);
    await flushOperations();
    expect(setFullscreen).not.toHaveBeenCalled();
    expect(nativeFullscreen).toBe(true);
  });

  it('快速退出又进入时保留阅读内打开的全屏', async () => {
    requestReadingMode(true);
    await toggleReadingFullscreen();
    requestReadingMode(false);
    requestReadingMode(true);
    await flushOperations();
    expect(setFullscreen.mock.calls.map(([value]) => value)).toEqual([true]);
    expect(useLayoutStore.getState().readingMode).toBe(true);
  });

  it('未处于阅读时全屏请求被丢弃', async () => {
    await toggleReadingFullscreen();
    expect(setFullscreen).not.toHaveBeenCalled();
  });

  it('全屏失败时留在阅读并提示', async () => {
    setFullscreen.mockRejectedValueOnce(new Error('denied'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    requestReadingMode(true);
    await toggleReadingFullscreen();
    expect(useLayoutStore.getState().readingMode).toBe(true);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
