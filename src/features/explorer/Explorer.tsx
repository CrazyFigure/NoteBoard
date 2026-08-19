// NoteBoard 资源管理器
// 单根纯跟随目录树 + 文件操作 + 实时监听
// 详见 docs/07-UI布局与交互规范.md §5
// 详见 docs/09-开发路线图.md 阶段5

import { useState, useCallback } from 'react';
import { FilePlus, FolderPlus, LocateFixed, RotateCw, FolderOpen } from 'lucide-react';
import { useExplorerStore } from './explorerStore';
import { useTreeData } from './useTreeData';
import { useReveal } from './useReveal';
import { useWatcher } from './useWatcher';
import { TreeNode } from './TreeNode';
import { openFolderDialog } from '../welcome/welcomeActions';
import * as ipc from '../../core/ipc/commands';
import { openDocument } from '../editor-code/orchestration/openDocument';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWindowStore } from '../../stores/windowStore';
import { useDocumentStore } from '../../stores/documentStore';
import { ExplorerBreadcrumb } from './ExplorerBreadcrumb';

// ── Explorer 组件 ──

export function Explorer() {
  const { root, children, loading, setRoot, setRevealed } = useExplorerStore();
  const { loadChildren, revealPath } = useTreeData();
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

  // 一键定位当前打开的文件与目录
  const handleLocateActive = useCallback(async () => {
    const activeKey = useWindowStore.getState().activeKey;
    if (!activeKey) return;
    const doc = useDocumentStore.getState().documents.get(activeKey);
    const targetDir = doc?.dirPath;
    if (!targetDir) return;

    try {
      const nodes = await loadChildren(targetDir);
      setRoot(targetDir, nodes);
      if (doc.key) {
        await revealPath(doc.key, targetDir);
        setRevealed(doc.key);
      }
    } catch (err) {
      console.error('定位当前文件所在目录失败:', err);
    }
  }, [loadChildren, setRoot, revealPath, setRevealed]);

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

  // 支持在文件树区域按住 Ctrl + 鼠标滚轮 实时缩放字号与行高
  const handleTreeWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    const curTypography = useSettingsStore.getState().settings.typography;
    const currentSize = curTypography.explorerFontSize ?? 13;
    const newSize = Math.max(10, Math.min(22, currentSize + delta));
    if (newSize !== currentSize) {
      // 保持合理的条目行高比例（约 1.8 倍字号）
      const newLineHeight = Math.round(newSize * 1.8);
      useSettingsStore.getState().setTypography({
        explorerFontSize: newSize,
        explorerLineHeight: newLineHeight,
      });
    }
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
            padding: '36px 16px',
            fontSize: 13,
            color: 'var(--explorer-text-muted)',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <span>打开文件夹以浏览文件</span>
          {/* 打开文件夹卡片式动作按钮，与主欢迎页风格一致 */}
          <button
            type="button"
            onClick={openFolderDialog}
            className="nb-btn-card"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 8,
              minWidth: 140,
            }}
          >
            <FolderOpen size={16} color="var(--editor-accent)" />
            <span>打开文件夹</span>
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
          height: 30,
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {/* 定位当前激活的文件与目录 */}
          <button
            type="button"
            onClick={handleLocateActive}
            style={actionBtnStyle}
            onMouseEnter={handleBtnMouseEnter}
            onMouseLeave={handleBtnMouseLeave}
            onMouseDown={handleBtnMouseDown}
            onMouseUp={handleBtnMouseUp}
            title="定位当前打开的文件与目录"
          >
            <LocateFixed size={15} />
          </button>
          {/* 新建文件 */}
          <button
            type="button"
            onClick={() => {
              setCreatingType('file');
              setCreatingName('');
            }}
            style={actionBtnStyle}
            onMouseEnter={handleBtnMouseEnter}
            onMouseLeave={handleBtnMouseLeave}
            onMouseDown={handleBtnMouseDown}
            onMouseUp={handleBtnMouseUp}
            title="新建文件"
          >
            <FilePlus size={15} />
          </button>
          {/* 新建文件夹 */}
          <button
            type="button"
            onClick={() => {
              setCreatingType('folder');
              setCreatingName('');
            }}
            style={actionBtnStyle}
            onMouseEnter={handleBtnMouseEnter}
            onMouseLeave={handleBtnMouseLeave}
            onMouseDown={handleBtnMouseDown}
            onMouseUp={handleBtnMouseUp}
            title="新建文件夹"
          >
            <FolderPlus size={15} />
          </button>
          {/* 刷新目录 */}
          <button
            type="button"
            onClick={handleRefresh}
            style={actionBtnStyle}
            onMouseEnter={handleBtnMouseEnter}
            onMouseLeave={handleBtnMouseLeave}
            onMouseDown={handleBtnMouseDown}
            onMouseUp={handleBtnMouseUp}
            title="刷新目录"
          >
            <RotateCw size={15} />
          </button>
          {/* 打开文件夹 */}
          <button
            type="button"
            onClick={openFolderDialog}
            style={actionBtnStyle}
            onMouseEnter={handleBtnMouseEnter}
            onMouseLeave={handleBtnMouseLeave}
            onMouseDown={handleBtnMouseDown}
            onMouseUp={handleBtnMouseUp}
            title="打开文件夹"
          >
            <FolderOpen size={15} />
          </button>
        </div>
      </div>

      {/* 面包屑型路径导航栏 */}
      <ExplorerBreadcrumb root={root} onRefresh={handleRefresh} />

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
        onWheel={handleTreeWheel}
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
  width: 24,
  height: 24,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--explorer-text-muted)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  borderRadius: 4,
  transition: 'all var(--transition-fast)',
};

function handleBtnMouseEnter(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.background = 'var(--toolbar-hover)';
  e.currentTarget.style.color = 'var(--explorer-text)';
  e.currentTarget.style.transform = 'scale(1.05)';
}

function handleBtnMouseLeave(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.background = 'transparent';
  e.currentTarget.style.color = 'var(--explorer-text-muted)';
  e.currentTarget.style.transform = 'scale(1)';
}

function handleBtnMouseDown(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.background = 'var(--toolbar-active)';
  e.currentTarget.style.transform = 'scale(0.92)';
}

function handleBtnMouseUp(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.background = 'var(--toolbar-hover)';
  e.currentTarget.style.transform = 'scale(1.05)';
}



