// NoteBoard 资源管理器
// 单根纯跟随目录树 + 文件操作 + 实时监听
// 详见 docs/07-UI布局与交互规范.md §5
// 详见 docs/09-开发路线图.md 阶段5

import { useState, useCallback } from 'react';
import { FilePlus, FolderPlus, RotateCw, FolderOpen } from 'lucide-react';
import { useExplorerStore } from './explorerStore';
import { useTreeData } from './useTreeData';
import { useReveal } from './useReveal';
import { useWatcher } from './useWatcher';
import { TreeNode } from './TreeNode';
import { openFolderDialog } from '../welcome/welcomeActions';
import * as ipc from '../../core/ipc/commands';
import { openDocument } from '../editor-code/orchestration/openDocument';

// ── 根路径中间省略 ──

function middleEllipsis(path: string, maxLen: number = 36): string {
  if (path.length <= maxLen) return path;
  const drive = path.match(/^[A-Za-z]:\\/);
  const drivePart = drive ? drive[0] : '';
  const last = path.split(/[\\/]/).pop() ?? '';
  const remaining = maxLen - drivePart.length - last.length - 3;
  if (remaining <= 0) return '…' + last;
  return `${drivePart}…${path.slice(path.length - remaining - last.length)}`;
}

// ── Explorer 组件 ──

export function Explorer() {
  const { root, children, loading, setRoot } = useExplorerStore();
  const { loadChildren } = useTreeData();
  const [creatingType, setCreatingType] = useState<'file' | 'folder' | null>(null);
  const [creatingName, setCreatingName] = useState('');

  // 纯跟随 + Reveal
  useReveal();

  // 文件监听
  useWatcher();

  const rootChildren = root ? children.get(root.toLowerCase()) : undefined;

  // 刷新目录
  const handleRefresh = useCallback(async () => {
    if (root) {
      const nodes = await loadChildren(root);
      setRoot(root, nodes);
    }
  }, [root, loadChildren, setRoot]);

  // 提交新建文件/文件夹
  const handleCreateSubmit = async () => {
    const name = creatingName.trim();
    if (!root || !name) {
      setCreatingType(null);
      setCreatingName('');
      return;
    }

    try {
      if (creatingType === 'file') {
        const payload = await ipc.createFile(root, name, '');
        await handleRefresh();
        if (payload?.key) {
          await openDocument(payload.key);
        }
      } else if (creatingType === 'folder') {
        await ipc.createDir(root, name);
        await handleRefresh();
      }
    } catch (err) {
      console.error('创建失败:', err);
    }

    setCreatingType(null);
    setCreatingName('');
  };

  const containerStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--explorer-bg)',
    overflow: 'hidden',
  };

  if (!root) {
    return (
      <div style={containerStyle}>
        <div
          style={{
            padding: '24px 16px',
            fontSize: 12,
            color: 'var(--explorer-text-muted)',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span>打开文件夹以浏览文件</span>
          <button
            type="button"
            onClick={openFolderDialog}
            style={{
              padding: '6px 12px',
              border: '1px solid var(--editor-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--editor-surface)',
              color: 'var(--editor-text)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            打开文件夹
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} role="tree">
      {/* 标题行 */}
      <div
        style={{
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px',
          borderBottom: '1px solid var(--explorer-border)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--explorer-text)',
          }}
        >
          资源管理器
        </span>
        <div style={{ display: 'flex', gap: 2 }}>
          <button
            type="button"
            onClick={() => {
              setCreatingType('file');
              setCreatingName('');
            }}
            style={actionBtnStyle}
            title="新建文件"
          >
            <FilePlus size={13} />
          </button>
          <button
            type="button"
            onClick={() => {
              setCreatingType('folder');
              setCreatingName('');
            }}
            style={actionBtnStyle}
            title="新建文件夹"
          >
            <FolderPlus size={13} />
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            style={actionBtnStyle}
            title="刷新目录"
          >
            <RotateCw size={13} />
          </button>
          <button
            type="button"
            onClick={openFolderDialog}
            style={actionBtnStyle}
            title="打开文件夹"
          >
            <FolderOpen size={13} />
          </button>
        </div>
      </div>

      {/* 根路径显示 */}
      <div
        style={{
          height: 22,
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px',
          flexShrink: 0,
          overflow: 'hidden',
          borderBottom: '1px solid var(--editor-border)',
        }}
        title={root}
      >
        <span
          style={{
            fontSize: 11,
            color: 'var(--explorer-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            width: '100%',
          }}
        >
          {middleEllipsis(root)}
        </span>
      </div>

      {/* 新建文件输入框 */}
      {creatingType && (
        <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--editor-border)' }}>
          <input
            type="text"
            placeholder={creatingType === 'file' ? '文件名 (例如: note.md)' : '文件夹名'}
            value={creatingName}
            autoFocus
            onChange={(e) => setCreatingName(e.target.value)}
            onBlur={handleCreateSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleCreateSubmit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setCreatingType(null);
                setCreatingName('');
              }
            }}
            style={{
              width: '100%',
              padding: '3px 6px',
              fontSize: 12,
              border: '1px solid var(--editor-accent)',
              borderRadius: 2,
              background: 'var(--editor-surface)',
              color: 'var(--editor-text)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
      )}

      {/* 树内容 */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          position: 'relative',
        }}
      >
        {loading && (
          <div
            style={{
              position: 'absolute',
              top: 4,
              right: 8,
              fontSize: 11,
              color: 'var(--explorer-text-muted)',
            }}
          >
            加载中…
          </div>
        )}
        {rootChildren && rootChildren.length > 0 ? (
          rootChildren.map((node, i) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              isLast={i === rootChildren.length - 1}
            />
          ))
        ) : (
          <div
            style={{
              padding: '8px 12px',
              fontSize: 12,
              color: 'var(--explorer-text-muted)',
            }}
          >
            空文件夹
          </div>
        )}
      </div>
    </div>
  );
}

const actionBtnStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--explorer-text-muted)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 4,
  borderRadius: 3,
  transition: 'color var(--transition-fast)',
};

