// NoteBoard 资源管理器：文件监听
// watch_dir / unwatch_dir 跟随 root 切换；增量刷新
// 详见 docs/09-开发路线图.md 5.10/5.11

import { useEffect, useRef } from 'react';
import * as ipc from '../../core/ipc/commands';
import { onExplorerRefresh, onExplorerRescan } from '../../core/ipc/events';
import { useExplorerStore } from './explorerStore';
// 🔴 S14：真实目录监听走 plugin-fs 中心 watcher（引用计数，多视图共用）
import { watchDirectory } from './directoryWatcher';

/**
 * 文件监听 hook
 * 跟随 root 切换 watch_dir / unwatch_dir
 */
export function useWatcher() {
  const root = useExplorerStore((s) => s.root);
  const updateChildren = useExplorerStore((s) => s.updateChildren);
  const rescan = useExplorerStore((s) => s.rescan);
  const prevRootRef = useRef<string | null>(null);

  // 监听 root 变化 → 切换 watch（中心 watcher 引用计数；卸载时 release）
  useEffect(() => {
    if (!root) return;
    const release = watchDirectory(root);
    prevRootRef.current = root;
    return () => {
      release();
      prevRootRef.current = null;
    };
  }, [root]);

  // 监听刷新事件
  useEffect(() => {
    const unlistenRefresh = onExplorerRefresh(async ({ dir }) => {
      // 增量刷新：重新加载该目录的子节点
      try {
        const showHidden = true; // 从设置 store 取，但这里简化
        const children = await ipc.readDir(dir, showHidden);
        updateChildren(dir, children);
      } catch (e) {
        console.error('增量刷新失败:', dir, e);
      }
    });

    const unlistenRescan = onExplorerRescan(async ({ root: rescanRoot }) => {
      // 全量重扫
      try {
        const showHidden = true;
        const children = await ipc.readDir(rescanRoot, showHidden);
        rescan(children);
      } catch (e) {
        console.error('全量重扫失败:', rescanRoot, e);
      }
    });

    return () => {
      unlistenRefresh.then((fn) => fn());
      unlistenRescan.then((fn) => fn());
    };
  }, [updateChildren, rescan]);

}
