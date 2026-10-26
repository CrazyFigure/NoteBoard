// 原生系统手势由桌面验证；这里验证接收提示的定位、源/目标文案和清理，避免遮挡真实拖放。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabDropOverlay } from '@/features/window/TabDropOverlay';
import { resetTabDragFeedback, setNativeTabDragInfo, setNativeTabDragPoint } from '@/features/window/tabDragFeedback';

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-target' }) }));
let root: Root;
let host: HTMLDivElement;
let bar: HTMLDivElement;

describe('标签接收反馈', () => {
  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetTabDragFeedback();
    host = document.createElement('div');
    bar = document.createElement('div');
    bar.setAttribute('role', 'tablist');
    bar.innerHTML = '<div data-tab-key="target.md"></div>';
    document.body.append(host, bar);
    const rect = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 36,
      x: left, y: 0, width, height: 36, toJSON() {} });
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(rect(40, 300));
    vi.spyOn(bar.firstElementChild!, 'getBoundingClientRect').mockReturnValue(rect(40, 100));
    root = createRoot(host);
    await act(async () => root.render(<TabDropOverlay />));
  });
  afterEach(async () => {
    await act(async () => { resetTabDragFeedback(); root.unmount(); });
    host.remove(); bar.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it('进入目标窗口显示主题高亮和正确插入线，离开立即取消接收态', async () => {
    await act(async () => {
      setNativeTabDragInfo({ sourceLabel: 'nb-source', key: 'source.md', displayName: 'source.md' });
      setNativeTabDragPoint({ x: 60, y: 18 });
    });
    expect(document.querySelector('.nb-tab-drop-feedback')?.classList.contains('is-visible')).toBe(true);
    expect(document.querySelector('.nb-tab-drop-hint')?.textContent).toBe('松开以合并标签');
    expect(document.querySelector<HTMLElement>('.nb-tab-drop-marker')?.style.left).toBe('39px');
    await act(async () => setNativeTabDragPoint(null));
    expect(document.querySelector('.nb-tab-drop-feedback')?.classList.contains('is-visible')).toBe(false);
  });

  it('放回源窗口时提示放回，原生拖动结束后清除高亮和插入线', async () => {
    await act(async () => {
      setNativeTabDragInfo({ sourceLabel: 'nb-target', key: 'source.md', displayName: 'source.md' });
      setNativeTabDragPoint({ x: 300, y: 18 });
    });
    expect(document.querySelector('.nb-tab-drop-hint')?.textContent).toBe('松开以放回标签');
    await act(async () => setNativeTabDragInfo(null));
    expect(document.querySelector('.nb-tab-drop-marker')).toBeNull();
    expect(document.querySelector('.nb-tab-drop-feedback')?.classList.contains('is-visible')).toBe(false);
  });
});
