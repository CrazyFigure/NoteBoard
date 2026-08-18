// NoteBoard 资源管理器：树节点
// 24px 行高、depth*12+8 缩进、缩进导线、图标、悬停、当前 tab 高亮
// 详见 docs/07-UI布局与交互规范.md §5.1

import { memo, useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  FileText,
  File,
  Database,
  Braces,
  FileCode,
  CodeXml,
  PencilRuler,
  FileQuestion,
  Folder,
  FolderOpen,
  ExternalLink,
  Copy,
  Trash2,
} from 'lucide-react';
import type { FileTreeNode } from '../../core/ipc/types';
import { extFromPath, kindFromPath } from '../../core/docKind';
import { useExplorerStore } from './explorerStore';
import { useTreeData } from './useTreeData';
import { openDocument } from '../editor-code/orchestration/openDocument';
import * as ipc from '../../core/ipc/commands';

interface TreeNodeProps {
  node: FileTreeNode;
  depth: number;
  isLast: boolean;
}

// ── 文件图标 ──

function getFileIcon(node: FileTreeNode) {
  const ext = node.isDir ? '' : extFromPath(node.name);
  const iconProps = { size: 14, style: { flexShrink: 0 } };

  if (node.isDir) return <Folder {...iconProps} color="var(--explorer-text-muted)" />;

  const kind = kindFromPath(node.name);
  if (kind === 'unsupported' && ext !== 'txt' && ext !== 'log') {
    return <FileQuestion {...iconProps} color="var(--explorer-text-muted)" />;
  }

  switch (ext) {
    case 'md':
    case 'markdown':
      return <FileText {...iconProps} color="var(--editor-accent)" />;
    case 'txt':
    case 'log':
      return <File {...iconProps} color="var(--explorer-text-muted)" />;
    case 'sql':
      return <Database {...iconProps} color="var(--editor-accent)" />;
    case 'json':
      return <Braces {...iconProps} color="var(--warning-600)" />;
    case 'yaml':
    case 'yml':
      return <FileCode {...iconProps} color="var(--success-600)" />;
    case 'xml':
      return <CodeXml {...iconProps} color="var(--editor-accent)" />;
    case 'excalidraw':
    case 'board':
    case 'canvas':
      return <PencilRuler {...iconProps} color="var(--accent-strong)" />;
    default:
      return <File {...iconProps} color="var(--explorer-text-muted)" />;
  }
}

// ── 单节点渲染 ──

export const TreeNode = memo(function TreeNode({
  node,
  depth,
}: TreeNodeProps) {
  const { toggle, isExpanded, getChildren, loadChildren } = useTreeData();
  const revealed = useExplorerStore((s) => s.revealed);
  const root = useExplorerStore((s) => s.root);
  const setRoot = useExplorerStore((s) => s.setRoot);

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const expanded = node.isDir ? isExpanded(node.path) : false;
  const children = node.isDir ? getChildren(node.path) : undefined;
  const isRevealed = revealed?.toLowerCase() === node.path.toLowerCase();

  const paddingLeft = depth * 12 + 8;

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!menuPos) return;
    const handleDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuPos(null);
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [menuPos]);

  const rowStyle: React.CSSProperties = {
    height: 24,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    paddingLeft,
    paddingRight: 8,
    cursor: 'pointer',
    userSelect: 'none',
    background: isRevealed ? 'var(--explorer-active)' : 'transparent',
    borderLeft: isRevealed ? '2px solid var(--accent-strong)' : '2px solid transparent',
    color: 'var(--explorer-text)',
    fontSize: 13,
    whiteSpace: 'nowrap',
  };

  const handleHover = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isRevealed) {
      e.currentTarget.style.background = 'var(--explorer-hover)';
    }
  };

  const handleLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isRevealed) {
      e.currentTarget.style.background = 'transparent';
    }
  };

  const handleClick = () => {
    if (node.isDir) {
      toggle(node.path);
    } else {
      openDocument(node.path);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const refreshParent = async () => {
    if (root) {
      const nodes = await loadChildren(root);
      setRoot(root, nodes);
    }
  };

  return (
    <div role="treeitem" aria-expanded={node.isDir ? expanded : undefined} aria-level={depth + 1}>
      <div
        style={rowStyle}
        onMouseEnter={handleHover}
        onMouseLeave={handleLeave}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={node.path}
      >
        {/* 展开箭头 */}
        {node.isDir ? (
          <span
            style={{
              width: 12,
              height: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transform: expanded ? 'rotate(90deg)' : 'none',
              transition: 'transform var(--transition-fast)',
            }}
          >
            <ChevronRight size={12} color="var(--explorer-text-muted)" />
          </span>
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}

        {/* 文件/目录图标 */}
        {expanded && node.isDir ? (
          <FolderOpen size={14} style={{ flexShrink: 0 }} color="var(--explorer-text-muted)" />
        ) : (
          getFileIcon(node)
        )}

        {/* 文件名 */}
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {node.name}
        </span>
      </div>

      {/* 右键上下文菜单 */}
      {menuPos && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: menuPos.y,
            left: menuPos.x,
            zIndex: 9999,
            background: 'var(--editor-surface)',
            border: '1px solid var(--editor-border)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)',
            padding: '4px 0',
            minWidth: 160,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {!node.isDir && (
            <button
              type="button"
              style={menuItemStyle}
              onClick={() => {
                setMenuPos(null);
                openDocument(node.path);
              }}
            >
              <FileText size={13} />
              <span>打开文件</span>
            </button>
          )}
          <button
            type="button"
            style={menuItemStyle}
            onClick={() => {
              setMenuPos(null);
              ipc.revealInExplorer(node.path);
            }}
          >
            <ExternalLink size={13} />
            <span>在文件管理器中定位</span>
          </button>
          <button
            type="button"
            style={menuItemStyle}
            onClick={() => {
              setMenuPos(null);
              navigator.clipboard.writeText(node.path);
            }}
          >
            <Copy size={13} />
            <span>复制完整路径</span>
          </button>
          <div style={{ height: 1, background: 'var(--editor-border)', margin: '4px 0' }} />
          <button
            type="button"
            style={{ ...menuItemStyle, color: 'var(--error-500)' }}
            onClick={async () => {
              setMenuPos(null);
              try {
                await ipc.moveToTrash(node.path);
                await refreshParent();
              } catch (err) {
                console.error('删除失败:', err);
              }
            }}
          >
            <Trash2 size={13} />
            <span>移至回收站</span>
          </button>
        </div>
      )}

      {/* 子节点 */}
      {expanded && children && children.length > 0 && (
        <div role="group">
          {children.map((child, i) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              isLast={i === children.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
});

const menuItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 12px',
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  cursor: 'pointer',
  fontSize: 12,
  color: 'var(--editor-text)',
};

