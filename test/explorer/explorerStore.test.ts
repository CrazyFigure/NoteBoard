import { describe, it, expect, beforeEach } from 'vitest';
import {
  useExplorerStore,
  sameKey,
  isSubPath,
  normalizePath,
  getPathChain,
} from '../../src/features/explorer/explorerStore';
import type { FileTreeNode } from '../../src/core/ipc/types';

describe('pathUtils', () => {
  describe('normalizePath', () => {
    it('处理正斜杠与反斜杠混合并去除末尾斜杠', () => {
      expect(normalizePath('C:/Notes/Work/')).toBe('C:\\Notes\\Work');
      expect(normalizePath('C:\\Notes\\Work\\\\')).toBe('C:\\Notes\\Work');
    });

    it('保留盘符根目录反斜杠', () => {
      expect(normalizePath('C:')).toBe('C:\\');
      expect(normalizePath('C:\\')).toBe('C:\\');
      expect(normalizePath('c:/')).toBe('c:\\');
    });
  });

  describe('sameKey', () => {
    it('null 与 null 相同', () => {
      expect(sameKey(null, null)).toBe(true);
    });

    it('null 与路径不相同', () => {
      expect(sameKey(null, 'C:\\test')).toBe(false);
    });

    it('大小写不敏感', () => {
      expect(sameKey('C:\\Notes', 'c:\\notes')).toBe(true);
    });

    it('斜杠格式不同视为相同', () => {
      expect(sameKey('C:/Notes/Work', 'c:\\notes\\work')).toBe(true);
    });

    it('不同路径不相同', () => {
      expect(sameKey('C:\\Notes', 'D:\\Notes')).toBe(false);
    });
  });

  describe('isSubPath', () => {
    it('相同路径视为包含', () => {
      expect(isSubPath('C:\\project', 'c:\\project')).toBe(true);
    });

    it('子目录与深层子文件正确识别为包含', () => {
      expect(isSubPath('C:\\project', 'C:\\project\\src\\App.tsx')).toBe(true);
      expect(isSubPath('C:/project', 'c:\\project\\README.md')).toBe(true);
    });

    it('非子路径且前缀相似（如 C:\\project2）不误判', () => {
      expect(isSubPath('C:\\project', 'C:\\project2\\file.txt')).toBe(false);
    });

    it('盘符根目录包含子文件', () => {
      expect(isSubPath('C:\\', 'C:\\Users\\file.txt')).toBe(true);
    });
  });

  describe('getPathChain', () => {
    it('计算从根目录到目标文件的所有祖先目录链', () => {
      const chain = getPathChain(
        'C:\\project',
        'C:\\project\\src\\features\\explorer\\Explorer.tsx',
      );
      expect(chain).toEqual([
        'C:\\project\\src',
        'C:\\project\\src\\features',
        'C:\\project\\src\\features\\explorer',
      ]);
    });

    it('目标文件位于根目录下直接子项时返回空链', () => {
      const chain = getPathChain('C:\\project', 'C:\\project\\README.md');
      expect(chain).toEqual([]);
    });

    it('目标路径不在根目录下时返回空链', () => {
      const chain = getPathChain('C:\\project', 'D:\\other\\file.txt');
      expect(chain).toEqual([]);
    });
  });
});

describe('explorerStore 纯跟随逻辑', () => {
  beforeEach(() => {
    useExplorerStore.getState().clear();
  });

  const mockChildren: FileTreeNode[] = [
    { path: 'C:\\notes\\file1.md', name: 'file1.md', isDir: false, kind: 'markdown', size: 100, mtime: 0, isHidden: false, isSymlink: false },
    { path: 'C:\\notes\\dir1', name: 'dir1', isDir: true, kind: null, size: null, mtime: null, isHidden: false, isSymlink: false },
  ];

  it('跨目录 setRoot 清空 expanded 和 children', () => {
    const store = useExplorerStore;
    // 先设旧 root
    store.getState().setRoot('C:\\old', mockChildren);
    store.getState().expand('C:\\old\\sub', mockChildren);
    expect(store.getState().expanded.size).toBe(1);

    // 设新 root
    store.getState().setRoot('C:\\new', mockChildren);
    expect(store.getState().root).toBe('C:\\new');
    expect(store.getState().expanded.size).toBe(0);
    expect(store.getState().revealed).toBe(null);
  });

  it('同目录只更新 revealed，不重建树', () => {
    const store = useExplorerStore;
    store.getState().setRoot('C:\\notes', mockChildren);
    store.getState().expand('C:\\notes\\sub', mockChildren);

    // 同目录，只更新 revealed 并累加 revealCount
    store.getState().setRevealed('C:\\notes\\file1.md');
    expect(store.getState().root).toBe('C:\\notes');
    expect(store.getState().expanded.size).toBe(1); // 不变
    expect(store.getState().revealed).toBe('C:\\notes\\file1.md');
    expect(store.getState().revealCount).toBe(1);
  });

  it('setRevealed 重复调用时更新 revealCount', () => {
    const store = useExplorerStore;
    store.getState().setRevealed('C:\\notes\\file1.md', true);
    expect(store.getState().revealCount).toBe(1);
    store.getState().setRevealed('C:\\notes\\file1.md', true);
    expect(store.getState().revealCount).toBe(2);

    // shouldScroll = false 时不累加计数
    store.getState().setRevealed('C:\\notes\\file1.md', false);
    expect(store.getState().revealCount).toBe(2);
  });

  it('toggleExpand 切换展开状态', () => {
    const store = useExplorerStore;
    store.getState().setRoot('C:\\notes', mockChildren);

    // 展开
    store.getState().expand('C:\\notes\\dir1', mockChildren);
    expect(store.getState().isExpanded('C:\\notes\\dir1')).toBe(true);

    // 收起
    store.getState().collapse('C:\\notes\\dir1');
    expect(store.getState().isExpanded('C:\\notes\\dir1')).toBe(false);
  });

  it('updateChildren 增量更新', () => {
    const store = useExplorerStore;
    store.getState().setRoot('C:\\notes', mockChildren);

    const newChildren: FileTreeNode[] = [
      ...mockChildren,
      { path: 'C:\\notes\\file2.md', name: 'file2.md', isDir: false, kind: 'markdown', size: 200, mtime: 0, isHidden: false, isSymlink: false },
    ];
    store.getState().updateChildren('C:\\notes', newChildren);

    const children = store.getState().getChildren('C:\\notes');
    expect(children).toHaveLength(3);
  });

  it('rescan 清空 children 但保留 root', () => {
    const store = useExplorerStore;
    store.getState().setRoot('C:\\notes', mockChildren);
    store.getState().expand('C:\\notes\\dir1', mockChildren);

    const newRootChildren: FileTreeNode[] = [
      { path: 'C:\\notes\\new.md', name: 'new.md', isDir: false, kind: 'markdown', size: 50, mtime: 0, isHidden: false, isSymlink: false },
    ];
    store.getState().rescan(newRootChildren);

    // root 保留
    expect(store.getState().root).toBe('C:\\notes');
    // 根的 children 被替换
    const rootChildren = store.getState().getChildren('C:\\notes');
    expect(rootChildren).toEqual(newRootChildren);
    // dir1 的 children 被清空（需要重新加载）
    expect(store.getState().getChildren('C:\\notes\\dir1')).toBeUndefined();
  });

  it('clear 清空一切', () => {
    const store = useExplorerStore;
    store.getState().setRoot('C:\\notes', mockChildren);
    store.getState().expand('C:\\notes\\dir1', mockChildren);
    store.getState().setRevealed('C:\\notes\\file1.md');

    store.getState().clear();
    expect(store.getState().root).toBe(null);
    expect(store.getState().expanded.size).toBe(0);
    expect(store.getState().children.size).toBe(0);
    expect(store.getState().revealed).toBe(null);
    expect(store.getState().revealCount).toBe(0);
  });
});
