// NoteBoard 收藏夹管理模态弹窗 (类似 Microsoft Edge 收藏夹管理器)
// 包含左侧目录树与搜索过滤、右侧内容列表、拖拽移动与排序、失效文件优雅警示与打开

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Star,
  Folder,
  FolderOpen,
  FolderPlus,
  Search,
  X,
  ChevronRight,
  ChevronDown,
  Trash2,
  Edit2,
  Plus,
  AlertTriangle,
  FilePlus,
} from 'lucide-react';
import { useFavoritesStore } from './favoritesStore';
import {
  findFolderById,
  searchFavorites,
  isDescendantOrSelf,
} from './favoritesUtils';
import { Tooltip } from '../../components/Tooltip';
import type {
  FavoriteNode,
  FavoriteFolderItem,
  FavoriteFileItem,
} from '../../core/ipc/types';
import { getExplorerFileIcon } from '../explorer/fileIcons';
import { openDocument } from '../editor-code/orchestration/openDocument';
import * as ipc from '../../core/ipc/commands';
import { showToast } from '../../stores/toastStore';
import { open } from '@tauri-apps/plugin-dialog';

export function FavoritesManagerModal() {
  const {
    data,
    managerModalOpen,
    activeFolderId,
    expandedFolderIds,
    searchQuery,
    closeFavoritesModal,
    setActiveFolder,
    toggleFolderExpanded,
    setSearchQuery,
    addFavorite,
    removeFavorite,
    createFolder,
    renameFolder,
    renameFavorite,
    moveItem,
    openAddModal,
  } = useFavoritesStore();

  // 当前重命名状态（节点 ID 与正在编辑的名称）
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  // 新建子文件夹状态
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // 正在拖拽的节点 ID
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  // 拖拽悬停的目标文件夹 ID
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);

  // 文件存在性探测缓存 (path -> boolean)
  const [fileExistenceMap, setFileExistenceMap] = useState<Record<string, boolean>>({});

  // 文件夹右键菜单状态
  const [folderContextMenu, setFolderContextMenu] = useState<{
    x: number;
    y: number;
    folderId: string;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 监听 Escape 键关闭
  useEffect(() => {
    if (!managerModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (folderContextMenu) {
          setFolderContextMenu(null);
        } else if (editingNodeId) {
          setEditingNodeId(null);
        } else if (isCreatingFolder) {
          setIsCreatingFolder(false);
        } else {
          closeFavoritesModal();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [managerModalOpen, folderContextMenu, editingNodeId, isCreatingFolder, closeFavoritesModal]);

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!folderContextMenu) return;
    const handleDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setFolderContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [folderContextMenu]);

  // 当前是否处于根目录视图
  const isRootActive = !activeFolderId || activeFolderId === 'root';

  // 当前选中文件夹
  const currentFolder = useMemo(() => {
    if (isRootActive) return null;
    return findFolderById(data.roots, activeFolderId);
  }, [data.roots, activeFolderId, isRootActive]);

  // 当前主列表展示的节点列表
  const currentItems = useMemo<FavoriteNode[]>(() => {
    if (isRootActive) return data.roots;
    return currentFolder?.children || [];
  }, [isRootActive, data.roots, currentFolder]);

  // 搜索匹配结果
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    return searchFavorites(data.roots, searchQuery);
  }, [data.roots, searchQuery]);

  // 异步探测当前视图内所有文件的存在性
  const checkFilesExistence = useCallback(async (files: FavoriteFileItem[]) => {
    const nextMap: Record<string, boolean> = {};
    for (const f of files) {
      if (!f.path) {
        nextMap[f.id] = false;
        continue;
      }
      try {
        const res = await ipc.pathExists(f.path);
        nextMap[f.path] = res.exists && !res.isDir;
      } catch {
        nextMap[f.path] = false;
      }
    }
    setFileExistenceMap((prev) => ({ ...prev, ...nextMap }));
  }, []);

  // 当当前文件夹切换或搜索词变化时探测文件存在性
  useEffect(() => {
    if (!managerModalOpen) return;
    if (searchQuery.trim()) {
      checkFilesExistence(searchResults);
    } else {
      const files = currentItems.filter((c) => c.type === 'file') as FavoriteFileItem[];
      checkFilesExistence(files);
    }
  }, [managerModalOpen, searchQuery, currentItems, searchResults, checkFilesExistence]);

  // 点击打开文件
  const handleOpenFile = async (file: FavoriteFileItem) => {
    if (!file.path) {
      showToast('无效的文件路径', 'warning');
      return;
    }

    try {
      const res = await ipc.pathExists(file.path);
      if (!res.exists || res.isDir) {
        setFileExistenceMap((prev) => ({ ...prev, [file.path]: false }));
        showToast(`文件不存在或已被移动/删除: ${file.path}`, 'warning', 4000);
        return;
      }

      closeFavoritesModal();
      await openDocument(file.path);
    } catch (error) {
      showToast(`打开失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  };

  // 通过系统对话框添加收藏
  const handlePickAndAddFavorite = async () => {
    const paths = await open({
      multiple: true,
      filters: [{ name: '全部文件', extensions: ['*'] }],
    });
    if (!paths || paths.length === 0) return;

    const targetId = isRootActive ? 'root' : currentFolder?.id || 'root';
    for (const p of paths) {
      const defaultName = p.split(/[\\/]/).pop() ?? '文件';
      await addFavorite(targetId, defaultName, p);
    }
    showToast('已添加所选文件到收藏夹', 'success');
  };

  // 确认创建子文件夹
  const handleConfirmCreateFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setIsCreatingFolder(false);
      return;
    }
    const targetId = isRootActive ? 'root' : currentFolder?.id || 'root';
    const createdId = await createFolder(targetId, trimmed);
    setNewFolderName('');
    setIsCreatingFolder(false);
    setActiveFolder(createdId);
  };

  // 确认重命名
  const handleConfirmRename = async () => {
    if (!editingNodeId) return;
    const trimmed = editingName.trim();
    if (trimmed) {
      const folder = findFolderById(data.roots, editingNodeId);
      if (folder) {
        await renameFolder(editingNodeId, trimmed);
      } else {
        await renameFavorite(editingNodeId, trimmed);
      }
    }
    setEditingNodeId(null);
    setEditingName('');
  };

  // 拖拽放置处理
  const handleDropOnFolder = async (targetFolderId: string) => {
    if (!draggedNodeId || draggedNodeId === targetFolderId) {
      setDraggedNodeId(null);
      setDragOverFolderId(null);
      return;
    }

    // 循环防死锁校验
    if (isDescendantOrSelf(data.roots, draggedNodeId, targetFolderId)) {
      showToast('不能将文件夹移动到自身或其子目录中', 'warning');
      setDraggedNodeId(null);
      setDragOverFolderId(null);
      return;
    }

    await moveItem(draggedNodeId, targetFolderId);
    setDraggedNodeId(null);
    setDragOverFolderId(null);
  };

  if (!managerModalOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9992,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(4px)',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          closeFavoritesModal();
        }
      }}
    >
      <div
        style={{
          width: 860,
          maxWidth: '95vw',
          height: 600,
          maxHeight: '90vh',
          background: 'var(--editor-surface, #ffffff)',
          border: '1px solid var(--editor-border, rgba(0, 0, 0, 0.12))',
          borderRadius: 'var(--radius-lg, 10px)',
          boxShadow: '0 20px 45px -10px rgba(0, 0, 0, 0.25), 0 6px 18px -4px rgba(0, 0, 0, 0.1)',
          overflow: 'hidden',
          color: 'var(--editor-text, #1e293b)',
          fontFamily: 'var(--ui-font-family, sans-serif)',
          fontSize: 'var(--ui-font-size, 13px)',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 顶部标题栏 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 18px',
            borderBottom: '1px solid var(--editor-border, rgba(0, 0, 0, 0.08))',
            background: 'var(--editor-bg, #f8fafc)',
            userSelect: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Star size={17} style={{ color: '#f97316', fill: '#f97316' }} />
            <span style={{ fontWeight: 600, fontSize: 15 }}>收藏夹</span>
          </div>
          <Tooltip content="关闭 (Esc)" side="bottom" sideOffset={4}>
            <button
              type="button"
              onClick={closeFavoritesModal}
              aria-label="关闭"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--editor-text-muted, #64748b)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 4,
                borderRadius: 'var(--radius-sm, 4px)',
                transition: 'all var(--transition-fast)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--toolbar-hover, rgba(0, 0, 0, 0.06))';
                e.currentTarget.style.color = 'var(--editor-text, #0f172a)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--editor-text-muted, #64748b)';
              }}
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        {/* 主体两栏布局 */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* 左侧侧边栏：搜索框与层级目录树 */}
          <div
            style={{
              width: 250,
              minWidth: 220,
              borderRight: '1px solid var(--editor-border, rgba(0, 0, 0, 0.08))',
              background: 'var(--editor-bg, #f8fafc)',
              display: 'flex',
              flexDirection: 'column',
              padding: '12px 10px',
              gap: 10,
              userSelect: 'none',
            }}
          >
            {/* 搜索框 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 8px',
                height: 32,
                borderRadius: 'var(--radius-md, 6px)',
                border: '1px solid var(--editor-border, #cbd5e1)',
                background: 'var(--editor-surface, #ffffff)',
                transition: 'all var(--transition-fast)',
              }}
            >
              <Search size={14} style={{ color: 'var(--editor-text-muted)', flexShrink: 0 }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索"
                style={{
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: 'var(--editor-text)',
                  fontSize: 12,
                  width: '100%',
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    color: 'var(--editor-text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {/* 目录树列表 */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                overflowX: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {/* 根目录/全部收藏节点 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: dragOverFolderId === 'root'
                    ? 'var(--accent-surface, rgba(59, 130, 246, 0.15))'
                    : isRootActive
                    ? 'var(--toolbar-active, rgba(0, 0, 0, 0.08))'
                    : 'transparent',
                  border: dragOverFolderId === 'root' ? '1px dashed var(--editor-accent)' : '1px solid transparent',
                  color: isRootActive ? 'var(--editor-accent)' : 'var(--editor-text)',
                  fontWeight: isRootActive ? 600 : 400,
                  transition: 'all var(--transition-fast)',
                  userSelect: 'none',
                }}
                onClick={() => {
                  setSearchQuery('');
                  setActiveFolder('root');
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverFolderId('root');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleDropOnFolder('root');
                }}
                onMouseEnter={(e) => {
                  if (!isRootActive && dragOverFolderId !== 'root') {
                    e.currentTarget.style.background = 'var(--toolbar-hover, rgba(0, 0, 0, 0.04))';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isRootActive && dragOverFolderId !== 'root') {
                    e.currentTarget.style.background = 'transparent';
                  }
                }}
              >
                <Star
                  size={14}
                  style={{
                    color: '#f97316',
                    fill: isRootActive ? '#f97316' : 'none',
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: 13,
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  收藏夹
                </span>
              </div>

              {/* 根目录下的所有子文件夹树 */}
              {data.roots
                .filter((n) => n.type === 'folder')
                .map((rootNode) => (
                  <FolderTreeNode
                    key={rootNode.id}
                    node={rootNode}
                    depth={1}
                    activeFolderId={activeFolderId}
                    expandedFolderIds={expandedFolderIds}
                    dragOverFolderId={dragOverFolderId}
                    onSelectFolder={(id) => {
                      setSearchQuery('');
                      setActiveFolder(id);
                    }}
                    onToggleExpand={toggleFolderExpanded}
                    onContextMenu={(e, folderId) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setFolderContextMenu({ x: e.clientX, y: e.clientY, folderId });
                    }}
                    onDragOver={(folderId) => setDragOverFolderId(folderId)}
                    onDragLeave={() => setDragOverFolderId(null)}
                    onDrop={(folderId) => handleDropOnFolder(folderId)}
                  />
                ))}
            </div>
          </div>

          {/* 右侧主内容区域：当前目录内容与操作 */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              minWidth: 0,
              background: 'var(--editor-surface, #ffffff)',
            }}
          >
            {/* 右侧顶部工具栏 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 18px',
                borderBottom: '1px solid var(--editor-border, rgba(0, 0, 0, 0.08))',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                {searchQuery ? (
                  <span style={{ fontWeight: 600, fontSize: 14 }}>搜索结果</span>
                ) : isRootActive ? (
                  <>
                    <Star size={16} style={{ color: '#f97316', fill: '#f97316' }} />
                    <span style={{ fontWeight: 600, fontSize: 14 }}>收藏夹</span>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setActiveFolder('root')}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--editor-text-muted)',
                        fontSize: 13,
                        padding: '2px 4px',
                        borderRadius: 4,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--editor-accent)')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--editor-text-muted)')}
                    >
                      <Star size={13} style={{ color: '#f97316', fill: '#f97316' }} />
                      <span>收藏夹</span>
                    </button>
                    <span style={{ color: 'var(--editor-text-muted)', fontSize: 12 }}>/</span>
                    <Folder size={15} style={{ color: '#eab308' }} />
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {currentFolder?.name || '文件夹'}
                    </span>
                  </>
                )}
              </div>

              {!searchQuery && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    onClick={handlePickAndAddFavorite}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '5px 10px',
                      borderRadius: 'var(--radius-md, 6px)',
                      border: '1px solid var(--editor-border)',
                      background: 'var(--editor-surface)',
                      color: 'var(--editor-text)',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all var(--transition-fast)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--toolbar-hover)';
                      e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--editor-surface)';
                      e.currentTarget.style.borderColor = 'var(--editor-border)';
                    }}
                  >
                    <FilePlus size={13} style={{ color: 'var(--editor-accent)' }} />
                    <span>添加收藏</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setIsCreatingFolder(true);
                      setTimeout(() => newFolderInputRef.current?.focus(), 50);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '5px 10px',
                      borderRadius: 'var(--radius-md, 6px)',
                      border: '1px solid var(--editor-border)',
                      background: 'var(--editor-surface)',
                      color: 'var(--editor-text)',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all var(--transition-fast)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--toolbar-hover)';
                      e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--editor-surface)';
                      e.currentTarget.style.borderColor = 'var(--editor-border)';
                    }}
                  >
                    <FolderPlus size={13} style={{ color: '#eab308' }} />
                    <span>添加文件夹</span>
                  </button>
                </div>
              )}
            </div>

            {/* 新建子文件夹输入区 */}
            {isCreatingFolder && !searchQuery && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 18px',
                  background: 'var(--editor-bg, #f8fafc)',
                  borderBottom: '1px solid var(--editor-border)',
                }}
              >
                <Folder size={16} style={{ color: '#eab308' }} />
                <input
                  ref={newFolderInputRef}
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="文件夹名称"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleConfirmCreateFolder();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setIsCreatingFolder(false);
                    }
                  }}
                  style={{
                    flex: 1,
                    height: 28,
                    padding: '0 8px',
                    borderRadius: 4,
                    border: '1px solid var(--editor-border-focus, #3b82f6)',
                    background: 'var(--editor-surface, #ffffff)',
                    color: 'var(--editor-text)',
                    fontSize: 12,
                    outline: 'none',
                  }}
                />
                <button
                  type="button"
                  onClick={handleConfirmCreateFolder}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 4,
                    border: 'none',
                    background: 'var(--accent-strong, #3b82f6)',
                    color: '#ffffff',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  确定
                </button>
                <button
                  type="button"
                  onClick={() => setIsCreatingFolder(false)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 4,
                    border: '1px solid var(--editor-border)',
                    background: 'transparent',
                    color: 'var(--editor-text-muted)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  取消
                </button>
              </div>
            )}

            {/* 列表内容区域 */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '8px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
              onDragOver={(e) => e.preventDefault()}
            >
              {searchQuery ? (
                // 搜索结果列表
                searchResults.length === 0 ? (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: 200,
                      color: 'var(--editor-text-muted)',
                    }}
                  >
                    <span>未找到匹配的收藏项</span>
                  </div>
                ) : (
                  searchResults.map((item) => (
                    <FavoriteFileRow
                      key={item.id}
                      item={item}
                      exists={fileExistenceMap[item.path] ?? true}
                      isEditing={editingNodeId === item.id}
                      editingName={editingName}
                      onEditingNameChange={setEditingName}
                      onConfirmRename={handleConfirmRename}
                      onCancelRename={() => setEditingNodeId(null)}
                      onOpen={() => handleOpenFile(item)}
                      onEdit={() => openAddModal({ displayName: item.name, path: item.path })}
                      onRemove={() => removeFavorite(item.id)}
                      onStartRename={() => {
                        setEditingNodeId(item.id);
                        setEditingName(item.name);
                      }}
                      onDragStart={() => setDraggedNodeId(item.id)}
                    />
                  ))
                )
              ) : // 正常文件夹或根目录内容展示
              currentItems.length === 0 ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: 220,
                    color: 'var(--editor-text-muted)',
                    gap: 12,
                  }}
                >
                  <span>{isRootActive ? '暂无收藏内容' : '此文件夹为空'}</span>
                  <button
                    type="button"
                    onClick={handlePickAndAddFavorite}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '6px 14px',
                      borderRadius: 'var(--radius-md, 6px)',
                      border: '1px dashed var(--editor-border)',
                      background: 'transparent',
                      color: 'var(--editor-accent)',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    <Plus size={13} />
                    <span>添加收藏项</span>
                  </button>
                </div>
              ) : (
                currentItems.map((child) => {
                  if (child.type === 'folder') {
                    return (
                      <FavoriteFolderRow
                        key={child.id}
                        folder={child}
                        isEditing={editingNodeId === child.id}
                        editingName={editingName}
                        isDragOver={dragOverFolderId === child.id}
                        onEditingNameChange={setEditingName}
                        onConfirmRename={handleConfirmRename}
                        onCancelRename={() => setEditingNodeId(null)}
                        onOpenFolder={() => setActiveFolder(child.id)}
                        onRemove={() => removeFavorite(child.id)}
                        onStartRename={() => {
                          setEditingNodeId(child.id);
                          setEditingName(child.name);
                        }}
                        onDragStart={() => setDraggedNodeId(child.id)}
                        onDragOver={() => setDragOverFolderId(child.id)}
                        onDragLeave={() => setDragOverFolderId(null)}
                        onDrop={() => handleDropOnFolder(child.id)}
                      />
                    );
                  }
                  return (
                    <FavoriteFileRow
                      key={child.id}
                      item={child}
                      exists={fileExistenceMap[child.path] ?? true}
                      isEditing={editingNodeId === child.id}
                      editingName={editingName}
                      onEditingNameChange={setEditingName}
                      onConfirmRename={handleConfirmRename}
                      onCancelRename={() => setEditingNodeId(null)}
                      onOpen={() => handleOpenFile(child)}
                      onEdit={() => openAddModal({ displayName: child.name, path: child.path })}
                      onRemove={() => removeFavorite(child.id)}
                      onStartRename={() => {
                        setEditingNodeId(child.id);
                        setEditingName(child.name);
                      }}
                      onDragStart={() => setDraggedNodeId(child.id)}
                    />
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* 文件夹上下文右键菜单 */}
        {folderContextMenu && (
          <div
            ref={contextMenuRef}
            style={{
              position: 'fixed',
              top: folderContextMenu.y,
              left: folderContextMenu.x,
              zIndex: 9999,
              background: 'var(--editor-surface)',
              border: '1px solid var(--editor-border)',
              borderRadius: 'var(--radius-sm)',
              boxShadow: 'var(--shadow-md)',
              padding: 4,
              minWidth: 130,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              style={menuItemStyle}
              onClick={() => {
                const targetId = folderContextMenu.folderId;
                setFolderContextMenu(null);
                setActiveFolder(targetId);
                setIsCreatingFolder(true);
                setTimeout(() => newFolderInputRef.current?.focus(), 50);
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <FolderPlus size={13} style={{ color: '#eab308' }} />
              <span>新建子文件夹</span>
            </button>

            {folderContextMenu.folderId !== 'root_bar' && folderContextMenu.folderId !== 'root_other' && (
              <>
                <button
                  type="button"
                  style={menuItemStyle}
                  onClick={() => {
                    const targetId = folderContextMenu.folderId;
                    const folder = findFolderById(data.roots, targetId);
                    setFolderContextMenu(null);
                    if (folder) {
                      setEditingNodeId(targetId);
                      setEditingName(folder.name);
                    }
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <Edit2 size={13} />
                  <span>重命名</span>
                </button>

                <button
                  type="button"
                  style={{ ...menuItemStyle, color: 'var(--error-500)' }}
                  onClick={() => {
                    const targetId = folderContextMenu.folderId;
                    setFolderContextMenu(null);
                    removeFavorite(targetId);
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--error-surface, rgba(239, 68, 68, 0.1))')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <Trash2 size={13} />
                  <span>删除文件夹</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 目录树节点组件 ──

interface FolderTreeNodeProps {
  node: FavoriteNode;
  depth: number;
  activeFolderId: string;
  expandedFolderIds: string[];
  dragOverFolderId: string | null;
  onSelectFolder: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onDragOver: (id: string) => void;
  onDragLeave: () => void;
  onDrop: (id: string) => void;
}

function FolderTreeNode({
  node,
  depth,
  activeFolderId,
  expandedFolderIds,
  dragOverFolderId,
  onSelectFolder,
  onToggleExpand,
  onContextMenu,
  onDragOver,
  onDrop,
}: FolderTreeNodeProps) {
  if (node.type !== 'folder') return null;

  const isExpanded = expandedFolderIds.includes(node.id);
  const isActive = activeFolderId === node.id;
  const isDragOver = dragOverFolderId === node.id;
  const subFolders = (node.children || []).filter((c) => c.type === 'folder');
  const hasSubFolders = subFolders.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '5px 8px',
          paddingLeft: 8 + depth * 14,
          borderRadius: 6,
          cursor: 'pointer',
          background: isDragOver
            ? 'var(--accent-surface, rgba(59, 130, 246, 0.15))'
            : isActive
            ? 'var(--toolbar-active, rgba(0, 0, 0, 0.08))'
            : 'transparent',
          border: isDragOver ? '1px dashed var(--editor-accent)' : '1px solid transparent',
          color: isActive ? 'var(--editor-accent)' : 'var(--editor-text)',
          fontWeight: isActive ? 600 : 400,
          transition: 'all var(--transition-fast)',
        }}
        onClick={() => onSelectFolder(node.id)}
        onContextMenu={(e) => onContextMenu(e, node.id)}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDragOver(node.id);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDrop(node.id);
        }}
        onMouseEnter={(e) => {
          if (!isActive && !isDragOver) {
            e.currentTarget.style.background = 'var(--toolbar-hover, rgba(0, 0, 0, 0.04))';
          }
        }}
        onMouseLeave={(e) => {
          if (!isActive && !isDragOver) {
            e.currentTarget.style.background = 'transparent';
          }
        }}
      >
        {/* 展开/收起箭头 */}
        <span
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(node.id);
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            opacity: hasSubFolders ? 0.7 : 0,
            cursor: hasSubFolders ? 'pointer' : 'default',
          }}
        >
          {hasSubFolders && (isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </span>

        {/* 文件夹图标 */}
        {isExpanded ? (
          <FolderOpen size={14} style={{ color: '#eab308', flexShrink: 0 }} />
        ) : (
          <Folder size={14} style={{ color: '#eab308', flexShrink: 0 }} />
        )}

        {/* 文件夹名称 */}
        <span
          style={{
            fontSize: 12,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {node.name}
        </span>
      </div>

      {/* 递归子文件夹 */}
      {isExpanded && hasSubFolders && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {subFolders.map((subNode) => (
            <FolderTreeNode
              key={subNode.id}
              node={subNode}
              depth={depth + 1}
              activeFolderId={activeFolderId}
              expandedFolderIds={expandedFolderIds}
              dragOverFolderId={dragOverFolderId}
              onSelectFolder={onSelectFolder}
              onToggleExpand={onToggleExpand}
              onContextMenu={onContextMenu}
              onDragOver={onDragOver}
              onDragLeave={() => {}}
              onDrop={onDrop}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 右侧列表文件夹行组件 ──

interface FavoriteFolderRowProps {
  folder: FavoriteFolderItem;
  isEditing: boolean;
  editingName: string;
  isDragOver: boolean;
  onEditingNameChange: (val: string) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  onOpenFolder: () => void;
  onRemove: () => void;
  onStartRename: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
}

function FavoriteFolderRow({
  folder,
  isEditing,
  editingName,
  isDragOver,
  onEditingNameChange,
  onConfirmRename,
  onCancelRename,
  onOpenFolder,
  onRemove,
  onStartRename,
  onDragStart,
  onDragOver,
  onDrop,
}: FavoriteFolderRowProps) {
  return (
    <div
      draggable={!isEditing}
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onClick={onOpenFolder}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderRadius: 'var(--radius-md, 6px)',
        border: isDragOver
          ? '1px dashed var(--editor-accent, #3b82f6)'
          : '1px solid var(--editor-border, rgba(0, 0, 0, 0.06))',
        background: isDragOver
          ? 'var(--accent-surface, rgba(59, 130, 246, 0.08))'
          : 'var(--editor-surface, #ffffff)',
        cursor: 'pointer',
        transition: 'all var(--transition-fast)',
        userSelect: 'none',
      }}
      onMouseEnter={(e) => {
        if (!isDragOver) {
          e.currentTarget.style.background = 'var(--toolbar-hover, rgba(0, 0, 0, 0.03))';
          e.currentTarget.style.borderColor = 'var(--editor-border-focus, rgba(0, 0, 0, 0.15))';
        }
      }}
      onMouseLeave={(e) => {
        if (!isDragOver) {
          e.currentTarget.style.background = 'var(--editor-surface, #ffffff)';
          e.currentTarget.style.borderColor = 'var(--editor-border, rgba(0, 0, 0, 0.06))';
        }
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
        <Folder size={18} style={{ color: '#eab308', flexShrink: 0 }} />

        {isEditing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }} onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              autoFocus
              value={editingName}
              onChange={(e) => onEditingNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onConfirmRename();
                if (e.key === 'Escape') onCancelRename();
              }}
              style={{
                height: 24,
                padding: '0 6px',
                borderRadius: 4,
                border: '1px solid var(--editor-border-focus, #3b82f6)',
                background: 'var(--editor-surface)',
                color: 'var(--editor-text)',
                fontSize: 13,
                outline: 'none',
              }}
            />
            <button type="button" onClick={onConfirmRename} style={smallActionBtnStyle}>确定</button>
            <button type="button" onClick={onCancelRename} style={smallActionBtnStyle}>取消</button>
          </div>
        ) : (
          <span style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {folder.name}
          </span>
        )}
      </div>

      {!isEditing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <Tooltip content="重命名" side="top" sideOffset={4}>
            <button
              type="button"
              aria-label="重命名"
              onClick={onStartRename}
              style={iconBtnStyle}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <Edit2 size={13} />
            </button>
          </Tooltip>
          <Tooltip content="删除文件夹" side="top" sideOffset={4}>
            <button
              type="button"
              aria-label="删除文件夹"
              onClick={onRemove}
              style={{ ...iconBtnStyle, color: 'var(--error-500)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--error-surface, rgba(239, 68, 68, 0.1))')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <X size={14} />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

// ── 右侧列表文件行组件 ──

interface FavoriteFileRowProps {
  item: FavoriteFileItem;
  exists: boolean;
  isEditing: boolean;
  editingName: string;
  onEditingNameChange: (val: string) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onStartRename: () => void;
  onDragStart: () => void;
}

function FavoriteFileRow({
  item,
  exists,
  isEditing,
  editingName,
  onEditingNameChange,
  onConfirmRename,
  onCancelRename,
  onOpen,
  onEdit,
  onRemove,
  onStartRename,
  onDragStart,
}: FavoriteFileRowProps) {
  return (
    <div
      draggable={!isEditing}
      onDragStart={onDragStart}
      onClick={onOpen}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderRadius: 'var(--radius-md, 6px)',
        border: '1px solid var(--editor-border, rgba(0, 0, 0, 0.06))',
        background: exists ? 'var(--editor-surface, #ffffff)' : 'var(--editor-bg, #f8fafc)',
        cursor: 'pointer',
        transition: 'all var(--transition-fast)',
        userSelect: 'none',
        opacity: exists ? 1 : 0.75,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--toolbar-hover, rgba(0, 0, 0, 0.03))';
        e.currentTarget.style.borderColor = 'var(--editor-border-focus, rgba(0, 0, 0, 0.15))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = exists ? 'var(--editor-surface, #ffffff)' : 'var(--editor-bg, #f8fafc)';
        e.currentTarget.style.borderColor = 'var(--editor-border, rgba(0, 0, 0, 0.06))';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
        {/* 文件类型图标 */}
        {getExplorerFileIcon(item.path || item.name, { size: 16 })}

        {isEditing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }} onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              autoFocus
              value={editingName}
              onChange={(e) => onEditingNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onConfirmRename();
                if (e.key === 'Escape') onCancelRename();
              }}
              style={{
                height: 24,
                padding: '0 6px',
                borderRadius: 4,
                border: '1px solid var(--editor-border-focus, #3b82f6)',
                background: 'var(--editor-surface)',
                color: 'var(--editor-text)',
                fontSize: 13,
                outline: 'none',
              }}
            />
            <button type="button" onClick={onConfirmRename} style={smallActionBtnStyle}>确定</button>
            <button type="button" onClick={onCancelRename} style={smallActionBtnStyle}>取消</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Tooltip content={item.name} side="top" sideOffset={4}>
                <span
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onStartRename();
                  }}
                  style={{
                    fontWeight: 500,
                    fontSize: 13,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: exists ? 'var(--editor-text)' : 'var(--editor-text-muted)',
                  }}
                >
                  {item.name}
                </span>
              </Tooltip>

              {/* 失效文件警示标签 */}
              {!exists && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    padding: '1px 5px',
                    borderRadius: 4,
                    fontSize: 10,
                    background: 'var(--error-surface, rgba(239, 68, 68, 0.1))',
                    color: 'var(--error-500, #ef4444)',
                    border: '1px solid var(--error-border, rgba(239, 68, 68, 0.2))',
                  }}
                >
                  <AlertTriangle size={10} />
                  <span>已失效</span>
                </span>
              )}
            </div>

            {/* 文件路径 */}
            <Tooltip content={item.path} side="bottom" sideOffset={4}>
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--editor-text-muted, #64748b)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.path}
              </span>
            </Tooltip>
          </div>
        )}
      </div>

      {!isEditing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          {exists && (
            <Tooltip content="在文件管理器中定位" side="top" sideOffset={4}>
              <button
                type="button"
                aria-label="在文件管理器中定位"
                onClick={() => ipc.revealInExplorer(item.path)}
                style={iconBtnStyle}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <FolderOpen size={13} />
              </button>
            </Tooltip>
          )}

          <Tooltip content="编辑" side="top" sideOffset={4}>
            <button
              type="button"
              aria-label="编辑"
              onClick={onEdit}
              style={iconBtnStyle}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <Edit2 size={13} />
            </button>
          </Tooltip>

          <Tooltip content="移除收藏" side="top" sideOffset={4}>
            <button
              type="button"
              aria-label="移除收藏"
              onClick={onRemove}
              style={{ ...iconBtnStyle, color: 'var(--error-500)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--error-surface, rgba(239, 68, 68, 0.1))')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <X size={14} />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

// ── 基础复用样式 ──

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 5,
  borderRadius: 4,
  cursor: 'pointer',
  color: 'var(--editor-text-muted, #64748b)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all var(--transition-fast)',
};

const smallActionBtnStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid var(--editor-border)',
  background: 'var(--editor-bg)',
  color: 'var(--editor-text)',
  fontSize: 11,
  cursor: 'pointer',
};

const menuItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 10px',
  background: 'transparent',
  border: 'none',
  borderRadius: 4,
  textAlign: 'left',
  cursor: 'pointer',
  fontSize: 12,
  color: 'var(--editor-text)',
  transition: 'all var(--transition-fast)',
};
