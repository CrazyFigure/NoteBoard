// 本地文件搜索设置：首次开启默认索引同步文件夹、添加位置去重、移除位置

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '../../src/core/ipc/commands';
import type { Settings, SyncConfigFile } from '../../src/core/ipc/types';
import { LocalSearchSettingsCard, mergeRoots } from '../../src/features/localSearch/LocalSearchSettings';
import { TooltipProvider } from '../../src/components/Tooltip';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../src/stores/settingsStore';
import { useSyncStore } from '../../src/stores/syncStore';

let host: HTMLDivElement;
let root: Root;
let saved: Settings[];

function render() {
  act(() => root.render(<TooltipProvider><LocalSearchSettingsCard /></TooltipProvider>));
}

function checkbox(): HTMLInputElement {
  return host.querySelector('input[aria-label="本地文件搜索"]') as HTMLInputElement;
}

function withSyncRoot(rootDir: string) {
  useSyncStore.setState({ config: { sync: { rootDir } } as unknown as SyncConfigFile, initialized: true });
}

describe('本地文件搜索设置', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    saved = [];
    vi.spyOn(ipc, 'saveSettings').mockImplementation(async (s: Settings) => {
      saved.push(s);
      return 1;
    });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('首次开启时默认索引同步文件夹', async () => {
    withSyncRoot('C:\\同步笔记');
    render();
    expect(host.textContent).not.toContain('索引位置');
    await act(async () => checkbox().click());
    expect(useSettingsStore.getState().settings.localSearch).toEqual({ enabled: true, roots: ['C:\\同步笔记'] });
    expect(saved.at(-1)?.localSearch?.roots).toEqual(['C:\\同步笔记']);
    expect(host.textContent).toContain('同步文件夹');
  });

  it('没有同步文件夹时开启后位置为空', async () => {
    withSyncRoot('');
    render();
    await act(async () => checkbox().click());
    expect(useSettingsStore.getState().settings.localSearch).toEqual({ enabled: true, roots: [] });
    expect(host.textContent).toContain('尚未添加位置');
  });

  it('关闭再开启时保留已有位置', async () => {
    withSyncRoot('C:\\同步笔记');
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, localSearch: { enabled: false, roots: ['D:\\'] } } });
    render();
    await act(async () => checkbox().click());
    expect(useSettingsStore.getState().settings.localSearch).toEqual({ enabled: true, roots: ['D:\\'] });
  });

  it('可移除位置', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, localSearch: { enabled: true, roots: ['D:\\', 'C:\\工作'] } } });
    withSyncRoot('');
    render();
    const remove = [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '移除 D:\\')!;
    await act(async () => remove.click());
    expect(useSettingsStore.getState().settings.localSearch?.roots).toEqual(['C:\\工作']);
  });

  it('合并位置时忽略重复（Windows 忽略大小写与末尾分隔符）', () => {
    expect(mergeRoots(['C:\\Notes'], ['c:\\notes\\', 'D:\\', 'C:\\Notes', ' '])).toEqual(['C:\\Notes', 'D:\\']);
  });
});
