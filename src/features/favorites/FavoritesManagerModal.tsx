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
  findParentFolder,
  searchFavorites,
  isDescendantOrSelf,
  getFolderCommonDir,
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
import './favoritesManager.css';

// 指针移动超过该距离才视为拖拽，避免点击时轻微抖动误触发
const DRAG_THRESHOLD = 4;

// 整个弹窗共用并发额度，快速切换目录或连续搜索也不能叠加出大量 IPC / HTTP 请求。
const MAX_EXISTENCE_CHECKS = 6;

interface FileExistenceCheck {
  paths: string[];
  cursor: number;
  remaining: number;
  results: Record<string, boolean>;
}

// 拖拽落点：放入某文件夹，或插到某个节点的前/后
type DropTarget =
  | { kind: 'into'; folderId: string }
  | { kind: 'before' | 'after'; refId: string };

type DropIndicator = 'before' | 'after' | null;

// 跟随指针的拖拽预览
interface DragVisual {
  sourceId: string;
  name: string;
  isFolder: boolean;
}

/** 落点语义不变时复用列表状态，避免仅坐标变化也重绘全部收藏与文件夹。 */
function sameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (!a || !b) return a === b;
  return a.kind === 'into' && b.kind === 'into' ? a.folderId === b.folderId
    : a.kind !== 'into' && b.kind !== 'into' && a.kind === b.kind && a.refId === b.refId;
}

/** 预览与指针保持原有的横向 12px、纵向 10px 间距，避免遮挡实际落点。 */
function dragPreviewTransform(point: { x: number; y: number }): string {
  return `translate3d(${point.x + 12}px, ${point.y + 10}px, 0)`;
}

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
    moveItemRelative,
    setFolderExpanded,
    openAddModal,
  } = useFavoritesStore();

  // 当前重命名状态（节点 ID 与正在编辑的名称）
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  // 新建子文件夹状态
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // 拖拽预览与当前落点（Tauri 开启了 dragDropEnabled，WebView 内原生 HTML5 拖放收不到 drop，改用指针事件实现）
  const [dragVisual, setDragVisual] = useState<DragVisual | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement>(null);
  const dragPointRef = useRef({ x: 0, y: 0 });
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  // 取消进行中拖拽的回调（Esc 或卸载时调用）
  const cancelDragRef = useRef<(() => void) | null>(null);
  // 供 window 级指针监听读取最新数据
  const rootsRef = useRef(data.roots);
  rootsRef.current = data.roots;
  const searchingRef = useRef(false);
  searchingRef.current = Boolean(searchQuery.trim());

  // 拖拽悬停的目标文件夹 ID
  const dragOverFolderId = dropTarget?.kind === 'into' ? dropTarget.folderId : null;

  // 文件存在性探测缓存 (path -> boolean)
  const [fileExistenceMap, setFileExistenceMap] = useState<Record<string, boolean>>({});
  const existenceJobRef = useRef<FileExistenceCheck | null>(null);
  const existenceRunningRef = useRef(0);

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
        if (cancelDragRef.current) {
          // 拖拽中按 Esc 只取消拖拽
          cancelDragRef.current();
        } else if (folderContextMenu) {
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

  /** 只消费当前视图的探测队列；旧调用结束后释放额度，取消过的任务既不回写也不继续发起请求。 */
  const pumpExistenceChecks = useCallback(function pumpExistenceChecks() {
    const job = existenceJobRef.current;
    if (!job) return;
    while (existenceRunningRef.current < MAX_EXISTENCE_CHECKS && job.cursor < job.paths.length) {
      const path = job.paths[job.cursor++];
      existenceRunningRef.current += 1;
      void Promise.resolve().then(() => {
        // 提交微任务前视图也可能已切换，尚未发出的调用直接释放额度，不访问旧路径。
        if (existenceJobRef.current === job) return ipc.pathExists(path);
      }).then((res) => {
        if (res) job.results[path] = res.exists && !res.isDir;
      }).catch(() => {
        job.results[path] = false;
      }).finally(() => {
        existenceRunningRef.current -= 1;
        job.remaining -= 1;
        if (existenceJobRef.current === job && job.remaining === 0) {
          setFileExistenceMap((prev) => ({ ...prev, ...job.results }));
        }
        pumpExistenceChecks();
      });
    }
  }, []);

  /** 去重当前路径并替换旧队列，不增加后台调用数量；返回清理函数使关闭、切换和卸载立即失效。 */
  const checkFilesExistence = useCallback((files: FavoriteFileItem[]) => {
    const paths = [...new Set(files.map((file) => file.path).filter(Boolean))];
    const job: FileExistenceCheck = { paths, cursor: 0, remaining: paths.length, results: {} };
    existenceJobRef.current = job;
    pumpExistenceChecks();
    return () => { if (existenceJobRef.current === job) existenceJobRef.current = null; };
  }, [pumpExistenceChecks]);

  // 当当前文件夹切换或搜索词变化时探测文件存在性
  useEffect(() => {
    if (!managerModalOpen) return;
    const files = searchQuery.trim() ? searchResults : currentItems.filter((c): c is FavoriteFileItem => c.type === 'file');
    return checkFilesExistence(files);
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

  // 弹窗关闭或组件卸载时结束进行中的拖拽，避免残留 window 监听
  useEffect(() => {
    if (!managerModalOpen) cancelDragRef.current?.();
  }, [managerModalOpen]);
  useEffect(() => () => cancelDragRef.current?.(), []);

  // 根据指针位置计算落点：左侧目录树节点 = 放入；右侧行 = 上/下半插入，文件夹行中部 = 放入
  const resolveDropTarget = (sourceId: string, x: number, y: number): DropTarget | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;
    const roots = rootsRef.current;
    const sourceParentId = findParentFolder(roots, sourceId)?.id ?? 'root';
    // 放回原所在文件夹没有意义；文件夹不能放进自身或子孙
    const canDropInto = (folderId: string) =>
      folderId !== sourceParentId && !isDescendantOrSelf(roots, sourceId, folderId);

    const treeEl = el.closest<HTMLElement>('[data-fav-tree-folder]');
    if (treeEl) {
      const folderId = treeEl.dataset.favTreeFolder || 'root';
      return canDropInto(folderId) ? { kind: 'into', folderId } : null;
    }

    // 搜索结果是跨层级的扁平列表，不支持排序
    const rowEl = el.closest<HTMLElement>('[data-fav-row-id]');
    if (!rowEl || searchingRef.current) return null;
    const refId = rowEl.dataset.favRowId!;
    if (refId === sourceId) return null;

    const rect = rowEl.getBoundingClientRect();
    const ratio = (y - rect.top) / rect.height;
    if (rowEl.dataset.favRowFolder === '1' && ratio > 0.25 && ratio < 0.75) {
      return canDropInto(refId) ? { kind: 'into', folderId: refId } : null;
    }

    const position = ratio < 0.5 ? 'before' : 'after';
    // 紧邻源节点的插入位置等于原地不动，不显示指示线
    const siblings = sourceParentId === 'root'
      ? roots
      : findFolderById(roots, sourceParentId)?.children ?? [];
    const srcIndex = siblings.findIndex((n) => n.id === sourceId);
    const refIndex = siblings.findIndex((n) => n.id === refId);
    if (srcIndex >= 0 && refIndex >= 0) {
      if (position === 'before' && refIndex === srcIndex + 1) return null;
      if (position === 'after' && refIndex === srcIndex - 1) return null;
    }
    return { kind: position, refId };
  };

  // 执行拖拽落点对应的移动
  const applyDrop = async (sourceId: string, target: DropTarget) => {
    if (target.kind === 'into') {
      await moveItem(sourceId, target.folderId);
      // 展开目标文件夹，让移入的子文件夹在目录树中可见
      if (target.folderId !== 'root') setFolderExpanded(target.folderId, true);
    } else {
      await moveItemRelative(sourceId, target.refId, target.kind);
    }
  };

  // 右侧行按下指针：超过阈值后进入拖拽，松开时按落点移动
  const handleRowPointerDown = (e: React.PointerEvent, node: FavoriteNode) => {
    if (e.button !== 0 || cancelDragRef.current) return;
    // 按钮与输入框保留各自的交互
    if ((e.target as HTMLElement).closest('button, input')) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    let started = false;
    let frame: number | null = null;
    let point = { x: startX, y: startY };

    // 命中检测与预览变换每帧只执行一次；只有真正开始拖动和落点变化才重绘列表。
    const updateDrag = () => {
      frame = null;
      if (!started) {
        if (Math.hypot(point.x - startX, point.y - startY) < DRAG_THRESHOLD) return;
        started = true;
        setDragVisual({ sourceId: node.id, name: node.name, isFolder: node.type === 'folder' });
      }
      // 先读命中与几何，再写预览位置，避免一次移动中交错读写迫使浏览器同步刷新样式。
      const next = resolveDropTarget(node.id, point.x, point.y);
      dragPointRef.current = point;
      if (dragPreviewRef.current) dragPreviewRef.current.style.transform = dragPreviewTransform(point);
      const previous = dropTargetRef.current;
      dropTargetRef.current = next;
      if (!sameDropTarget(previous, next)) setDropTarget(next);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      point = { x: ev.clientX, y: ev.clientY };
      if (frame === null) frame = requestAnimationFrame(updateDrag);
    };

    const finish = (commit: boolean) => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      // 松手可能早于下一次显示帧，按最终指针位置同步确定落点，取消则直接丢弃待绘工作。
      if (commit) updateDrag();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      cancelDragRef.current = null;
      const target = dropTargetRef.current;
      dropTargetRef.current = null;
      setDropTarget(null);
      setDragVisual(null);
      if (!started) return;

      // 拖拽松开后浏览器仍会派发一次 click，拦截掉以免误打开文件或切换文件夹
      const swallowClick = (ce: MouseEvent) => {
        ce.stopPropagation();
        ce.preventDefault();
      };
      window.addEventListener('click', swallowClick, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }), 0);

      if (commit && target) void applyDrop(node.id, target);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      point = { x: ev.clientX, y: ev.clientY };
      finish(true);
    };
    const onCancel = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish(false); };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    cancelDragRef.current = () => finish(false);
  };

  // 右侧行的插入指示线位置
  const getDropIndicator = (id: string): DropIndicator =>
    dropTarget && dropTarget.kind !== 'into' && dropTarget.refId === id ? dropTarget.kind : null;

  // 右键菜单对应文件夹的磁盘目录（其下文件的公共父目录）
  const contextMenuFolder = folderContextMenu ? findFolderById(data.roots, folderContextMenu.folderId) : null;
  const contextMenuRevealDir = contextMenuFolder ? getFolderCommonDir(contextMenuFolder) : null;

  if (!managerModalOpen) return null;

  return (
    <div
      className="nb-favorites-manager-overlay"
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
        // 全窗口虚化会在悬停反馈和提示浮层变化时重复采样背景，所有平台统一使用原色遮罩。
        background: 'rgba(0, 0, 0, 0.45)',
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
              className="nb-favorites-close-button"
              style={{
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 4,
                borderRadius: 'var(--radius-sm, 4px)',
                transition: 'all var(--transition-fast)',
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
                className="nb-favorites-tree-node"
                data-active={isRootActive}
                data-drop-target={dragOverFolderId === 'root'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: isRootActive ? 'var(--editor-accent)' : 'var(--editor-text)',
                  fontWeight: isRootActive ? 600 : 400,
                  transition: 'all var(--transition-fast)',
                  userSelect: 'none',
                }}
                data-fav-tree-folder="root"
                onClick={() => {
                  setSearchQuery('');
                  setActiveFolder('root');
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
                      className="nb-favorites-breadcrumb"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 13,
                        padding: '2px 4px',
                        borderRadius: 4,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
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
                    className="nb-favorites-action-button"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '5px 10px',
                      borderRadius: 'var(--radius-md, 6px)',
                      color: 'var(--editor-text)',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all var(--transition-fast)',
                    }}
                  >
                    <FilePlus size={13} style={{ color: 'var(--editor-accent)' }} />
                    <span>添加收藏</span>
                  </button>

                  <button
                    type="button"
                    className="nb-favorites-action-button"
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
                      color: 'var(--editor-text)',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all var(--transition-fast)',
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
                    border: '1px solid var(--control-border)',
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
                      dropIndicator={null}
                      isDragSource={dragVisual?.sourceId === item.id}
                      onPointerDown={(e) => handleRowPointerDown(e, item)}
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
                      border: '1px dashed var(--control-border)',
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
                        revealDir={getFolderCommonDir(child)}
                        onEditingNameChange={setEditingName}
                        onConfirmRename={handleConfirmRename}
                        onCancelRename={() => setEditingNodeId(null)}
                        onOpenFolder={() => setActiveFolder(child.id)}
                        onRemove={() => removeFavorite(child.id)}
                        onStartRename={() => {
                          setEditingNodeId(child.id);
                          setEditingName(child.name);
                        }}
                        dropIndicator={getDropIndicator(child.id)}
                        isDragSource={dragVisual?.sourceId === child.id}
                        onPointerDown={(e) => handleRowPointerDown(e, child)}
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
                      dropIndicator={getDropIndicator(child.id)}
                      isDragSource={dragVisual?.sourceId === child.id}
                      onPointerDown={(e) => handleRowPointerDown(e, child)}
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
              className="nb-favorites-hover-button"
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
                  className="nb-favorites-hover-button"
                >
                  <Edit2 size={13} />
                  <span>重命名</span>
                </button>

                {contextMenuRevealDir && (
                  <button
                    type="button"
                    style={menuItemStyle}
                    onClick={() => {
                      setFolderContextMenu(null);
                      void ipc.revealInExplorer(contextMenuRevealDir);
                    }}
                    className="nb-favorites-hover-button"
                  >
                    <FolderOpen size={13} />
                    <span>在文件管理器中定位</span>
                  </button>
                )}

                <button
                  type="button"
                  style={{ ...menuItemStyle, color: 'var(--error-500)' }}
                  onClick={() => {
                    const targetId = folderContextMenu.folderId;
                    setFolderContextMenu(null);
                    removeFavorite(targetId);
                  }}
                  className="nb-favorites-hover-button nb-favorites-danger-button"
                >
                  <Trash2 size={13} />
                  <span>删除文件夹</span>
                </button>
              </>
            )}
          </div>
        )}

        {/* 跟随指针的拖拽预览 */}
        {dragVisual && (
          <div
            ref={dragPreviewRef}
            className="nb-favorites-drag-preview"
            style={{
              position: 'fixed',
              left: 0,
              top: 0,
              transform: dragPreviewTransform(dragPointRef.current),
              zIndex: 9999,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              maxWidth: 240,
              padding: '4px 10px',
              borderRadius: 'var(--radius-md, 6px)',
              border: '1px solid var(--editor-border)',
              background: 'var(--editor-surface)',
              boxShadow: 'var(--shadow-md)',
              fontSize: 12,
              opacity: 0.92,
            }}
          >
            {dragVisual.isFolder
              ? <Folder size={14} style={{ color: '#eab308', flexShrink: 0 }} />
              : getExplorerFileIcon(dragVisual.name, { size: 14 })}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {dragVisual.name}
            </span>
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
        className="nb-favorites-tree-node"
        data-active={isActive}
        data-drop-target={isDragOver}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '5px 8px',
          paddingLeft: 8 + depth * 14,
          borderRadius: 6,
          cursor: 'pointer',
          color: isActive ? 'var(--editor-accent)' : 'var(--editor-text)',
          fontWeight: isActive ? 600 : 400,
          transition: 'all var(--transition-fast)',
        }}
        data-fav-tree-folder={node.id}
        onClick={() => onSelectFolder(node.id)}
        onContextMenu={(e) => onContextMenu(e, node.id)}
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
  /** 收藏文件夹对应的磁盘目录（其下文件的公共父目录），无则不显示定位按钮 */
  revealDir: string | null;
  onEditingNameChange: (val: string) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  onOpenFolder: () => void;
  onRemove: () => void;
  onStartRename: () => void;
  dropIndicator: DropIndicator;
  isDragSource: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}

function FavoriteFolderRow({
  folder,
  isEditing,
  editingName,
  isDragOver,
  revealDir,
  onEditingNameChange,
  onConfirmRename,
  onCancelRename,
  onOpenFolder,
  onRemove,
  onStartRename,
  dropIndicator,
  isDragSource,
  onPointerDown,
}: FavoriteFolderRowProps) {
  return (
    <div
      className="nb-favorites-row"
      data-fav-row-id={folder.id}
      data-fav-row-folder="1"
      data-drop-target={isDragOver}
      onPointerDown={isEditing ? undefined : onPointerDown}
      onClick={onOpenFolder}
      style={{
        position: 'relative',
        opacity: isDragSource ? 0.45 : 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderRadius: 'var(--radius-md, 6px)',
        cursor: 'pointer',
        transition: 'all var(--transition-fast)',
        userSelect: 'none',
      }}
    >
      <DropIndicatorLine position={dropIndicator} />
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
          {revealDir && (
            <Tooltip content="在文件管理器中定位" side="top" sideOffset={4}>
              <button
                type="button"
                aria-label="在文件管理器中定位"
                onClick={() => void ipc.revealInExplorer(revealDir)}
                style={iconBtnStyle}
                className="nb-favorites-hover-button"
              >
                <FolderOpen size={13} />
              </button>
            </Tooltip>
          )}
          <Tooltip content="重命名" side="top" sideOffset={4}>
            <button
              type="button"
              aria-label="重命名"
              onClick={onStartRename}
              style={iconBtnStyle}
              className="nb-favorites-hover-button"
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
              className="nb-favorites-hover-button nb-favorites-danger-button"
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
  dropIndicator: DropIndicator;
  isDragSource: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
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
  dropIndicator,
  isDragSource,
  onPointerDown,
}: FavoriteFileRowProps) {
  return (
    <div
      className="nb-favorites-row"
      data-fav-row-id={item.id}
      data-missing={!exists}
      onPointerDown={isEditing ? undefined : onPointerDown}
      onClick={onOpen}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderRadius: 'var(--radius-md, 6px)',
        cursor: 'pointer',
        transition: 'all var(--transition-fast)',
        userSelect: 'none',
        opacity: isDragSource ? 0.45 : exists ? 1 : 0.75,
      }}
    >
      <DropIndicatorLine position={dropIndicator} />
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
                className="nb-favorites-hover-button"
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
              className="nb-favorites-hover-button"
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
              className="nb-favorites-hover-button nb-favorites-danger-button"
            >
              <X size={14} />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

// ── 拖拽排序插入指示线（画在行间 4px 间隙的中线上） ──

function DropIndicatorLine({ position }: { position: DropIndicator }) {
  if (!position) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: 4,
        right: 4,
        height: 2,
        borderRadius: 1,
        background: 'var(--editor-accent, #3b82f6)',
        pointerEvents: 'none',
        ...(position === 'before' ? { top: -4 } : { bottom: -4 }),
      }}
    />
  );
}

// ── 基础复用样式 ──

const iconBtnStyle: React.CSSProperties = {
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
  border: 'none',
  borderRadius: 4,
  textAlign: 'left',
  cursor: 'pointer',
  fontSize: 12,
  color: 'var(--editor-text)',
  transition: 'all var(--transition-fast)',
};
