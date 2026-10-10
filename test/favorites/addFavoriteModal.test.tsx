// 收藏设置交互回归：选择已有文件夹、创建并自动选择子文件夹，以及移动端返回键取消。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddFavoriteModal } from '../../src/features/favorites/AddFavoriteModal';
import { useFavoritesStore } from '../../src/features/favorites/favoritesStore';
import { findFavoriteByPath, findFolderById } from '../../src/features/favorites/favoritesUtils';
import { useMobileStore } from '../../src/mobile/mobileStore';
import * as ipc from '../../src/core/ipc/commands';
import { MobileHome } from '../../src/mobile/MobileHome';

vi.mock('../../src/core/ipc/commands', () => ({ saveFavorites: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../src/core/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/platform')>(), IS_MOBILE_UI: true,
}));
// 首页只验证收藏入口，文件操作和新建文档入口不调用真实 IPC 或编辑器内核。
vi.mock('../../src/mobile/mobileFiles', () => Object.fromEntries([
  'createFolder', 'deleteEntry', 'importFiles', 'loadFolder', 'openEntry', 'openPathInEditor',
  'refreshCurrentFolder', 'renameEntry', 'shareEntry', 'switchLocation', 'validateFileName',
].map((name) => [name, vi.fn()])));
vi.mock('../../src/features/welcome/welcomeActions', () => Object.fromEntries([
  'newBitable', 'newBoard', 'newDrawio', 'newInfographic', 'newJson', 'newMarkdown', 'newMermaid',
  'newMindmap', 'newPlantUml', 'newSql', 'newText', 'newTextDiff',
].map((name) => [name, vi.fn()])));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  useFavoritesStore.setState({
    data: { schemaVersion: 1, roots: [{ id: 'work', type: 'folder', name: '工作', createdAt: 1, children: [] }] },
    addModalState: { open: false, target: null },
  });
  useMobileStore.setState({ overlays: [] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

/** 打开真实收藏设置弹窗，初始指定文件夹可用于验证嵌套创建。 */
async function openModal(folder = 'root') {
  await act(async () => {
    useFavoritesStore.getState().openAddModal({ name: '笔记.md', path: '/notes/note.md' }, folder);
    root.render(<AddFavoriteModal />);
  });
}

/** 使用原生 setter 触发 React 受控输入更新，避免直接赋值被输入值跟踪器忽略。 */
async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('选定已有文件夹后确认，收藏应保存到所选目录', async () => {
  await openModal();
  const select = host.querySelector('select')!;
  await act(async () => {
    select.value = 'work';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  const folder = findFolderById(useFavoritesStore.getState().data.roots, 'work');
  expect(folder?.children[0].name).toBe('笔记.md');
  expect(useFavoritesStore.getState().addModalState.open).toBe(false);
});

it('新建子文件夹后自动选中，不能重置用户编辑的收藏名称', async () => {
  await openModal('work');
  await changeInput(host.querySelector('input[placeholder="收藏名称"]')!, '我的收藏名称');
  await act(async () => {
    Array.from(host.querySelectorAll('button')).find((button) => button.textContent === '新建文件夹')!.click();
  });
  await changeInput(host.querySelector('input[placeholder="文件夹名称"]')!, '项目');
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="确认新建文件夹"]')!.click();
  });
  const createdId = host.querySelector('select')!.value;
  expect(createdId).not.toBe('work');
  expect(findFolderById(useFavoritesStore.getState().data.roots, 'work')?.children[0].name).toBe('项目');
  expect(host.querySelector<HTMLInputElement>('input[placeholder="收藏名称"]')!.value).toBe('我的收藏名称');
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(findFolderById(useFavoritesStore.getState().data.roots, createdId)?.children[0].name).toBe('我的收藏名称');
});

it('移动端返回键取消弹窗时不得写入收藏', async () => {
  await openModal();
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(useMobileStore.getState().overlays).toHaveLength(1);
  await act(async () => useMobileStore.getState().overlays.at(-1)!.close());
  expect(useFavoritesStore.getState().addModalState.open).toBe(false);
  expect(useMobileStore.getState().overlays).toHaveLength(0);
  expect(findFavoriteByPath(useFavoritesStore.getState().data.roots, '/notes/note.md')).toBeNull();
  expect(ipc.saveFavorites).not.toHaveBeenCalled();
});

it('移动端长按文件加入收藏，应先打开设置弹窗而不是直接写入根目录', async () => {
  vi.useFakeTimers();
  useMobileStore.setState({
    homeSection: 'files', location: 'workspace', currentFolder: '/notes', locationRoot: '/notes',
    entries: [{ name: '笔记.md', path: '/notes/note.md', isDir: false, kind: 'markdown', isHidden: false, isSymlink: false, size: 10, mtime: null }],
    loading: false, listError: null,
  });
  await act(async () => root.render(<><MobileHome /><AddFavoriteModal /></>));
  const fileRow = Array.from(host.querySelectorAll('.nb-m-row')).find((row) => row.textContent?.includes('笔记.md'))!;
  await act(async () => {
    fileRow.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }));
    vi.advanceTimersByTime(480);
  });
  await act(async () => {
    Array.from(host.querySelectorAll('button')).find((button) => button.textContent === '加入收藏')!.click();
    vi.advanceTimersByTime(0);
  });
  expect(host.querySelector('.nb-add-favorite-dialog')).not.toBeNull();
  expect(host.querySelector('select')).not.toBeNull();
  expect(host.textContent).toContain('新建文件夹');
  expect(ipc.saveFavorites).not.toHaveBeenCalled();
  expect(findFavoriteByPath(useFavoritesStore.getState().data.roots, '/notes/note.md')).toBeNull();
});
