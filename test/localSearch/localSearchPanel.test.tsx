// 本地文件搜索面板：开启引导、查询与结果展示、键盘操作、过期结果丢弃

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalSearchContentResult, LocalSearchNameResult } from '../../src/core/ipc/types';

// 打开结果与索引更新事件不涉及原生能力，替换为记录调用
const opened = vi.hoisted(() => ({ open: [] as unknown[][], reveal: [] as string[] }));
vi.mock('../../src/features/localSearch/openResult', () => ({
  openSearchResult: (...args: unknown[]) => {
    opened.open.push(args);
    return Promise.resolve();
  },
  revealSearchResult: (path: string) => opened.reveal.push(path),
}));
vi.mock('../../src/core/ipc/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/ipc/events')>()),
  onLocalSearchUpdated: () => Promise.resolve(() => {}),
}));

import * as ipc from '../../src/core/ipc/commands';
import { LocalSearchPanel } from '../../src/features/localSearch/LocalSearchPanel';
import { useLocalSearchStore } from '../../src/features/localSearch/localSearchStore';
import { TooltipProvider } from '../../src/components/Tooltip';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../src/stores/settingsStore';
import { useLayoutStore } from '../../src/stores/layoutStore';

const NAMES: LocalSearchNameResult = {
  total: 1,
  hits: [{ path: 'C:\\Notes\\会议纪要.md', name: '会议纪要.md', nameParts: [{ text: '会议', hit: true }, { text: '纪要.md', hit: false }], dir: 'C:\\Notes', isDir: false, size: 120, mtime: Date.now() - 60_000 }],
};
const CONTENTS: LocalSearchContentResult = {
  truncated: false,
  hits: [{
    path: 'C:\\Notes\\周报.md', name: '周报.md', dir: 'C:\\Notes', size: 80, mtime: Date.now() - 3_600_000, matches: 2,
    snippets: [{ line: 3, parts: [{ text: '本周', hit: false }, { text: '会议', hit: true }, { text: '安排', hit: false }] }],
  }],
};

let host: HTMLDivElement;
let root: Root;

/** 等待防抖与异步结果 */
async function flush(ms = 150) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function input(): HTMLTextAreaElement {
  return host.querySelector('.nb-ls-input') as HTMLTextAreaElement;
}

/** 以 React 能感知的方式修改输入框 */
function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

function render() {
  act(() => root.render(<TooltipProvider><LocalSearchPanel /></TooltipProvider>));
}

describe('本地文件搜索面板', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // jsdom 没有布局，虚拟列表按元素尺寸决定渲染哪些行：给列表一个固定可视区域
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(760);
    opened.open = [];
    opened.reveal = [];
    useLocalSearchStore.setState({ open: true, query: '' });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, localSearch: { enabled: true, roots: ['C:\\Notes'] } } });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('未开启时提示并可前往设置', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    render();
    expect(host.textContent).toContain('本地文件搜索未开启');
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('前往设置'))!;
    act(() => button.click());
    expect(useLocalSearchStore.getState().open).toBe(false);
    expect(useLayoutStore.getState().settingsModalVisible).toBe(true);
    expect(useLayoutStore.getState().settingsTarget).toBe('localSearch');
    act(() => useLayoutStore.getState().setSettingsModalVisible(false));
  });

  it('输入后展示文件名与内容结果，键盘选择并打开', async () => {
    const names = vi.spyOn(ipc, 'localSearchNames').mockResolvedValue(NAMES);
    const contents = vi.spyOn(ipc, 'localSearchContent').mockResolvedValue(CONTENTS);
    render();
    type('会议');
    await flush();
    expect(names).toHaveBeenCalledWith('会议', expect.any(Number), 200);
    expect(contents).toHaveBeenCalled();
    const titles = [...host.querySelectorAll('.nb-ls-row-title')].map((n) => n.textContent);
    expect(titles).toEqual(['会议纪要.md', '周报.md']);
    expect(host.querySelector('mark')?.textContent).toBe('会议');
    expect(host.querySelector('.nb-ls-snippet-line')?.textContent).toBe('3');

    // 默认选中第一条；↓ 移到内容结果后回车，打开并带上命中文字用于定位
    press('ArrowDown');
    press('Enter');
    expect(opened.open).toEqual([['C:\\Notes\\周报.md', false, '会议']]);
    expect(useLocalSearchStore.getState().open).toBe(false);
  });

  it('Ctrl + Enter 打开所在文件夹，Shift + Enter 不打开', async () => {
    vi.spyOn(ipc, 'localSearchNames').mockResolvedValue(NAMES);
    vi.spyOn(ipc, 'localSearchContent').mockResolvedValue(CONTENTS);
    render();
    type('会议');
    await flush();
    press('Enter', { shiftKey: true });
    expect(opened.open).toEqual([]);
    press('Enter', { ctrlKey: true });
    expect(opened.reveal).toEqual(['C:\\Notes\\会议纪要.md']);
  });

  it('Tab 切换分组', async () => {
    vi.spyOn(ipc, 'localSearchNames').mockResolvedValue(NAMES);
    vi.spyOn(ipc, 'localSearchContent').mockResolvedValue(CONTENTS);
    render();
    type('会议');
    await flush();
    press('Tab');
    expect([...host.querySelectorAll('.nb-ls-row-title')].map((n) => n.textContent)).toEqual(['会议纪要.md']);
    press('Tab');
    expect([...host.querySelectorAll('.nb-ls-row-title')].map((n) => n.textContent)).toEqual(['周报.md']);
  });

  it('被新查询取代的旧结果不会显示', async () => {
    let resolveOld: (r: LocalSearchNameResult) => void = () => {};
    const stale: LocalSearchNameResult = { total: 1, hits: [{ ...NAMES.hits[0], path: 'C:\\old.md', name: 'old.md', nameParts: [{ text: 'old.md', hit: false }] }] };
    vi.spyOn(ipc, 'localSearchNames')
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }))
      .mockResolvedValue(NAMES);
    vi.spyOn(ipc, 'localSearchContent').mockResolvedValue({ hits: [], truncated: false });
    render();
    type('旧');
    await flush();
    type('会议');
    await flush();
    await act(async () => resolveOld(stale));
    const titles = [...host.querySelectorAll('.nb-ls-row-title')].map((n) => n.textContent);
    expect(titles).toEqual(['会议纪要.md']);
  });

  it('没有结果时给出提示，Esc 关闭面板', async () => {
    vi.spyOn(ipc, 'localSearchNames').mockResolvedValue({ hits: [], total: 0 });
    vi.spyOn(ipc, 'localSearchContent').mockResolvedValue({ hits: [], truncated: false });
    render();
    type('不存在');
    await flush();
    expect(host.textContent).toContain('没有找到匹配的文件');
    press('Escape');
    expect(useLocalSearchStore.getState().open).toBe(false);
    // 上次查询保留，重新打开时继续使用
    expect(useLocalSearchStore.getState().query).toBe('不存在');
  });
});
