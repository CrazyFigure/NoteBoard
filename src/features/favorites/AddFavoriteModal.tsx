// NoteBoard 添加/编辑收藏夹模态弹窗
// 支持设置收藏名称、所属目标文件夹、内联快速新建文件夹、已有收藏移除与保存

import { useState, useEffect, useRef } from 'react';
import { Star, Folder, X, Trash2, Check, FolderPlus } from 'lucide-react';
import { useFavoritesStore } from './favoritesStore';
import { getAllFolders, findFavoriteByPath, findParentFolder } from './favoritesUtils';
import { showToast } from '../../stores/toastStore';

export function AddFavoriteModal() {
  const {
    data,
    addModalState,
    closeAddModal,
    addFavorite,
    removeFavorite,
    createFolder,
  } = useFavoritesStore();

  const { open, target, initialFolderId } = addModalState;

  const [name, setName] = useState('');
  const [selectedFolderId, setSelectedFolderId] = useState('root');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isFavorited, setIsFavorited] = useState(false);
  const [existingId, setExistingId] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // 所有文件夹层级扁平列表
  const folderOptions = getAllFolders(data.roots);

  // 弹窗打开时回显数据
  useEffect(() => {
    if (open && target) {
      const targetPath = target.path || '';
      const existing = targetPath ? findFavoriteByPath(data.roots, targetPath) : null;

      if (existing) {
        setIsFavorited(true);
        setExistingId(existing.id);
        setName(existing.name);
        const parent = findParentFolder(data.roots, existing.id);
        setSelectedFolderId(parent ? parent.id : initialFolderId || 'root');
      } else {
        setIsFavorited(false);
        setExistingId(null);
        const defaultName = target.displayName || target.name || (targetPath.split(/[\\/]/).pop() ?? '未命名文档');
        setName(defaultName);
        setSelectedFolderId(initialFolderId || 'root');
      }

      setIsCreatingFolder(false);
      setNewFolderName('');

      setTimeout(() => {
        nameInputRef.current?.focus();
        nameInputRef.current?.select();
      }, 50);
    }
  }, [open, target, initialFolderId, data.roots]);

  // 全局 Escape 关闭
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeAddModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, closeAddModal]);

  if (!open || !target) return null;

  const targetPath = target.path || '';

  // 确认提交添加或更新收藏
  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!targetPath) {
      showToast('未命名或内存文档暂无法加入收藏夹', 'warning');
      closeAddModal();
      return;
    }

    const finalName = name.trim() || (targetPath.split(/[\\/]/).pop() ?? '未命名文档');
    await addFavorite(selectedFolderId, finalName, targetPath);
    showToast(isFavorited ? '已更新收藏' : '已添加到收藏夹', 'success');
    closeAddModal();
  };

  // 移除该收藏项
  const handleRemove = async () => {
    if (existingId) {
      await removeFavorite(existingId);
      showToast('已从收藏夹移除', 'info');
    }
    closeAddModal();
  };

  // 创建新文件夹并自动选中
  const handleCreateNewFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setIsCreatingFolder(false);
      return;
    }
    const createdId = await createFolder(selectedFolderId, trimmed);
    setSelectedFolderId(createdId);
    setNewFolderName('');
    setIsCreatingFolder(false);
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9996,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(4px)',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          closeAddModal();
        }
      }}
    >
      <div
        style={{
          width: 440,
          maxWidth: '92vw',
          background: 'var(--editor-surface, #ffffff)',
          border: '1px solid var(--editor-border, rgba(0, 0, 0, 0.12))',
          borderRadius: 'var(--radius-lg, 8px)',
          boxShadow: '0 12px 32px -4px rgba(0, 0, 0, 0.18), 0 4px 12px -2px rgba(0, 0, 0, 0.08)',
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
            padding: '12px 16px',
            borderBottom: '1px solid var(--editor-border, rgba(0, 0, 0, 0.08))',
            background: 'var(--editor-bg, #f8fafc)',
            userSelect: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Star
              size={16}
              style={{
                color: '#f97316',
                fill: isFavorited ? '#f97316' : 'none',
              }}
            />
            <span style={{ fontWeight: 600, fontSize: 14 }}>
              {isFavorited ? '编辑收藏' : '添加到收藏夹'}
            </span>
          </div>
          <button
            type="button"
            onClick={closeAddModal}
            title="关闭 (Esc)"
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
              transition: 'all var(--transition-fast, 150ms ease)',
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
            <X size={15} />
          </button>
        </div>

        {/* 表单输入区域 */}
        <form onSubmit={handleSave} style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* 名称输入 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--editor-text-secondary, #475569)',
              }}
            >
              名称
            </label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="收藏名称"
              style={{
                height: 32,
                padding: '0 10px',
                borderRadius: 'var(--radius-md, 6px)',
                border: '1px solid var(--editor-border, #cbd5e1)',
                background: 'var(--editor-bg, #f8fafc)',
                color: 'var(--editor-text, #0f172a)',
                fontSize: 13,
                outline: 'none',
                transition: 'all var(--transition-fast, 150ms ease)',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'var(--editor-border-focus, #3b82f6)';
                e.currentTarget.style.background = 'var(--editor-surface, #ffffff)';
                e.currentTarget.style.boxShadow = '0 0 0 2px var(--focus-ring, rgba(59, 130, 246, 0.2))';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'var(--editor-border, #cbd5e1)';
                e.currentTarget.style.background = 'var(--editor-bg, #f8fafc)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
          </div>

          {/* 路径展示 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--editor-text-secondary, #475569)',
              }}
            >
              路径
            </label>
            <div
              style={{
                padding: '6px 10px',
                borderRadius: 'var(--radius-md, 6px)',
                border: '1px solid var(--editor-border, #cbd5e1)',
                background: 'var(--editor-bg, #f8fafc)',
                color: 'var(--editor-text-muted, #64748b)',
                fontSize: 12,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                userSelect: 'text',
              }}
              title={targetPath}
            >
              {targetPath || '未保存文件'}
            </div>
          </div>

          {/* 文件夹选择 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--editor-text-secondary, #475569)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                <Folder size={13} style={{ opacity: 0.8 }} />
                <span>文件夹</span>
              </label>

              {!isCreatingFolder && (
                <button
                  type="button"
                  onClick={() => {
                    setIsCreatingFolder(true);
                    setTimeout(() => newFolderInputRef.current?.focus(), 50);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    background: 'transparent',
                    border: 'none',
                    padding: '2px 6px',
                    borderRadius: 4,
                    fontSize: 11,
                    color: 'var(--editor-accent, #3b82f6)',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--toolbar-hover, rgba(59, 130, 246, 0.1))';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <FolderPlus size={12} />
                  <span>新建文件夹</span>
                </button>
              )}
            </div>

            {/* 内联新建文件夹输入框 */}
            {isCreatingFolder && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                <input
                  ref={newFolderInputRef}
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="文件夹名称"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleCreateNewFolder();
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
                  onClick={handleCreateNewFolder}
                  style={{
                    padding: '0 8px',
                    height: 28,
                    borderRadius: 4,
                    border: 'none',
                    background: 'var(--accent-strong, #3b82f6)',
                    color: '#ffffff',
                    fontSize: 12,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Check size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setIsCreatingFolder(false)}
                  style={{
                    padding: '0 8px',
                    height: 28,
                    borderRadius: 4,
                    border: '1px solid var(--editor-border)',
                    background: 'transparent',
                    color: 'var(--editor-text-muted)',
                    fontSize: 12,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            )}

            {/* 下拉选择框 */}
            <select
              value={selectedFolderId}
              onChange={(e) => setSelectedFolderId(e.target.value)}
              style={{
                height: 32,
                padding: '0 8px',
                borderRadius: 'var(--radius-md, 6px)',
                border: '1px solid var(--editor-border, #cbd5e1)',
                background: 'var(--editor-bg, #f8fafc)',
                color: 'var(--editor-text, #0f172a)',
                fontSize: 13,
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              {folderOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {'　'.repeat(f.depth)}📁 {f.name}
                </option>
              ))}
            </select>
          </div>

          {/* 底部按钮栏 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: isFavorited ? 'space-between' : 'flex-end',
              marginTop: 6,
              paddingTop: 12,
              borderTop: '1px solid var(--editor-border, rgba(0, 0, 0, 0.08))',
            }}
          >
            {isFavorited && (
              <button
                type="button"
                onClick={handleRemove}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-md, 6px)',
                  border: '1px solid var(--error-border, rgba(239, 68, 68, 0.2))',
                  background: 'transparent',
                  color: 'var(--error-500, #ef4444)',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--error-surface, rgba(239, 68, 68, 0.1))';
                  e.currentTarget.style.transform = 'scale(1.02)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.transform = 'scale(1)';
                }}
                onMouseDown={(e) => {
                  e.currentTarget.style.transform = 'scale(0.96)';
                }}
                onMouseUp={(e) => {
                  e.currentTarget.style.transform = 'scale(1.02)';
                }}
              >
                <Trash2 size={13} />
                <span>移除收藏</span>
              </button>
            )}

            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
              <button
                type="button"
                onClick={closeAddModal}
                style={{
                  padding: '6px 14px',
                  borderRadius: 'var(--radius-md, 6px)',
                  border: '1px solid var(--editor-border, #cbd5e1)',
                  background: 'transparent',
                  color: 'var(--editor-text-secondary, #475569)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--toolbar-hover, rgba(0, 0, 0, 0.04))';
                  e.currentTarget.style.color = 'var(--editor-text, #0f172a)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--editor-text-secondary, #475569)';
                }}
                onMouseDown={(e) => {
                  e.currentTarget.style.transform = 'scale(0.96)';
                }}
                onMouseUp={(e) => {
                  e.currentTarget.style.transform = 'scale(1)';
                }}
              >
                取消
              </button>
              <button
                type="submit"
                style={{
                  padding: '6px 16px',
                  borderRadius: 'var(--radius-md, 6px)',
                  border: 'none',
                  background: 'var(--accent-strong, #3b82f6)',
                  color: '#ffffff',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.08)',
                  transition: 'all var(--transition-fast)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.filter = 'brightness(1.1)';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 3px 6px rgba(59, 130, 246, 0.25)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.filter = 'none';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 1px 2px rgba(0, 0, 0, 0.08)';
                }}
                onMouseDown={(e) => {
                  e.currentTarget.style.transform = 'translateY(0) scale(0.96)';
                }}
                onMouseUp={(e) => {
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
              >
                {isFavorited ? '保存' : '完成'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
