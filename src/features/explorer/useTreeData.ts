// NoteBoard 资源管理器：树数据加载
// 按需加载子节点，不递归预读
// 详见 docs/09-开发路线图.md 5.2

import { useCallback } from 'react';
import * as ipc from '../../core/ipc/commands';
import type { FileTreeNode } from '../../core/ipc/types';
import { useExplorerStore, getPathChain } from './explorerStore';
import { useSettingsStore } from '../../stores/settingsStore';

/** 目录首屏最多渲染的条目数；超出时显示"加载更多"按钮 */
export const PAGE_SIZE = 200;

/** 溢出占位节点路径前缀，渲染层据此识别并绘制加载更多按钮 */
export const OVERFLOW_PREFIX = 'nb:overflow:';

/**
 * 将节点列表截断到 keepCount，末尾追加加载更多占位节点
 * 节点数不足 keepCount 时直接返回原数组
 */
export function sliceToPage(nodes: FileTreeNode[], dirPath: string, keepCount = PAGE_SIZE): FileTreeNode[] {
  if (nodes.length <= keepCount) return nodes;
  const remaining = nodes.length - keepCount;
  return [
    ...nodes.slice(0, keepCount),
    {
      path: `${OVERFLOW_PREFIX}${remaining}:${dirPath}`,
      name: `加载更多（剩余 ${remaining} 个）`,
      isDir: false,
      kind: null,
      size: null,
      mtime: null,
      isHidden: false,
      isSymlink: false,
    } as FileTreeNode,
  ];
}

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
        // 排序已经在 Rust 侧完成（目录优先 + 自然排序）；超出首屏上限时分页
        return sliceToPage(nodes, dirPath);
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
