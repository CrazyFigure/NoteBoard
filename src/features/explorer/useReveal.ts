// NoteBoard 资源管理器：纯跟随 + Reveal
// 激活 tab 变化 → root 切换 → 展开路径链 → 高亮目标文件
// 详见 docs/05-ADR/ADR-007-资源管理器语义.md
// 详见 docs/09-开发路线图.md 5.3/5.4

import { useEffect, useRef } from 'react';
import { useExplorerStore, sameKey } from './explorerStore';
import { useWindowStore } from '../../stores/windowStore';
import { useDocumentStore } from '../../stores/documentStore';
import { useTreeData } from './useTreeData';

/**
 * 纯跟随 + Reveal 逻辑
 * 当 active tab 变化时，根据文档的 dirPath 切换 explorer root
 */
export function useReveal() {
  const activeKey = useWindowStore((s) => s.activeKey);
  const doc = useDocumentStore((s) => (activeKey ? s.documents.get(activeKey) : undefined));
  const { root, setRoot, setRevealed, revealed } = useExplorerStore();
  const { loadChildren, revealPath } = useTreeData();
  const prevRootRef = useRef<string | null>(null);

  useEffect(() => {
    if (!doc) return;

    const newRoot = doc.dirPath;
    if (!newRoot) return;

    // 不变式 I-16：跨目录时清空 expanded/children
    if (!sameKey(root, newRoot)) {
      // 跨目录 → 重建树
      loadChildren(newRoot).then((children) => {
        setRoot(newRoot, children);
        // 然后展开到目标文件
        if (doc.key) {
          revealPath(doc.key, newRoot).then(() => {
            setRevealed(doc.key);
          });
        }
      });
    } else {
      // 同目录 → 只更新 revealed
      if (doc.key && doc.key !== revealed) {
        revealPath(doc.key, newRoot).then(() => {
          setRevealed(doc.key);
        });
      }
    }

    prevRootRef.current = newRoot;
  }, [doc?.dirPath, doc?.key, root, revealed, setRoot, setRevealed, loadChildren, revealPath]);
}
