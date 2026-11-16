// NoteBoard 资源管理器定时刷新与全部收起测试
// 覆盖：刷新保留展开状态、删除/改名的展开目录自动收起、未变化节点复用引用、读取失败不误收起、全部收起。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeNode } from '@/core/ipc/types';

// 模拟文件系统：目录路径 → 子节点；不存在的目录读取时抛错
const fs = new Map<string, FileTreeNode[]>();
const readDirMock = vi.fn(async (path: string) => {
  const nodes = fs.get(path);
  if (!nodes) throw new Error(`not found: ${path}`);
  return nodes.map((n) => ({ ...n }));
});
vi.mock('@/core/ipc/commands', () => ({
  readDir: (path: string) => readDirMock(path),
}));

import { useExplorerStore } from '@/features/explorer/explorerStore';
import { refreshVisibleTree } from '@/features/explorer/usePeriodicRefresh';

const ROOT = 'C:\\notes';

function dir(path: string): FileTreeNode {
  const name = path.split('\\').pop()!;
  return { path, name, isDir: true, kind: null, size: null, mtime: null, isHidden: false, isSymlink: false };
}

function file(path: string, mtime = 0): FileTreeNode {
  const name = path.split('\\').pop()!;
  return { path, name, isDir: false, kind: 'markdown', size: 1, mtime, isHidden: false, isSymlink: false };
}

/** 按当前模拟文件系统初始化根目录，并展开指定目录 */
async function setup(expandDirs: string[]) {
  useExplorerStore.getState().setRoot(ROOT, fs.get(ROOT)!);
  for (const d of expandDirs) useExplorerStore.getState().expand(d, fs.get(d)!);
}

describe('资源管理器定时刷新', () => {
  beforeEach(() => {
    useExplorerStore.getState().clear();
    readDirMock.mockClear();
    fs.clear();
    fs.set(ROOT, [dir(`${ROOT}\\a`), dir(`${ROOT}\\b`), file(`${ROOT}\\x.md`)]);
    fs.set(`${ROOT}\\a`, [dir(`${ROOT}\\a\\sub`), file(`${ROOT}\\a\\1.md`)]);
    fs.set(`${ROOT}\\a\\sub`, [file(`${ROOT}\\a\\sub\\deep.md`)]);
    fs.set(`${ROOT}\\b`, [file(`${ROOT}\\b\\2.md`)]);
  });

  it('新增文件后刷新：保留展开状态并显示新文件', async () => {
    await setup([`${ROOT}\\a`, `${ROOT}\\a\\sub`]);
    fs.set(`${ROOT}\\a\\sub`, [file(`${ROOT}\\a\\sub\\deep.md`), file(`${ROOT}\\a\\sub\\new.md`)]);

    await refreshVisibleTree();

    const s = useExplorerStore.getState();
    expect(s.isExpanded(`${ROOT}\\a`)).toBe(true);
    expect(s.isExpanded(`${ROOT}\\a\\sub`)).toBe(true);
    expect(s.getChildren(`${ROOT}\\a\\sub`)?.map((n) => n.name)).toEqual(['deep.md', 'new.md']);
  });

  it('内容未变化时保持原数组与节点引用', async () => {
    await setup([`${ROOT}\\a`]);
    const before = useExplorerStore.getState().children;

    await refreshVisibleTree();

    expect(useExplorerStore.getState().children).toBe(before);
  });

  it('仅部分节点变化时复用未变化节点对象', async () => {
    await setup([]);
    const oldA = useExplorerStore.getState().getChildren(ROOT)![0];
    fs.set(ROOT, [dir(`${ROOT}\\a`), dir(`${ROOT}\\b`), file(`${ROOT}\\x.md`, 99)]);

    await refreshVisibleTree();

    const rootChildren = useExplorerStore.getState().getChildren(ROOT)!;
    expect(rootChildren[0]).toBe(oldA);
    expect(rootChildren[2].mtime).toBe(99);
  });

  it('展开目录被删除：自身及后代一并收起', async () => {
    await setup([`${ROOT}\\a`, `${ROOT}\\a\\sub`, `${ROOT}\\b`]);
    fs.set(ROOT, [dir(`${ROOT}\\b`), file(`${ROOT}\\x.md`)]);
    fs.delete(`${ROOT}\\a`);
    fs.delete(`${ROOT}\\a\\sub`);

    await refreshVisibleTree();

    const s = useExplorerStore.getState();
    expect(s.isExpanded(`${ROOT}\\a`)).toBe(false);
    expect(s.isExpanded(`${ROOT}\\a\\sub`)).toBe(false);
    expect(s.getChildren(`${ROOT}\\a\\sub`)).toBeUndefined();
    expect(s.isExpanded(`${ROOT}\\b`)).toBe(true);
  });

  it('展开目录被改名：旧路径收起，新路径不展开', async () => {
    await setup([`${ROOT}\\a`]);
    fs.set(ROOT, [dir(`${ROOT}\\renamed`), dir(`${ROOT}\\b`), file(`${ROOT}\\x.md`)]);
    fs.set(`${ROOT}\\renamed`, fs.get(`${ROOT}\\a`)!);
    fs.delete(`${ROOT}\\a`);

    await refreshVisibleTree();

    const s = useExplorerStore.getState();
    expect(s.isExpanded(`${ROOT}\\a`)).toBe(false);
    expect(s.isExpanded(`${ROOT}\\renamed`)).toBe(false);
  });

  it('子目录读取失败但父目录仍列出时不误收起', async () => {
    await setup([`${ROOT}\\a`]);
    fs.delete(`${ROOT}\\a`);

    await refreshVisibleTree();

    expect(useExplorerStore.getState().isExpanded(`${ROOT}\\a`)).toBe(true);
  });

  it('根目录读取失败时放弃本轮', async () => {
    await setup([`${ROOT}\\a`]);
    const before = useExplorerStore.getState();
    fs.delete(ROOT);

    await refreshVisibleTree();

    expect(useExplorerStore.getState().expanded).toBe(before.expanded);
    expect(useExplorerStore.getState().children).toBe(before.children);
  });

  it('不读取被折叠祖先下的展开目录', async () => {
    await setup([`${ROOT}\\a`, `${ROOT}\\a\\sub`]);
    useExplorerStore.getState().collapse(`${ROOT}\\a`);

    await refreshVisibleTree();

    expect(readDirMock).toHaveBeenCalledTimes(1);
    expect(readDirMock).toHaveBeenCalledWith(ROOT);
  });

  it('刷新期间切换根目录时丢弃结果', async () => {
    await setup([`${ROOT}\\a`]);
    fs.set(ROOT, [file(`${ROOT}\\only.md`)]);
    const pending = refreshVisibleTree();
    useExplorerStore.getState().setRoot('C:\\other', []);

    await pending;

    expect(useExplorerStore.getState().getChildren(ROOT)).toBeUndefined();
  });
});

describe('全部收起', () => {
  it('清空所有展开目录但保留子节点缓存', () => {
    useExplorerStore.getState().setRoot(ROOT, [dir(`${ROOT}\\a`)]);
    useExplorerStore.getState().expand(`${ROOT}\\a`, [dir(`${ROOT}\\a\\sub`)]);
    useExplorerStore.getState().expand(`${ROOT}\\a\\sub`, []);

    useExplorerStore.getState().collapseAll();

    const s = useExplorerStore.getState();
    expect(s.expanded.size).toBe(0);
    expect(s.getChildren(`${ROOT}\\a`)).toHaveLength(1);
  });
});
