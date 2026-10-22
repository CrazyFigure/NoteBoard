// 通用沉浸阅读：支持的格式、只作用于活动文档、全屏请求串行化
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setFullscreen = vi.fn(async (_enabled: boolean) => {});
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main', setFullscreen }) }));

import { isDocumentReading, requestReadingMode, supportsReadingMode } from '../../src/features/reading/readingMode';
import { useLayoutStore } from '../../src/stores/layoutStore';
import { useWindowStore } from '../../src/stores/windowStore';

beforeEach(() => {
  requestReadingMode(false);
  setFullscreen.mockClear();
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

  it('快速连点只执行最终的全屏状态', async () => {
    requestReadingMode(true);
    requestReadingMode(false);
    requestReadingMode(true);
    await vi.waitFor(() => expect(setFullscreen).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setFullscreen.mock.calls.at(-1)?.[0]).toBe(true);
    expect(useLayoutStore.getState().readingMode).toBe(true);
  });
});
