// NoteBoard 资源管理器：树数据加载
// 按需加载子节点，不递归预读
// 详见 docs/09-开发路线图.md 5.2

import { useCallback } from 'react';
import * as ipc from '../../core/ipc/commands';
import type { FileTreeNode } from '../../core/ipc/types';
import { useExplorerStore } from './explorerStore';
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

  /** 展开到目标文件（reveal） */
  const revealPath = useCallback(
    async (filePath: string, rootDir: string) => {
      // 从根到文件的路径链
      // 简单实现：逐级展开
      const parts = filePath.substring(rootDir.length).split(/[\\/]/).filter(Boolean);
      let current = rootDir;

      for (let i = 0; i < parts.length - 1; i++) {
        current = current + '\\' + parts[i];
        if (!isExpanded(current)) {
          const children = await loadChildren(current);
          expand(current, children);
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
