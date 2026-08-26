// NoteBoard 资源管理器：树节点
// 24px 行高、depth*12+8 缩进、缩进导线、图标、悬停、当前 tab 高亮、行内重命名与右键菜单
// 详见 docs/07-UI布局与交互规范.md §5.1

import React, { memo, useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  FileText,
  ExternalLink,
  Copy,
  Trash2,
  Edit2,
  FilePlus,
  FolderPlus,
} from 'lucide-react';
import type { FileTreeNode } from '../../core/ipc/types';
import { useExplorerStore } from './explorerStore';
import { useTreeData } from './useTreeData';
import { openDocument } from '../editor-code/orchestration/openDocument';
import { markOpenDocumentDeleted } from '../external/missingFileGuard';
import { getExplorerFileIcon } from './fileIcons';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
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
  const expand = useExplorerStore((s) => s.expand);
  const nodeKey = node.path.toLowerCase();

  // 精确响应式订阅：当前节点的展开状态、子节点缓存、高亮状态以及定位滚动触发计数
  const isNodeExpanded = useExplorerStore((s) => s.expanded.has(nodeKey));
  const children = useExplorerStore((s) => s.children.get(nodeKey));
  const isRevealed = useExplorerStore((s) => (s.revealed ? s.revealed.toLowerCase() === nodeKey : false));
  const revealCount = useExplorerStore((s) => s.revealCount);
  const setRevealed = useExplorerStore((s) => s.setRevealed);
  const root = useExplorerStore((s) => s.root);
  const setRoot = useExplorerStore((s) => s.setRoot);

  // 重命名状态
  const [isRenaming, setIsRenaming] = useState(false);
  const [editName, setEditName] = useState(node.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // 目录内直接新建子项状态
  const [creatingSub, setCreatingSub] = useState<'file' | 'folder' | null>(null);
  const [creatingSubName, setCreatingSubName] = useState('');
  const subInputRef = useRef<HTMLInputElement>(null);

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

  // 重命名模式开启时自动聚焦并智能选中文本（文件默认仅选中主文件名，不包含扩展名）
  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      if (!node.isDir) {
        const lastDot = node.name.lastIndexOf('.');
        if (lastDot > 0) {
          inputRef.current.setSelectionRange(0, lastDot);
          return;
        }
      }
      inputRef.current.select();
    }
  }, [isRenaming, node.isDir, node.name]);

  // 新建子项模式开启时自动聚焦输入框
  useEffect(() => {
    if (creatingSub && subInputRef.current) {
      subInputRef.current.focus();
    }
  }, [creatingSub]);

  // 当 node.name 外部变动且未处于编辑中时同步本地编辑态名称
  useEffect(() => {
    if (!isRenaming) {
      setEditName(node.name);
    }
  }, [node.name, isRenaming]);

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
    outline: 'none',
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

  // 右键条目：先将条目设为选中，计算防溢出坐标后再弹出菜单
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRevealed(node.path, false);
    const menuWidth = 180;
    const menuHeight = node.isDir ? 230 : 190;
    const x = e.clientX + menuWidth > window.innerWidth ? Math.max(8, e.clientX - menuWidth) : e.clientX;
    const y = e.clientY + menuHeight > window.innerHeight ? Math.max(8, e.clientY - menuHeight) : e.clientY;
    setMenuPos({ x, y });
  };

  // 按键响应：支持 F2 快捷键直接进入重命名
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'F2') {
      e.preventDefault();
      e.stopPropagation();
      setIsRenaming(true);
    }
  };

  // 刷新当前节点的父目录或根目录
  const refreshParent = async () => {
    const lastSlash = node.path.lastIndexOf('\\');
    const parentDir = lastSlash > 0 ? node.path.substring(0, lastSlash) : '';
    if (parentDir) {
      const parentNodes = await loadChildren(parentDir);
      useExplorerStore.getState().updateChildren(parentDir, parentNodes);
    } else if (root) {
      const nodes = await loadChildren(root);
      setRoot(root, nodes);
    }
  };

  // 提交重命名
  const handleRenameSubmit = async () => {
    const trimmed = editName.trim();
    // 未改变或空操作直接退出
    if (!trimmed || trimmed === node.name) {
      setIsRenaming(false);
      setEditName(node.name);
      return;
    }

    // 校验 Windows 命名限制非法字符: \ / : * ? " < > |
    if (/[\\/:*?"<>|]/.test(trimmed)) {
      showToast('文件名不能包含下列任何字符: \\ / : * ? " < > |', 'error');
      setIsRenaming(false);
      setEditName(node.name);
      return;
    }

    // 计算父目录与新完整路径
    const lastSlash = node.path.lastIndexOf('\\');
    const parentDir = lastSlash > 0 ? node.path.substring(0, lastSlash) : '';
    const newPath = parentDir ? `${parentDir}\\${trimmed}` : trimmed;

    try {
      await ipc.renamePath(node.path, newPath);

      if (!node.isDir) {
        // 单文件：同步迁移已打开文档 store 与 Tab 标签页
        useDocumentStore.getState().renameDocument(node.path, newPath, trimmed, parentDir);
        useWindowStore.getState().updateTabPath(node.path, newPath, trimmed);
        if (isRevealed) {
          setRevealed(newPath, false);
        }
      } else {
        // 目录：批量迁移该目录下所有已打开文档与 Tab
        useDocumentStore.getState().renameDirectory(node.path, newPath);
        useWindowStore.getState().renameTabsDirectory(node.path, newPath);
      }

      // 刷新父目录以更新左侧文件树
      if (parentDir) {
        const parentNodes = await loadChildren(parentDir);
        useExplorerStore.getState().updateChildren(parentDir, parentNodes);
      } else if (root) {
        const rootNodes = await loadChildren(root);
        setRoot(root, rootNodes);
      }
    } catch (error: unknown) {
      // 将 Rust 与 JavaScript 的不同异常形态统一转换为用户可读消息。
      console.error('重命名失败:', error);
      showToast(typeof error === 'string' ? error : error instanceof Error ? error.message : '重命名失败', 'error');
    } finally {
      setIsRenaming(false);
    }
  };

  // 提交目录内新建子项（文件或文件夹）
  const handleCreateSubSubmit = async () => {
    const name = creatingSubName.trim();
    if (!name) {
      setCreatingSub(null);
      setCreatingSubName('');
      return;
    }

    try {
      if (creatingSub === 'file') {
        const payload = await ipc.createFile(node.path, name, '');
        const newChildren = await loadChildren(node.path);
        useExplorerStore.getState().updateChildren(node.path, newChildren);
        if (payload?.key) {
          await openDocument(payload.key);
        }
      } else if (creatingSub === 'folder') {
        await ipc.createDir(node.path, name);
        const newChildren = await loadChildren(node.path);
        useExplorerStore.getState().updateChildren(node.path, newChildren);
      }
    } catch (error: unknown) {
      // 将 Rust 与 JavaScript 的不同异常形态统一转换为用户可读消息。
      console.error('创建子项失败:', error);
      showToast(typeof error === 'string' ? error : error instanceof Error ? error.message : '创建失败', 'error');
    } finally {
      setCreatingSub(null);
      setCreatingSubName('');
    }
  };

  return (
    <div role="treeitem" aria-expanded={node.isDir ? expanded : undefined} aria-level={depth + 1}>
      <div
        ref={rowRef}
        style={rowStyle}
        tabIndex={0}
        onMouseEnter={handleHover}
        onMouseLeave={handleLeave}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
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

        {/* 文件名或行内重命名输入框 */}
        {isRenaming ? (
          <input
            ref={inputRef}
            type="text"
            value={editName}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                handleRenameSubmit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setIsRenaming(false);
                setEditName(node.name);
              }
            }}
            style={{
              flex: 1,
              padding: '1px 4px',
              fontSize: 'inherit',
              fontFamily: 'inherit',
              border: '1px solid var(--editor-accent)',
              borderRadius: 2,
              background: 'var(--editor-surface)',
              color: 'var(--editor-text)',
              outline: 'none',
              height: 'calc(var(--explorer-item-height, 24px) - 6px)',
              minWidth: 60,
              boxSizing: 'border-box',
            }}
          />
        ) : (
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {node.name}
          </span>
        )}
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
            padding: '4px',
            minWidth: 175,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 文件特有菜单项：打开文件 */}
          {!node.isDir && (
            <ContextMenuItem
              icon={FileText}
              label="打开文件"
              onClick={() => {
                setMenuPos(null);
                openDocument(node.path);
              }}
            />
          )}

          {/* 目录特有菜单项：在此新建文件与新建文件夹 */}
          {node.isDir && (
            <>
              <ContextMenuItem
                icon={FilePlus}
                label="新建文件"
                onClick={async () => {
                  setMenuPos(null);
                  if (!expanded) {
                    const ch = await loadChildren(node.path);
                    expand(node.path, ch);
                  }
                  setCreatingSub('file');
                  setCreatingSubName('');
                }}
              />
              <ContextMenuItem
                icon={FolderPlus}
                label="新建文件夹"
                onClick={async () => {
                  setMenuPos(null);
                  if (!expanded) {
                    const ch = await loadChildren(node.path);
                    expand(node.path, ch);
                  }
                  setCreatingSub('folder');
                  setCreatingSubName('');
                }}
              />
              <div style={{ height: 1, background: 'var(--editor-border)', margin: '4px 0' }} />
            </>
          )}

          {/* 重命名 */}
          <ContextMenuItem
            icon={Edit2}
            label="重命名"
            shortcut="F2"
            onClick={() => {
              setMenuPos(null);
              setIsRenaming(true);
            }}
          />

          {/* 在文件资源管理器中定位 */}
          <ContextMenuItem
            icon={ExternalLink}
            label="在文件管理器中定位"
            onClick={() => {
              setMenuPos(null);
              ipc.revealInExplorer(node.path);
            }}
          />

          {/* 复制完整路径 */}
          <ContextMenuItem
            icon={Copy}
            label="复制完整路径"
            onClick={() => {
              setMenuPos(null);
              navigator.clipboard.writeText(node.path);
            }}
          />

          <div style={{ height: 1, background: 'var(--editor-border)', margin: '4px 0' }} />

          {/* 移至回收站 */}
          <ContextMenuItem
            icon={Trash2}
            label="移至回收站"
            danger
            onClick={async () => {
              setMenuPos(null);
              try {
                await ipc.moveToTrash(node.path);
                // 左侧栏删除已打开文件时立即标记，无需等待下一次焦点检查。
                markOpenDocumentDeleted(node.path);
                await refreshParent();
              } catch (err) {
                console.error('删除失败:', err);
              }
            }}
          />
        </div>
      )}

      {/* 目录内新建子项输入框 */}
      {creatingSub && (
        <div
          style={{
            paddingLeft: paddingLeft + 16,
            paddingRight: 8,
            paddingTop: 2,
            paddingBottom: 2,
          }}
        >
          <input
            ref={subInputRef}
            type="text"
            placeholder={creatingSub === 'file' ? '文件名 (例如: doc.sql)' : '文件夹名'}
            value={creatingSubName}
            onChange={(e) => setCreatingSubName(e.target.value)}
            onBlur={handleCreateSubSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleCreateSubSubmit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setCreatingSub(null);
                setCreatingSubName('');
              }
            }}
            style={{
              width: '100%',
              padding: '2px 4px',
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

      {/* 子节点递归渲染 */}
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

// ── 右键菜单项组件（具备 Hover/Active 反馈与快捷键标签） ──

function ContextMenuItem({
  icon: Icon,
  label,
  shortcut,
  danger,
  onClick,
}: {
  icon: React.ComponentType<{ size: number; color?: string; style?: React.CSSProperties }>;
  label: string;
  shortcut?: string;
  danger?: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        padding: '6px 10px',
        background: 'transparent',
        border: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        fontSize: 12,
        color: danger ? 'var(--error-500, #ef4444)' : 'var(--editor-text)',
        borderRadius: 'var(--radius-xs, 3px)',
        transition: 'background var(--transition-fast), transform var(--transition-fast)',
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--toolbar-hover, rgba(125, 125, 125, 0.12))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
      onMouseDown={(e) => {
        e.currentTarget.style.background = 'var(--toolbar-active, rgba(125, 125, 125, 0.2))';
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.background = 'var(--toolbar-hover, rgba(125, 125, 125, 0.12))';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon size={13} style={{ flexShrink: 0 }} />
        <span>{label}</span>
      </div>
      {shortcut && (
        <span style={{ fontSize: 10, color: 'var(--editor-text-muted)', marginLeft: 16 }}>
          {shortcut}
        </span>
      )}
    </button>
  );
}

