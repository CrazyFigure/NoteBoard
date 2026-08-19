// NoteBoard 资源管理器：树数据加载
// 按需加载子节点，不递归预读
// 详见 docs/09-开发路线图.md 5.2

import { useCallback } from 'react';
import * as ipc from '../../core/ipc/commands';
import type { FileTreeNode } from '../../core/ipc/types';
import { useExplorerStore, getPathChain } from './explorerStore';
import { useSettingsStore } from '../../stores/settingsStore';

/**
 * 按需加载子节点 hook
 */
export function useTreeData() {
  const expand = useExplorerStore((s) => s.expand);
  const collapse = useExplorerStore((s) => s.collapse);
  const isExpanded = useExplorerStore((s) => s.isExpanded);
  const getChildren = useExplorerStore((s) => s.getChildren);
  const loading = useExplorerStore((s) => s.loading);
  const setLoading = useExplorerStore((s) => s.setLoading);
  const showHidden = useSettingsStore((s) => s.settings.file.showHiddenFiles);

  /** 加载目录的子节点 */
  const loadChildren = useCallback(
    async (dirPath: string): Promise<FileTreeNode[]> => {
      try {
        const nodes = await ipc.readDir(dirPath, showHidden);
        // 排序已经在 Rust 侧完成（目录优先 + 自然排序）
        return nodes;
      } catch (e) {
        console.error('加载目录失败:', dirPath, e);
        return [];
      }
    },
    [showHidden],
  );

  /** 切换展开/收起 */
  const toggle = useCallback(
    async (dirPath: string) => {
      if (isExpanded(dirPath)) {
        collapse(dirPath);
        return;
      }

      // 需要加载
      setLoading(true);
      const children = await loadChildren(dirPath);
      setLoading(false);
      expand(dirPath, children);
    },
    [isExpanded, collapse, setLoading, expand, loadChildren],
  );

  /** 展开到目标文件的各级祖先目录（reveal） */
  const revealPath = useCallback(
    async (filePath: string, rootDir: string) => {
      // 严谨计算从根目录到目标文件的祖先目录路径链并逐级展开
      const dirsToExpand = getPathChain(rootDir, filePath);
      for (const dir of dirsToExpand) {
        if (!isExpanded(dir)) {
          const children = await loadChildren(dir);
          expand(dir, children);
        }
      }
    },
    [isExpanded, expand, loadChildren],
  );

  return {
    toggle,
    loadChildren,
    revealPath,
    isExpanded,
    getChildren,
    loading,
  };
}
