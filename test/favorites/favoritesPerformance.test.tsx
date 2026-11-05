// 收藏夹性能与拖放回归：真实列表按帧更新、按最终位置提交，探测请求有并发上限且可取消。
import React, { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FavoritesManagerModal } from '@/features/favorites/FavoritesManagerModal';
import { useFavoritesStore } from '@/features/favorites/favoritesStore';
import { findFolderById } from '@/features/favorites/favoritesUtils';
import type { FavoriteFileItem, FavoriteNode } from '@/core/ipc/types';
import * as ipc from '@/core/ipc/commands';

vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/core/ipc/commands', () => ({ pathExists: vi.fn(), saveFavorites: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/features/editor-code/orchestration/openDocument', () => ({ openDocument: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
let frameId: number;
let hitDescriptor: PropertyDescriptor | undefined;
const frames = new Map<number, FrameRequestCallback>();
const hitTest = vi.fn();
const renders = vi.fn();
const file = (id: string, path = `/notes/${id}.md`): FavoriteFileItem => ({ id, type: 'file', name: `${id}.md`, path, createdAt: 1 });
const roots = (): FavoriteNode[] => [
  { id: 'folder', type: 'folder', name: '目标文件夹', children: [], createdAt: 1 }, file('a'), file('b'), file('c'),
];

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(ipc.pathExists).mockResolvedValue({ exists: true, isDir: false });
  useFavoritesStore.setState({ data: { schemaVersion: 1, roots: roots() }, managerModalOpen: true, activeFolderId: 'root', searchQuery: '', expandedFolderIds: [] });
  frames.clear();
  frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  hitDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hitTest });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (hitDescriptor) Object.defineProperty(document, 'elementFromPoint', hitDescriptor);
  else Reflect.deleteProperty(document, 'elementFromPoint');
});

async function render() {
  await act(async () => root.render(<Profiler id="favorites" onRender={renders}><FavoritesManagerModal /></Profiler>));
  const folder = host.querySelector('[data-fav-row-id="folder"]') as HTMLElement;
  if (folder) {
    hitTest.mockReturnValue(folder);
    vi.spyOn(folder, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, width: 500, height: 100, right: 500, bottom: 100, toJSON() {} });
  }
}

const pointer = (target: EventTarget, type: string, x: number, y = 50, pointerId = 1) => target.dispatchEvent(new PointerEvent(type, {
  bubbles: true, cancelable: true, button: 0, pointerId, pointerType: 'mouse', clientX: x, clientY: y,
}));

async function nextFrame() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}

async function startDrag() {
  await act(async () => {
    pointer(host.querySelector('[data-fav-row-id="a"]')!, 'pointerdown', 0, 0);
    pointer(window, 'pointermove', 100);
  });
  await nextFrame();
}

it('同一落点内连续移动只按帧命中检测，不重绘收藏列表', async () => {
  await render();
  await startDrag();
  renders.mockClear();
  hitTest.mockClear();
  await act(async () => {
    for (let i = 0; i < 100; i += 1) pointer(window, 'pointermove', 100 + i);
  });
  expect(hitTest).not.toHaveBeenCalled();
  await nextFrame();
  expect(hitTest).toHaveBeenCalledTimes(1);
  expect(renders).not.toHaveBeenCalled();
  expect((host.querySelector('.nb-favorites-drag-preview') as HTMLElement).style.transform).toBe('translate3d(211px, 60px, 0)');
  expect(ipc.saveFavorites).not.toHaveBeenCalled();
});

it('松手早于显示帧时仍按最后位置搬移，且一次提交', async () => {
  await render();
  await act(async () => {
    pointer(host.querySelector('[data-fav-row-id="a"]')!, 'pointerdown', 0, 0);
    pointer(window, 'pointermove', 100);
    pointer(window, 'pointerup', 150);
  });
  expect(findFolderById(useFavoritesStore.getState().data.roots, 'folder')?.children.map((item) => item.id)).toEqual(['a']);
  expect(ipc.saveFavorites).toHaveBeenCalledTimes(1);
  expect(frames.size).toBe(0);
  expect(host.querySelector('.nb-favorites-drag-preview')).toBeNull();
});

it.each(['Escape', 'pointercancel', 'close'])('%s 取消待绘拖动，不搬移也不遗留预览', async (reason) => {
  await render();
  await startDrag();
  await act(async () => {
    pointer(window, 'pointermove', 150);
    if (reason === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    else if (reason === 'close') useFavoritesStore.getState().closeFavoritesModal();
    else pointer(window, 'pointercancel', 150);
  });
  await nextFrame();
  expect(host.querySelector('.nb-favorites-drag-preview')).toBeNull();
  expect(frames.size).toBe(0);
  expect(ipc.saveFavorites).not.toHaveBeenCalled();
  expect(findFolderById(useFavoritesStore.getState().data.roots, 'folder')?.children).toEqual([]);
});

it('其他指针不干扰当前拖动', async () => {
  await render();
  await startDrag();
  await act(async () => {
    pointer(window, 'pointermove', 300, 50, 2);
    pointer(window, 'pointerup', 300, 50, 2);
  });
  expect(host.querySelector('.nb-favorites-drag-preview')).not.toBeNull();
  expect(ipc.saveFavorites).not.toHaveBeenCalled();
  await act(async () => pointer(window, 'pointerup', 100));
  expect(ipc.saveFavorites).toHaveBeenCalledTimes(1);
});

it('连续搜索仍共用最多六个并发，关闭后停止后续队列', async () => {
  const pending: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  vi.mocked(ipc.pathExists).mockImplementation(() => new Promise((resolve) => {
    active += 1;
    peak = Math.max(peak, active);
    pending.push(() => { active -= 1; resolve({ exists: true, isDir: false }); });
  }));
  useFavoritesStore.setState({ data: { schemaVersion: 1, roots: Array.from({ length: 20 }, (_, i) => file(`file-${i}`)) } });
  await render();
  expect(ipc.pathExists).toHaveBeenCalledTimes(6);
  // 旧请求还在等待时替换搜索队列，不能再额外启动六个调用。
  await act(async () => useFavoritesStore.getState().setSearchQuery('file-1'));
  expect(ipc.pathExists).toHaveBeenCalledTimes(6);
  await act(async () => pending.splice(0).forEach((resolve) => resolve()));
  expect(ipc.pathExists).toHaveBeenCalledTimes(12);
  expect(peak).toBe(6);
  await act(async () => useFavoritesStore.getState().closeFavoritesModal());
  await act(async () => pending.splice(0).forEach((resolve) => resolve()));
  expect(ipc.pathExists).toHaveBeenCalledTimes(12);
});

it('重复路径只探测一次，失效状态仍覆盖所有同路径收藏', async () => {
  vi.mocked(ipc.pathExists).mockResolvedValue({ exists: false, isDir: false });
  useFavoritesStore.setState({ data: { schemaVersion: 1, roots: [file('a', '/same.md'), file('b', '/same.md')] } });
  await render();
  expect(ipc.pathExists).toHaveBeenCalledTimes(1);
  expect(host.textContent?.match(/已失效/g)).toHaveLength(2);
});
