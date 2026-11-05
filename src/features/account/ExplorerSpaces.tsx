// 资源管理器顶部的“我的笔记 / 共享给我”切换（仅网页多用户）。各自记住上次浏览的目录。
import { useEffect, useRef } from 'react';
import { FolderClosed, Users } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { useExplorerStore } from '../explorer/explorerStore';
import { useTreeData } from '../explorer/useTreeData';
import { showToast } from '../../stores/toastStore';
import { pathExists } from '../../core/ipc/commands';
import { SHARED_ROOT, isSharedPath } from './accountState';
import './account.css';

const OWN_ROOT = '/workspace';

export function ExplorerSpaces({ root }: { root: string | null }) {
  const { setRoot, setRevealed } = useExplorerStore();
  const { loadChildren } = useTreeData();
  const last = useRef({ own: OWN_ROOT, shared: SHARED_ROOT });
  const inShared = isSharedPath(root);

  useEffect(() => {
    if (!root) return;
    if (isSharedPath(root)) last.current.shared = root;
    else if (root === OWN_ROOT || root.startsWith(`${OWN_ROOT}/`)) last.current.own = root;
  }, [root]);

  const go = async (shared: boolean) => {
    if (shared === inShared) return;
    const base = shared ? SHARED_ROOT : OWN_ROOT;
    const remembered = shared ? last.current.shared : last.current.own;
    try {
      // 上次的目录可能已被删除或取消共享，失败时回到该空间的根目录。
      const valid = remembered !== base && await pathExists(remembered).then((result) => result.exists && result.isDir, () => false);
      const target = valid ? remembered : base;
      setRoot(target, await loadChildren(target));
      setRevealed('');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  return (
    <div className="nb-explorer-spaces" role="tablist" aria-label="文件空间">
      <Tooltip content="仅自己可见的笔记" side="bottom" sideOffset={4}>
        <button type="button" role="tab" aria-selected={!inShared} className={`nb-explorer-space${inShared ? '' : ' is-active'}`} onClick={() => void go(false)}>
          <FolderClosed size={13} />
          <span>我的笔记</span>
        </button>
      </Tooltip>
      <Tooltip content="他人共享给你的文件" side="bottom" sideOffset={4}>
        <button type="button" role="tab" aria-selected={inShared} className={`nb-explorer-space${inShared ? ' is-active' : ''}`} onClick={() => void go(true)}>
          <Users size={13} />
          <span>共享给我</span>
        </button>
      </Tooltip>
    </div>
  );
}
