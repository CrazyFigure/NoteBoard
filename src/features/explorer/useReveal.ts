// NoteBoard 资源管理器：纯跟随 + Reveal
// 激活 tab 变化 → root 切换 → 展开路径链 → 高亮目标文件
// 详见 docs/05-ADR/ADR-007-资源管理器语义.md
// 详见 docs/09-开发路线图.md 5.3/5.4

import { useEffect, useRef } from 'react';
import { useExplorerStore, isSubPath } from './explorerStore';
import { useWindowStore } from '../../stores/windowStore';
import { useDocumentStore } from '../../stores/documentStore';
import { useTreeData } from './useTreeData';

/**
 * 纯跟随 + Reveal 逻辑
 * 当 active tab 变化时，若已在当前根目录内则在树中展开并平滑滚动定位，若跨根目录则切换 root 并展开定位
 */
export function useReveal() {
  const activeKey = useWindowStore((s) => s.activeKey);
  const doc = useDocumentStore((s) => (activeKey ? s.documents.get(activeKey) : undefined));
  const { setRoot, setRevealed } = useExplorerStore();
  const { loadChildren, revealPath } = useTreeData();
  const lastActiveKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeKey || !doc || activeKey.startsWith('untitled:')) {
      lastActiveKeyRef.current = activeKey;
      return;
    }

    const newDir = doc.dirPath;
    const filePath = doc.key;
    if (!newDir || !filePath) return;

    // 当 activeKey 发生切换时，触发跟随与展开定位
    const isTabSwitched = lastActiveKeyRef.current !== activeKey;
    lastActiveKeyRef.current = activeKey;

    if (isTabSwitched) {
      const currentRoot = useExplorerStore.getState().root;
      if (currentRoot && isSubPath(currentRoot, filePath)) {
        // 当前根目录已包含该文件 → 保持根目录树，逐级展开并平滑滚动高亮目标文件
        revealPath(filePath, currentRoot).then(() => {
          if (useWindowStore.getState().activeKey === activeKey) {
            setRevealed(filePath, true);
          }
        });
      } else {
        // 跨根目录或尚未设定根目录 → 切换根目录为目标所在文件夹并展开定位
        loadChildren(newDir).then((children) => {
          if (useWindowStore.getState().activeKey === activeKey) {
            setRoot(newDir, children);
            revealPath(filePath, newDir).then(() => {
              if (useWindowStore.getState().activeKey === activeKey) {
                setRevealed(filePath, true);
              }
            });
          }
        });
      }
    }
  }, [activeKey, doc?.dirPath, doc?.key, setRoot, setRevealed, loadChildren, revealPath]);
}
