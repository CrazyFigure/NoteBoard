// NoteBoard 资源管理器：后台定时刷新
// 每 10 秒重新读取根目录及当前可见的展开目录，保持展开状态；
// 已被删除或改名的展开目录会自动收起。作为文件监听之外的兜底（网络盘、网页端、监听丢事件等）。

import { useEffect } from 'react';
import * as ipc from '../../core/ipc/commands';
import type { FileTreeNode } from '../../core/ipc/types';
import { useExplorerStore } from './explorerStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { pathKey, dirnameOf } from './pathUtils';

/** 刷新间隔（毫秒） */
const REFRESH_INTERVAL_MS = 10_000;

/** 执行一次刷新：逐层读取根目录与可见的展开目录，结果一次性回写 store */
export async function refreshVisibleTree(): Promise<void> {
  const { root, expanded } = useExplorerStore.getState();
  if (!root) return;
  const showHidden = useSettingsStore.getState().settings.file.showHiddenFiles;

  const fresh = new Map<string, FileTreeNode[]>();
  const goneDirs: string[] = [];

  // 根目录读取失败（网络中断、根被移除等）时放弃本轮，避免误收起
  let rootNodes: FileTreeNode[];
  try {
    rootNodes = await ipc.readDir(root, showHidden);
  } catch {
    return;
  }
  fresh.set(pathKey(root), rootNodes);

  // 按 父目录 pathKey → 展开子目录 pathKey 列表 建立索引，便于判断哪些展开目录已消失
  const expandedByParent = new Map<string, string[]>();
  for (const key of expanded.keys()) {
    const parent = dirnameOf(key);
    const list = expandedByParent.get(parent);
    if (list) list.push(key);
    else expandedByParent.set(parent, [key]);
  }

  /** 对比某目录的最新列表：记录消失的展开子目录，返回仍存在且展开的子目录（下一层要读取） */
  const collectNext = (dirKey: string, nodes: FileTreeNode[]): FileTreeNode[] => {
    const expandedKids = expandedByParent.get(dirKey);
    if (!expandedKids) return [];
    const dirNodes = new Map<string, FileTreeNode>();
    for (const n of nodes) {
      if (n.isDir) dirNodes.set(pathKey(n.path), n);
    }
    const next: FileTreeNode[] = [];
    for (const kid of expandedKids) {
      const node = dirNodes.get(kid);
      // 父目录中已找不到：被删除或改名
      if (node) next.push(node);
      else goneDirs.push(kid);
    }
    return next;
  };

  // 逐层并发读取，只遍历祖先全部展开的（即当前可见的）目录
  let level = collectNext(pathKey(root), rootNodes);
  while (level.length > 0) {
    const results = await Promise.all(
      level.map(async (dir) => {
        try {
          return { dir, nodes: await ipc.readDir(dir.path, showHidden) };
        } catch {
          // 单个子目录读取失败（可能是瞬时错误）时保持现状，下一轮再判断
          return { dir, nodes: null };
        }
      }),
    );
    const nextLevel: FileTreeNode[] = [];
    for (const { dir, nodes } of results) {
      if (!nodes) continue;
      const key = pathKey(dir.path);
      fresh.set(key, nodes);
      nextLevel.push(...collectNext(key, nodes));
    }
    level = nextLevel;
  }

  useExplorerStore.getState().applyRefresh(root, fresh, goneDirs);
}

/**
 * 后台定时刷新 hook
 * 页面/窗口不可见时跳过；重新可见时立即补刷一次
 */
export function usePeriodicRefresh() {
  const root = useExplorerStore((s) => s.root);

  useEffect(() => {
    if (!root) return;
    // 防止上一轮未完成时重入（网页端或网络盘读取较慢）
    let running = false;
    let disposed = false;

    const tick = async () => {
      if (running || disposed || document.hidden) return;
      running = true;
      try {
        await refreshVisibleTree();
      } catch (e) {
        console.error('资源管理器定时刷新失败:', e);
      } finally {
        running = false;
      }
    };

    const timer = window.setInterval(tick, REFRESH_INTERVAL_MS);
    // 切回窗口/应用（含移动端从后台恢复）时立即刷新
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [root]);
}
