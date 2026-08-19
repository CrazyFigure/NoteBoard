// NoteBoard 资源管理器：树节点
// 24px 行高、depth*12+8 缩进、缩进导线、图标、悬停、当前 tab 高亮
// 详见 docs/07-UI布局与交互规范.md §5.1

import { memo, useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  FileText,
  ExternalLink,
  Copy,
  Trash2,
} from 'lucide-react';
import type { FileTreeNode } from '../../core/ipc/types';
import { useExplorerStore } from './explorerStore';
import { useTreeData } from './useTreeData';
import { openDocument } from '../editor-code/orchestration/openDocument';
import { getExplorerFileIcon } from './fileIcons';
import * as ipc from '../../core/ipc/commands';

interface TreeNodeProps {
  node: FileTreeNode;
  depth: number;
  isLast: boolean;
}

// ── 单节点渲染 ──

export const TreeNode = memo(function TreeNode({
  node,
  depth,
}: TreeNodeProps) {
  const { toggle, loadChildren } = useTreeData();
  const nodeKey = node.path.toLowerCase();

  // 精确响应式订阅：当前节点的展开状态、子节点缓存、高亮状态以及定位滚动触发计数
  const isNodeExpanded = useExplorerStore((s) => s.expanded.has(nodeKey));
  const children = useExplorerStore((s) => s.children.get(nodeKey));
  const isRevealed = useExplorerStore((s) => (s.revealed ? s.revealed.toLowerCase() === nodeKey : false));
  const revealCount = useExplorerStore((s) => s.revealCount);
  const setRevealed = useExplorerStore((s) => s.setRevealed);
  const root = useExplorerStore((s) => s.root);
  const setRoot = useExplorerStore((s) => s.setRoot);

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const lastScrolledCountRef = useRef<number>(-1);

  // 当当前节点处于高亮状态且定位计数更新时，平滑滚动至视口可见位置
  useEffect(() => {
    if (isRevealed && rowRef.current && lastScrolledCountRef.current !== revealCount) {
      lastScrolledCountRef.current = revealCount;
      rowRef.current.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [isRevealed, revealCount]);

  const expanded = node.isDir ? isNodeExpanded : false;

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

  // 树节点行样式（通过 CSS 变量动态响应排版设置与 Ctrl+滚轮缩放）
  const rowStyle: React.CSSProperties = {
    height: 'var(--explorer-item-height, 24px)',
    minHeight: 'var(--explorer-item-height, 24px)',
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
    fontSize: 'var(--explorer-font-size, 13px)',
    fontFamily: 'var(--explorer-font-family, inherit)',
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

  // 单击条目：文件则仅选中高亮（不打开文件）；文件夹则选中并展开/收起目录
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // 用户手动点击条目本身已在可视区域内，仅设置高亮不触发额外滚动
    setRevealed(node.path, false);
    if (node.isDir) {
      toggle(node.path);
    }
  };

  // 双击条目：文件则打开文档并激活 Tab
  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!node.isDir) {
      openDocument(node.path);
    }
  };

  // 单击展开/折叠箭头图标
  const handleArrowClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRevealed(node.path, false);
    toggle(node.path);
  };

  // 右键条目：先将条目设为选中，再弹出菜单
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRevealed(node.path, false);
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
        ref={rowRef}
        style={rowStyle}
        onMouseEnter={handleHover}
        onMouseLeave={handleLeave}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        title={node.path}
      >
        {/* 展开箭头 */}
        {node.isDir ? (
          <span
            onClick={handleArrowClick}
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

        {/* 文件/目录优雅图标 */}
        {getExplorerFileIcon(node.path, {
          isDir: node.isDir,
          isOpen: expanded,
          size: 14,
        })}

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

