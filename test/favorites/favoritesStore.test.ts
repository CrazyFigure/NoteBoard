import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getAllFolders,
  findFolderById,
  findParentFolder,
  findFavoriteByPath,
  isDescendantOrSelf,
  removeNodeById,
  moveNode,
  searchFavorites,
} from '../../src/features/favorites/favoritesUtils';
import { useFavoritesStore } from '../../src/features/favorites/favoritesStore';
import type { FavoriteNode } from '../../src/core/ipc/types';

// Mock ipc commands
vi.mock('../../src/core/ipc/commands', () => ({
  loadFavorites: vi.fn().mockResolvedValue({
    schemaVersion: 1,
    roots: [],
  }),
  saveFavorites: vi.fn().mockResolvedValue(undefined),
  pathExists: vi.fn().mockResolvedValue({ exists: true, isDir: false }),
  revealInExplorer: vi.fn().mockResolvedValue(undefined),
}));

describe('favoritesUtils 纯函数测试', () => {
  const sampleRoots: FavoriteNode[] = [
    {
      id: 'folder_tool',
      type: 'folder',
      name: 'Tool',
      createdAt: 1700000000000,
      children: [
        {
          id: 'folder_sub',
          type: 'folder',
          name: '工具箱',
          createdAt: 1700000000000,
          children: [],
        },
        {
          id: 'fav_1',
          type: 'file',
          name: '设计草稿.md',
          path: 'C:\\notes\\design.md',
          createdAt: 1700000000000,
        },
      ],
    },
    {
      id: 'fav_2',
      type: 'file',
      name: 'README.md',
      path: 'C:\\projects\\NoteBoard\\README.md',
      createdAt: 1700000000000,
    },
    {
      id: 'folder_other',
      type: 'folder',
      name: '其他资料',
      createdAt: 1700000000000,
      children: [],
    },
  ];

  it('getAllFolders 正确扁平化所有层级文件夹及完整路径（包含根目录选项）', () => {
    const folders = getAllFolders(sampleRoots);
    expect(folders.length).toBe(4);
    expect(folders[0]).toEqual({ id: 'root', name: '根目录', pathName: '根目录', depth: 0 });
    expect(folders[1]).toEqual({ id: 'folder_tool', name: 'Tool', pathName: '根目录 / Tool', depth: 1 });
    expect(folders[2]).toEqual({ id: 'folder_sub', name: '工具箱', pathName: '根目录 / Tool / 工具箱', depth: 2 });
    expect(folders[3]).toEqual({ id: 'folder_other', name: '其他资料', pathName: '根目录 / 其他资料', depth: 1 });
  });

  it('findFolderById 与 findParentFolder 准确定位节点与父节点', () => {
    const folder = findFolderById(sampleRoots, 'folder_sub');
    expect(folder?.name).toBe('工具箱');

    const parentOfSub = findParentFolder(sampleRoots, 'folder_sub');
    expect(parentOfSub?.id).toBe('folder_tool');

    const parentOfTool = findParentFolder(sampleRoots, 'folder_tool');
    expect(parentOfTool).toBeNull();
  });

  it('findFavoriteByPath 支持 Windows 路径大小写不敏感匹配', () => {
    const found1 = findFavoriteByPath(sampleRoots, 'c:\\notes\\design.md');
    expect(found1?.id).toBe('fav_1');
    expect(found1?.name).toBe('设计草稿.md');

    const found2 = findFavoriteByPath(sampleRoots, 'C:\\NOTES\\DESIGN.MD');
    expect(found2?.id).toBe('fav_1');

    const notFound = findFavoriteByPath(sampleRoots, 'C:\\notes\\not-exist.md');
    expect(notFound).toBeNull();
  });

  it('isDescendantOrSelf 正确校验自身及子孙嵌套关系', () => {
    expect(isDescendantOrSelf(sampleRoots, 'folder_tool', 'folder_tool')).toBe(true);
    expect(isDescendantOrSelf(sampleRoots, 'folder_tool', 'folder_sub')).toBe(true);
    expect(isDescendantOrSelf(sampleRoots, 'folder_sub', 'folder_tool')).toBe(false);
    expect(isDescendantOrSelf(sampleRoots, 'folder_other', 'folder_sub')).toBe(false);
    expect(isDescendantOrSelf(sampleRoots, 'root', 'folder_sub')).toBe(false);
  });

  it('moveNode 跨文件夹移动节点与防循环死锁', () => {
    // 将 fav_2 移动到 folder_sub
    const afterMoveFile = moveNode(sampleRoots, 'fav_2', 'folder_sub');
    const subFolder = findFolderById(afterMoveFile, 'folder_sub');
    expect(subFolder?.children.some((c) => c.id === 'fav_2')).toBe(true);
    expect(afterMoveFile.some((c) => c.id === 'fav_2')).toBe(false);

    // 尝试将 folder_tool 移动到自身的子目录 folder_sub，应被拒绝
    const invalidMove = moveNode(sampleRoots, 'folder_tool', 'folder_sub');
    expect(invalidMove).toEqual(sampleRoots);

    // 将 fav_1 移动到顶层 root
    const afterMoveToRoot = moveNode(sampleRoots, 'fav_1', 'root');
    expect(afterMoveToRoot.some((c) => c.id === 'fav_1')).toBe(true);
  });

  it('removeNodeById 删除节点', () => {
    const { newRoots: r1, removedNode: n1 } = removeNodeById(sampleRoots, 'fav_1');
    expect(n1?.id).toBe('fav_1');
    expect(findFavoriteByPath(r1, 'C:\\notes\\design.md')).toBeNull();

    const { newRoots: r2, removedNode: n2 } = removeNodeById(sampleRoots, 'folder_other');
    expect(n2?.id).toBe('folder_other');
    expect(findFolderById(r2, 'folder_other')).toBeNull();
  });

  it('searchFavorites 全局模糊匹配名称与路径', () => {
    const res1 = searchFavorites(sampleRoots, '设计');
    expect(res1.length).toBe(1);
    expect(res1[0].id).toBe('fav_1');

    const res2 = searchFavorites(sampleRoots, 'noteboard');
    expect(res2.length).toBe(1);
    expect(res2[0].id).toBe('fav_2');

    const res3 = searchFavorites(sampleRoots, 'nonexistent');
    expect(res3.length).toBe(0);
  });
});

describe('useFavoritesStore 状态操作测试', () => {
  beforeEach(() => {
    useFavoritesStore.setState({
      data: {
        schemaVersion: 1,
        roots: [],
      },
      loaded: true,
      activeFolderId: 'root',
      expandedFolderIds: [],
      searchQuery: '',
      managerModalOpen: false,
      addModalState: { open: false, target: null, initialFolderId: 'root' },
    });
  });

  it('addFavorite 添加新收藏项到根目录与子文件夹', async () => {
    const store = useFavoritesStore.getState();

    // 添加新文件到根目录
    await store.addFavorite('root', '我的笔记.md', 'C:\\work\\note.md');
    let state = useFavoritesStore.getState();
    expect(state.data.roots.length).toBe(1);
    expect(state.data.roots[0].name).toBe('我的笔记.md');

    // 创建文件夹并移动/添加文件到文件夹
    const folderId = await store.createFolder('root', '工作文档');
    await store.addFavorite(folderId, '重命名笔记.md', 'C:\\work\\note.md');
    state = useFavoritesStore.getState();
    // 根目录下有 1 个文件夹，且原根目录下相同路径文件已被移入该文件夹
    expect(state.data.roots.length).toBe(1);
    const folder = findFolderById(state.data.roots, folderId);
    expect(folder?.children.length).toBe(1);
    expect(folder?.children[0].name).toBe('重命名笔记.md');
  });

  it('createFolder 创建子文件夹并自动展开父级', async () => {
    const store = useFavoritesStore.getState();
    const folderId = await store.createFolder('root', '一级目录');
    const subFolderId = await store.createFolder(folderId, '二级目录');

    const state = useFavoritesStore.getState();
    expect(state.data.roots.length).toBe(1);
    const parent = findFolderById(state.data.roots, folderId);
    expect(parent?.children.length).toBe(1);
    expect(parent?.children[0].id).toBe(subFolderId);
    expect(state.expandedFolderIds).toContain(folderId);
  });

  it('renameFolder 与 renameFavorite 重命名操作', async () => {
    const store = useFavoritesStore.getState();
    const folderId = await store.createFolder('root', '旧文件夹');
    await store.addFavorite(folderId, '旧文件.md', 'C:\\test.md');

    await store.renameFolder(folderId, '新文件夹');
    let state = useFavoritesStore.getState();
    let folder = findFolderById(state.data.roots, folderId);
    expect(folder?.name).toBe('新文件夹');

    const firstChild = folder?.children[0];
    expect(firstChild).toBeDefined();
    const fileId = firstChild ? firstChild.id : '';
    await store.renameFavorite(fileId, '新文件.md');
    state = useFavoritesStore.getState();
    folder = findFolderById(state.data.roots, folderId);
    expect(folder?.children[0].name).toBe('新文件.md');
  });

  it('removeFavorite 移除项并在删除当前选中目录时重置 activeFolderId 为 root', async () => {
    const store = useFavoritesStore.getState();
    const folderId = await store.createFolder('root', '临时目录');
    store.setActiveFolder(folderId);
    expect(useFavoritesStore.getState().activeFolderId).toBe(folderId);

    await store.removeFavorite(folderId);
    const state = useFavoritesStore.getState();
    expect(state.activeFolderId).toBe('root');
    expect(findFolderById(state.data.roots, folderId)).toBeNull();
  });

  it('弹窗状态切换 openFavoritesModal / openAddModal', () => {
    const store = useFavoritesStore.getState();

    store.openFavoritesModal('custom_folder');
    expect(useFavoritesStore.getState().managerModalOpen).toBe(true);
    expect(useFavoritesStore.getState().activeFolderId).toBe('custom_folder');

    store.closeFavoritesModal();
    expect(useFavoritesStore.getState().managerModalOpen).toBe(false);

    store.openAddModal({ displayName: '测试文档', path: 'C:\\test.md' });
    expect(useFavoritesStore.getState().addModalState.open).toBe(true);
    expect(useFavoritesStore.getState().addModalState.target?.displayName).toBe('测试文档');

    store.closeAddModal();
    expect(useFavoritesStore.getState().addModalState.open).toBe(false);
  });
});
