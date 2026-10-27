// NoteBoard TabBar
// tab 栏 + dnd-kit 排序 + 横向滚动 + 右键上下文操作菜单
// 详见 docs/07-UI布局与交互规范.md §3

import { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  X,
  Plus,
  Home,
  Save,
  SaveAll,
  FileText,
  File,
  Database,
  Braces,
  FileCode,
  PencilRuler,
  AlertTriangle,
  Unlink,
  ExternalLink,
  Copy,
  FolderOpen,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Network,
  Layout,
  Workflow,
  GitMerge,
  GitCompare,
  Archive,
  Table2,
  ChartColumn,
  Star,
  FolderSync,
  History,
} from 'lucide-react';
import { Tooltip } from '../Tooltip';
import { on, off } from '../../core/emitter';
import { useLayoutStore } from '../../stores/layoutStore';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import { useDocumentStore } from '../../stores/documentStore';
import { useExplorerStore } from '../../features/explorer/explorerStore';
import { useFavoritesStore } from '../../features/favorites/favoritesStore';
import { findFavoriteByPath } from '../../features/favorites/favoritesUtils';
import { moveToNewWindow } from '../../features/window/windowManager';
import { openVersionHistory } from '../../features/versionHistory/versionHistoryStore';
import { saveDocument, saveAs } from '../../features/editor-code/orchestration/saveDocument';
import {
  newMarkdown,
  newMindmap,
  newDrawio,
  newBitable,
  newBoard,
  newMermaid,
  newPlantUml,
  newInfographic,
  newJson,
  newSql,
  newText,
  newTextDiff,
  openFileDialog,
  openFolderDialog,
  openStagingArea,
  openSyncFolder,
} from '../../features/welcome/welcomeActions';
import * as ipc from '../../core/ipc/commands';
import { getExplorerFileIcon } from '../../features/explorer/fileIcons';
import { checkOpenDocumentStillExists } from '../../features/external/missingFileGuard';
import { useSyncStore } from '../../stores/syncStore';
import { IS_WEB, IS_NATIVE_MOBILE } from '../../core/platform';
import { formatShortcut } from '../../core/shortcuts';
import { dragTab } from '../../features/window/tabDrag';
import { TabDropOverlay } from '../../features/window/TabDropOverlay';
import { useArrivingTabKey, useNativeDraggedTabKey } from '../../features/window/tabDragFeedback';

// ── 类型图标映射 ──

function getTabIcon(tab: Tab) {
  const iconProps = { size: 14, style: { flexShrink: 0 } };

  // 外部变更图标
  if (tab.externalStatus === 'modified' || tab.externalStatus === 'renamed') {
    return <AlertTriangle {...iconProps} color="var(--warning-600)" />;
  }
  if (tab.isDetached) {
    return <Unlink {...iconProps} color="var(--error-500)" />;
  }

  // 文本对比工具 tab：双栏对比语义图标（与「+」菜单/欢迎卡片一致）
  if (tab.toolKind === 'textdiff') {
    return <GitCompare {...iconProps} color="#10b981" />;
  }

  // 统一调用优雅文件格式图标体系
  const targetPathOrName = tab.path || tab.displayName;
  return getExplorerFileIcon(targetPathOrName, { size: 14 });
}

// ── 单个 Tab ──

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
  /** 原生拖动源淡出；新接收标签只播放一次入场动画。 */
  nativeDragging: boolean;
  arriving: boolean;
}

function TabItem({ tab, isActive, onActivate, onClose, nativeDragging, arriving }: TabItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tab.key });

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { tabs, requestCloseOther, requestCloseLeft, requestCloseRight, requestCloseAll } = useWindowStore();

  // 计算当前标签页索引与各方向关闭操作可用状态
  const currentIndex = tabs.findIndex((t) => t.key === tab.key);
  const hasLeft = currentIndex > 0;
  const hasRight = currentIndex >= 0 && currentIndex < tabs.length - 1;
  const hasOther = tabs.length > 1;

  const favoritesData = useFavoritesStore((s) => s.data);
  const isFavorited = Boolean(tab.path && findFavoriteByPath(favoritesData.roots, tab.path));

  // 右键菜单打开时的外部点击关闭监听与全局活跃菜单状态同步
  useEffect(() => {
    if (!menuPos) return;
    // 增加全局活跃菜单计数，使标题栏拖拽空白区知晓当前有菜单浮层处于激活状态
    useLayoutStore.getState().incrementActiveMenu();

    // 点击菜单外部时自动关闭右键菜单
    const handleDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuPos(null);
      }
    };
    // 收到标题栏通知时主动关闭菜单
    const handleCloseEvent = () => {
      setMenuPos(null);
    };

    document.addEventListener('mousedown', handleDown);
    on('close-titlebar-menus', handleCloseEvent);

    return () => {
      // 菜单关闭后减少全局活跃菜单计数
      useLayoutStore.getState().decrementActiveMenu();
      document.removeEventListener('mousedown', handleDown);
      off('close-titlebar-menus', handleCloseEvent);
    };
  }, [menuPos]);

  // 单个 Tab 的外观样式（采用现代圆角卡片设计，短标题自动紧凑缩短，长标题受限截断）
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? 'opacity 120ms ease',
    opacity: isDragging || nativeDragging ? 0.4 : 1,
    animation: arriving && !isDragging ? 'nb-tab-arrive 200ms ease-out' : undefined,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    // 短标题自动紧凑自适应，长标题限制在 200px 并在末端以省略号截断
    minWidth: 80,
    maxWidth: 200,
    width: 'max-content',
    flex: '0 0 auto',
    height: 28,
    padding: '0 6px 0 10px',
    // 左右留出间距，防止边缘遮挡（相邻 Tab 间缝隙为 4px）
    margin: '0 2px',
    borderRadius: 6,
    background: isActive
      ? 'var(--tab-active-bg)'
      : 'var(--tab-inactive-bg)',
    color: isActive
      ? 'var(--editor-text)'
      : 'var(--editor-text-secondary)',
    // 独立清晰的卡片边界线，确保左右与四周边界一目了然
    border: '1px solid var(--tab-border)',
    borderBottom: isActive
      ? '2px solid var(--tab-active-indicator)'
      : '1px solid var(--tab-border)',
    boxShadow: isActive
      ? '0 1px 3px rgba(0, 0, 0, 0.08)'
      : 'none',
    cursor: 'pointer',
    flexShrink: 0,
    userSelect: 'none',
    position: 'relative',
    boxSizing: 'border-box',
    fontFamily: 'var(--ui-font-family, inherit)',
    fontSize: 'var(--ui-font-size, 13px)',
    fontWeight: isActive ? 500 : 400,
  };

  // 关闭按钮样式（位于 Tab 最右侧）
  const closeBtnStyle: React.CSSProperties = {
    display: isActive ? 'flex' : 'none',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    height: 18,
    borderRadius: 4,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    flexShrink: 0,
    marginLeft: 'auto',
    color: 'inherit',
    transition: 'background var(--transition-fast)',
  };

  return (
    <>
      <Tooltip content={tab.path ?? tab.displayName} disabled={Boolean(menuPos)} side="bottom" sideOffset={6}>
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          data-tab-key={tab.key}
          data-tab-arriving={arriving || undefined}
          onClick={onActivate}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenuPos({ x: e.clientX, y: e.clientY });
          }}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onClose();
            }
          }}
          role="tab"
          aria-selected={isActive}
          onMouseEnter={(e) => {
            if (!isActive) {
              e.currentTarget.style.background = 'var(--tab-hover-bg)';
              e.currentTarget.style.color = 'var(--editor-text)';
            }
            const closeBtn = e.currentTarget.querySelector('.tab-close') as HTMLElement;
            if (closeBtn) {
              closeBtn.style.display = 'flex';
            }
          }}
          onMouseLeave={(e) => {
            if (!isActive) {
              e.currentTarget.style.background = 'var(--tab-inactive-bg)';
              e.currentTarget.style.color = 'var(--editor-text-secondary)';
              const closeBtn = e.currentTarget.querySelector('.tab-close') as HTMLElement;
              if (closeBtn) {
                closeBtn.style.display = 'none';
              }
            }
          }}
        >
          {/* 未保存圆点 */}
          {tab.isDirty && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--tab-dirty-dot)',
                flexShrink: 0,
              }}
            />
          )}

          {/* 类型图标 */}
          {getTabIcon(tab)}

          {/* 文件名（自适应占满中间区域，超出以省略号展示） */}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontStyle: tab.isPreview ? 'italic' : 'normal',
            }}
          >
            {tab.displayName}
          </span>

          {/* 关闭按钮（固定靠在 Tab 最右侧） */}
          <button
            className="tab-close"
            onPointerDown={(event) => event.stopPropagation()}
            style={closeBtnStyle}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.transform = 'scale(1.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.transform = 'scale(1)';
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-active)';
              e.currentTarget.style.transform = 'scale(0.9)';
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.transform = 'scale(1.1)';
            }}
            aria-label={`关闭 ${tab.displayName}`}
          >
            <X size={12} />
          </button>
        </div>
      </Tooltip>

      {/* Tab 右键上下文菜单 */}
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
            minWidth: 150,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 关闭当前标签页 */}
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setMenuPos(null);
              onClose();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <X size={13} />
            <span>关闭标签页</span>
          </button>

          {/* 关闭左侧 */}
          <button
            type="button"
            disabled={!hasLeft}
            style={getMenuItemStyle(!hasLeft)}
            onClick={() => {
              if (!hasLeft) return;
              setMenuPos(null);
              requestCloseLeft(tab.key);
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <ChevronLeft size={13} />
            <span>关闭左侧</span>
          </button>

          {/* 关闭右侧 */}
          <button
            type="button"
            disabled={!hasRight}
            style={getMenuItemStyle(!hasRight)}
            onClick={() => {
              if (!hasRight) return;
              setMenuPos(null);
              requestCloseRight(tab.key);
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <ChevronRight size={13} />
            <span>关闭右侧</span>
          </button>

          {/* 关闭其他 */}
          <button
            type="button"
            disabled={!hasOther}
            style={getMenuItemStyle(!hasOther)}
            onClick={() => {
              if (!hasOther) return;
              setMenuPos(null);
              requestCloseOther(tab.key);
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <X size={13} />
            <span>关闭其他</span>
          </button>

          {/* 关闭全部 */}
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setMenuPos(null);
              requestCloseAll();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <Trash2 size={13} />
            <span>关闭全部</span>
          </button>

          {/* 桌面所有标签均通过统一迁移入口打开独立窗口。 */}
          {!IS_WEB && !IS_NATIVE_MOBILE && (
            <>
              <div style={{ height: 1, background: 'var(--editor-border)', margin: '4px 0' }} />

              {/* 在独立新窗口中打开 */}
              <button
                type="button"
                style={getMenuItemStyle(false)}
                onClick={() => {
                  setMenuPos(null);
                  moveToNewWindow(tab.key);
                }}
                onMouseEnter={handleMenuItemMouseEnter}
                onMouseLeave={handleMenuItemMouseLeave}
                onMouseDown={handleMenuItemMouseDown}
                onMouseUp={handleMenuItemMouseUp}
              >
                <ExternalLink size={13} />
                <span>在独立新窗口中打开</span>
              </button>
            </>
          )}

          {tab.path && (
            <>
              {/* 加入收藏夹 / 编辑收藏 */}
              <button
                type="button"
                style={getMenuItemStyle(false)}
                onClick={() => {
                  setMenuPos(null);
                  useFavoritesStore.getState().openAddModal({
                    key: tab.key,
                    displayName: tab.displayName,
                    path: tab.path ?? undefined,
                  });
                }}
                onMouseEnter={handleMenuItemMouseEnter}
                onMouseLeave={handleMenuItemMouseLeave}
                onMouseDown={handleMenuItemMouseDown}
                onMouseUp={handleMenuItemMouseUp}
              >
                <Star
                  size={13}
                  color="#f97316"
                  style={{ fill: isFavorited ? '#f97316' : 'none' }}
                />
                <span>{isFavorited ? '编辑收藏' : '加入收藏夹'}</span>
              </button>

              {/* 查看历史记录（图片与只读查看格式不记录） */}
              {tab.kind !== 'image' && tab.kind !== 'preview' && tab.kind !== 'unsupported' && (
                <button
                  type="button"
                  style={getMenuItemStyle(false)}
                  onClick={() => {
                    setMenuPos(null);
                    openVersionHistory(tab.key);
                  }}
                  onMouseEnter={handleMenuItemMouseEnter}
                  onMouseLeave={handleMenuItemMouseLeave}
                  onMouseDown={handleMenuItemMouseDown}
                  onMouseUp={handleMenuItemMouseUp}
                >
                  <History size={13} />
                  <span>历史记录</span>
                </button>
              )}

              {/* 复制文件名 */}
              <button
                type="button"
                style={getMenuItemStyle(false)}
                onClick={() => {
                  setMenuPos(null);
                  navigator.clipboard.writeText(tab.displayName);
                }}
                onMouseEnter={handleMenuItemMouseEnter}
                onMouseLeave={handleMenuItemMouseLeave}
                onMouseDown={handleMenuItemMouseDown}
                onMouseUp={handleMenuItemMouseUp}
              >
                <Copy size={13} />
                <span>复制文件名</span>
              </button>

              {/* 复制文件完整路径 */}
              <button
                type="button"
                style={getMenuItemStyle(false)}
                onClick={() => {
                  setMenuPos(null);
                  if (tab.path) navigator.clipboard.writeText(tab.path);
                }}
                onMouseEnter={handleMenuItemMouseEnter}
                onMouseLeave={handleMenuItemMouseLeave}
                onMouseDown={handleMenuItemMouseDown}
                onMouseUp={handleMenuItemMouseUp}
              >
                <Copy size={13} />
                <span>复制文件完整路径</span>
              </button>

              {/* 在文件管理器中定位 */}
              <button
                type="button"
                style={getMenuItemStyle(false)}
                onClick={() => {
                  setMenuPos(null);
                  if (tab.path) ipc.revealInExplorer(tab.path);
                }}
                onMouseEnter={handleMenuItemMouseEnter}
                onMouseLeave={handleMenuItemMouseLeave}
                onMouseDown={handleMenuItemMouseDown}
                onMouseUp={handleMenuItemMouseUp}
              >
                <FolderOpen size={13} />
                <span>在文件管理器中定位</span>
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}

// 菜单项基础样式生成函数（支持禁用态）
function getMenuItemStyle(disabled = false): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '6px 10px',
    background: 'transparent',
    border: 'none',
    borderRadius: 4,
    textAlign: 'left',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'var(--ui-font-family, inherit)',
    fontSize: 'calc(var(--ui-font-size, 13px) - 1px)',
    color: disabled ? 'var(--editor-text-muted)' : 'var(--editor-text)',
    opacity: disabled ? 0.45 : 1,
    transition: 'all var(--transition-fast)',
  };
}

// 菜单项鼠标悬停高亮
function handleMenuItemMouseEnter(e: React.MouseEvent<HTMLButtonElement>) {
  if (!e.currentTarget.disabled) {
    e.currentTarget.style.background = 'var(--toolbar-hover)';
  }
}

// 菜单项鼠标移出还原
function handleMenuItemMouseLeave(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.background = 'transparent';
  e.currentTarget.style.transform = 'scale(1)';
}

// 菜单项鼠标按下按压反馈
function handleMenuItemMouseDown(e: React.MouseEvent<HTMLButtonElement>) {
  if (!e.currentTarget.disabled) {
    e.currentTarget.style.background = 'var(--toolbar-active)';
    e.currentTarget.style.transform = 'scale(0.98)';
  }
}

// 菜单项鼠标松开还原
function handleMenuItemMouseUp(e: React.MouseEvent<HTMLButtonElement>) {
  if (!e.currentTarget.disabled) {
    e.currentTarget.style.background = 'var(--toolbar-hover)';
    e.currentTarget.style.transform = 'scale(1)';
  }
}

// ── 自绘横向滚动条 ──

// 滚动条轨道距 Tab 栏左右两端的内缩（与滚动容器 padding 对齐）
const TAB_SCROLLBAR_INSET = 4;
// 滑块最小宽度，标签很多时仍能稳定命中拖动
const TAB_SCROLLBAR_MIN_THUMB = 24;

type TabScrollbarState = {
  visible: boolean;
  thumbLeft: number;
  thumbWidth: number;
};

type TabScrollbarDragState = {
  pointerId: number;
  originX: number;
  originScrollLeft: number;
  maxScrollLeft: number;
  maxThumbTravel: number;
};

const HIDDEN_TAB_SCROLLBAR: TabScrollbarState = { visible: false, thumbLeft: 0, thumbWidth: 0 };

// ── TabBar ──

export function TabBar() {
  const { tabs, activeKey, activateTab, requestCloseTab, reorderTabs } = useWindowStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const nativeDraggedKey = useNativeDraggedTabKey();
  const arrivingKey = useArrivingTabKey();
  // 窗口内沿用原有排序反馈；越出标签栏后只交接一次系统拖放。
  const nativeDragStartedRef = useRef(false);
  // 自绘滚动条：几何状态、悬停/拖动态与拖动起点
  const [scrollbar, setScrollbar] = useState<TabScrollbarState>(HIDDEN_TAB_SCROLLBAR);
  const [scrollbarHovered, setScrollbarHovered] = useState(false);
  const [scrollbarDragging, setScrollbarDragging] = useState(false);
  const scrollbarDragRef = useRef<TabScrollbarDragState | null>(null);
  // 保存弹出菜单状态及引用
  const [saveMenuPos, setSaveMenuPos] = useState<{ x: number; y: number } | null>(null);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  const saveBtnRef = useRef<HTMLButtonElement>(null);

  const [newMenuPos, setNewMenuPos] = useState<{ x: number; y: number } | null>(null);
  // 设置了同步文件夹时「+」菜单显示「打开同步文件夹」
  const syncRoot = useSyncStore((s) => s.config?.sync.rootDir?.trim() || null);
  const [showMoreSubMenu, setShowMoreSubMenu] = useState(false);
  const [flipSubMenuLeft, setFlipSubMenuLeft] = useState(false);
  const subMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moreItemRef = useRef<HTMLDivElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);
  // 新建按钮引用，用于菜单点击外部区域判断
  const newBtnRef = useRef<HTMLButtonElement>(null);

  const handleOpenSubMenu = () => {
    if (subMenuTimerRef.current) {
      clearTimeout(subMenuTimerRef.current);
      subMenuTimerRef.current = null;
    }
    if (moreItemRef.current) {
      const rect = moreItemRef.current.getBoundingClientRect();
      const spaceRight = window.innerWidth - rect.right;
      // 若右侧剩余空间小于 185px，自动向左展开
      setFlipSubMenuLeft(spaceRight < 185);
    }
    setShowMoreSubMenu(true);
  };

  const handleCloseSubMenuDelayed = () => {
    if (subMenuTimerRef.current) clearTimeout(subMenuTimerRef.current);
    subMenuTimerRef.current = setTimeout(() => {
      setShowMoreSubMenu(false);
    }, 180);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // 新建菜单与保存菜单打开时的外部点击关闭监听与全局活跃菜单状态同步
  useEffect(() => {
    if (!newMenuPos && !saveMenuPos) return;
    // 增加全局活跃菜单计数，通知标题栏拖拽空白区临时解除 drag-region
    useLayoutStore.getState().incrementActiveMenu();

    const handleDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // 点击菜单及加号按钮外部时关闭新建菜单
      if (
        newMenuPos &&
        newMenuRef.current &&
        !newMenuRef.current.contains(target) &&
        !newBtnRef.current?.contains(target)
      ) {
        setNewMenuPos(null);
        setShowMoreSubMenu(false);
      }
      // 点击菜单及保存按钮外部时关闭保存菜单
      if (
        saveMenuPos &&
        saveMenuRef.current &&
        !saveMenuRef.current.contains(target) &&
        !saveBtnRef.current?.contains(target)
      ) {
        setSaveMenuPos(null);
      }
    };

    // 收到标题栏通知时主动关闭新建与保存菜单
    const handleCloseEvent = () => {
      setNewMenuPos(null);
      setSaveMenuPos(null);
      setShowMoreSubMenu(false);
    };

    document.addEventListener('mousedown', handleDown);
    on('close-titlebar-menus', handleCloseEvent);

    return () => {
      // 菜单关闭后减少全局活跃菜单计数
      useLayoutStore.getState().decrementActiveMenu();
      document.removeEventListener('mousedown', handleDown);
      off('close-titlebar-menus', handleCloseEvent);
    };
  }, [newMenuPos, saveMenuPos]);

  const handleDragEnd = (e: DragEndEvent) => {
    if (nativeDragStartedRef.current) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const fromIndex = tabs.findIndex((t) => t.key === active.id);
    const toIndex = tabs.findIndex((t) => t.key === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    reorderTabs(fromIndex, toIndex);
  };

  /** 越界时接管桌面鼠标手势；网页、移动端与触摸拖动维持原有排序。 */
  const handleDragMove = (event: DragMoveEvent) => {
    if (IS_WEB || IS_NATIVE_MOBILE || nativeDragStartedRef.current) return;
    const pointer = event.activatorEvent as PointerEvent;
    if (pointer.pointerType !== 'mouse') return;
    const bar = scrollRef.current?.getBoundingClientRect();
    if (!bar) return;
    const x = pointer.clientX + event.delta.x;
    const y = pointer.clientY + event.delta.y;
    // 8px 容差避免正常水平排序中的细微抖动意外拆窗。
    if (y >= bar.top - 8 && y <= bar.bottom + 8 && x >= -8 && x <= window.innerWidth + 8) return;
    nativeDragStartedRef.current = true;
    void dragTab(String(event.active.id)).finally(() => { nativeDragStartedRef.current = false; });
    // 原生拖放接管后结束 DOM 排序传感器，避免松手时重复排序或残留拖动外观。
    document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: pointer.pointerId }));
  };

  // 滚轮横滚
  const handleWheel = (e: React.WheelEvent) => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft += e.deltaY;
    }
  };

  // 按滚动容器的可视比例重算滑块宽度与位置；内容未溢出时隐藏滚动条
  const updateScrollbar = useCallback(() => {
    const el = scrollRef.current;
    const maxScrollLeft = el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0;
    if (!el || maxScrollLeft <= 1) {
      setScrollbar((cur) => (cur.visible ? HIDDEN_TAB_SCROLLBAR : cur));
      return;
    }
    const trackWidth = Math.max(1, el.clientWidth - TAB_SCROLLBAR_INSET * 2);
    const thumbWidth = Math.min(
      trackWidth,
      Math.max(TAB_SCROLLBAR_MIN_THUMB, Math.round((trackWidth * el.clientWidth) / el.scrollWidth)),
    );
    const maxThumbTravel = Math.max(1, trackWidth - thumbWidth);
    const thumbLeft = Math.round((el.scrollLeft / maxScrollLeft) * maxThumbTravel);
    setScrollbar((cur) => (
      cur.visible && cur.thumbLeft === thumbLeft && cur.thumbWidth === thumbWidth
        ? cur
        : { visible: true, thumbLeft, thumbWidth }
    ));
  }, []);

  // 标签增删、改名及切换激活（字重变化）都可能改变溢出量。
  useLayoutEffect(() => {
    updateScrollbar();
  }, [tabs, activeKey, updateScrollbar]);

  // 仅标签顺序或激活项变化时重新定位，避免脏状态等更新打断用户手动横向浏览。
  const tabOrder = JSON.stringify(tabs.map((tab) => tab.key));
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    /** 布局完成后以最小横向位移展示激活标签，不改变编辑器焦点或页面纵向位置。 */
    const syncViewport = () => {
      // 逐项比较路径键，兼容文件名中的引号、反斜杠等 CSS 选择器特殊字符。
      const activeTab = Array.from(el.querySelectorAll<HTMLElement>('[data-tab-key]'))
        .find((tab) => tab.dataset.tabKey === activeKey);
      // 隐藏容器尚无可视宽度，等待尺寸观察回调后再计算，避免写入错误的滚动位置。
      if (activeTab && el.clientWidth > 0) {
        const viewportLeft = el.getBoundingClientRect().left + el.clientLeft;
        const viewportRight = viewportLeft + el.clientWidth;
        const tabRect = activeTab.getBoundingClientRect();
        // 极窄窗口装不下单个标签时优先展示文件名起点；其余情况只修正被裁切的一侧。
        const delta = tabRect.width > el.clientWidth || tabRect.left < viewportLeft
          ? tabRect.left - viewportLeft
          : Math.max(0, tabRect.right - viewportRight);
        if (delta !== 0) {
          const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
          el.scrollLeft = Math.min(maxScrollLeft, Math.max(0, el.scrollLeft + delta));
        }
      }
      // 自动定位后立即同步自绘滑块，不依赖各端 scroll 事件的派发时机。
      updateScrollbar();
    };

    syncViewport();
    // 桌面缩放、分屏与触屏设备横竖屏切换后，重新按容器实际宽度定位。
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncViewport);
      return () => window.removeEventListener('resize', syncViewport);
    }
    const observer = new ResizeObserver(syncViewport);
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeKey, tabOrder, updateScrollbar]);

  // 滚动条隐藏时 pointerleave 不会触发，需手动复位悬停态，避免下次出现时仍是高亮
  useEffect(() => {
    if (!scrollbar.visible) setScrollbarHovered(false);
  }, [scrollbar.visible]);

  // 按下轨道：先把滑块中心移到指针处，再进入拖动，细滑块也无需精确命中
  const startScrollbarDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (e.button !== 0 || !el || !scrollbar.visible) return;
    e.preventDefault();
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    const maxThumbTravel = Math.max(1, e.currentTarget.clientWidth - scrollbar.thumbWidth);
    const trackRect = e.currentTarget.getBoundingClientRect();
    const nextThumbLeft = Math.min(
      maxThumbTravel,
      Math.max(0, e.clientX - trackRect.left - scrollbar.thumbWidth / 2),
    );
    el.scrollLeft = (nextThumbLeft / maxThumbTravel) * maxScrollLeft;
    scrollbarDragRef.current = {
      pointerId: e.pointerId,
      originX: e.clientX,
      originScrollLeft: el.scrollLeft,
      maxScrollLeft,
      maxThumbTravel,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setScrollbarDragging(true);
    updateScrollbar();
  };

  // 拖动中：指针位移按「滑块可移动距离 → 可滚动距离」比例换算
  const moveScrollbarDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = scrollbarDragRef.current;
    const el = scrollRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !el) return;
    const delta = ((e.clientX - drag.originX) / drag.maxThumbTravel) * drag.maxScrollLeft;
    el.scrollLeft = Math.min(drag.maxScrollLeft, Math.max(0, drag.originScrollLeft + delta));
    updateScrollbar();
  };

  const finishScrollbarDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = scrollbarDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    scrollbarDragRef.current = null;
    setScrollbarDragging(false);
  };

  // 滑块配色跟随主题：静止时取次要文字色的淡化版，悬停/拖动时切到主题强调色
  const scrollbarActive = scrollbarHovered || scrollbarDragging;
  const scrollbarThumbColor = scrollbarDragging
    ? 'color-mix(in srgb, var(--accent-strong) 85%, transparent)'
    : scrollbarHovered
      ? 'color-mix(in srgb, var(--accent-strong) 60%, transparent)'
      : 'color-mix(in srgb, var(--editor-text-secondary) 30%, transparent)';

  // Tab 栏横向滚动容器（隐藏原生滚动条，改用下方自绘细滑块）
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    height: '100%',
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'none',
    flex: '0 1 auto',
    minWidth: 0,
    // 左侧不留内边距：应用图标容器自带 10px 留白，再叠加会让首个 Tab 离图标过远
    padding: '0 4px 0 0',
    boxSizing: 'border-box',
  };

  // 新建标签页按钮样式
  const newBtnStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    borderRadius: 6,
    border: '1px solid transparent',
    background: 'transparent',
    color: 'var(--editor-text-secondary)',
    cursor: 'pointer',
    flexShrink: 0,
    // 相邻按钮间缝隙 6px
    margin: '0 3px',
    transition: 'background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast)',
  };

  // 点击激活或重复点击 Tab：激活并平滑定位资源管理器至该文件
  const handleActivateTab = (tabKey: string) => {
    const isCurrentActive = useWindowStore.getState().activeKey === tabKey;
    activateTab(tabKey);
    // 每次点击标签都检查运行期间的外部删除；缺失时由全局处置框接管。
    checkOpenDocumentStillExists(tabKey, true).catch(() => {});
    if (isCurrentActive && !tabKey.startsWith('untitled:')) {
      const doc = useDocumentStore.getState().documents.get(tabKey);
      if (doc?.key) {
        useExplorerStore.getState().setRevealed(doc.key, true);
      }
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', height: '100%', minWidth: 0, flex: '0 1 auto', maxWidth: 'calc(100vw - 210px)' }}>
      {!IS_WEB && !IS_NATIVE_MOBILE && <TabDropOverlay />}
      {/* 滚动外壳：不随内容滚动，为自绘滚动条提供定位基准 */}
      <div style={{ position: 'relative', display: 'flex', height: '100%', minWidth: 0, flex: '0 1 auto' }}>
        <div
          ref={scrollRef}
          className="scrollbar-none"
          style={containerStyle}
          onWheel={handleWheel}
          onScroll={updateScrollbar}
          role="tablist"
        >
          <DndContext sensors={sensors} onDragStart={() => { nativeDragStartedRef.current = false; }}
            onDragMove={handleDragMove} onDragEnd={handleDragEnd}>
            <SortableContext
              items={tabs.map((t) => t.key)}
              strategy={horizontalListSortingStrategy}
            >
              {tabs.map((tab) => (
                <TabItem
                  key={tab.key}
                  tab={tab}
                  isActive={tab.key === activeKey}
                  nativeDragging={tab.key === nativeDraggedKey}
                  arriving={tab.key === arrivingKey}
                  onActivate={() => handleActivateTab(tab.key)}
                  onClose={() => requestCloseTab(tab.key)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        {/* 自绘横向滚动条：只占用 Tab 下方与标题栏底边之间的空隙，不挤占 Tab 及其激活指示线 */}
        {scrollbar.visible && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: TAB_SCROLLBAR_INSET,
              right: TAB_SCROLLBAR_INSET,
              // 命中区向下越过标题栏底边 2px 以便抓取，可见滑块仍居中于空隙内
              bottom: -2,
              height: 6,
              paddingBottom: 2,
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              zIndex: 1,
              touchAction: 'none',
            }}
            onPointerEnter={() => setScrollbarHovered(true)}
            onPointerLeave={() => setScrollbarHovered(false)}
            onPointerDown={startScrollbarDrag}
            onPointerMove={moveScrollbarDrag}
            onPointerUp={finishScrollbarDrag}
            onPointerCancel={finishScrollbarDrag}
          >
            <div
              style={{
                width: scrollbar.thumbWidth,
                height: scrollbarActive ? 3 : 2,
                borderRadius: 999,
                background: scrollbarThumbColor,
                transform: `translateX(${scrollbar.thumbLeft}px)`,
                transition: 'height 120ms ease, background-color 120ms ease',
                willChange: 'transform',
              }}
            />
          </div>
        )}
      </div>

      {/* 保存与另存为快捷按钮 */}
      <Tooltip content="保存与另存为" side="bottom" sideOffset={6} disabled={Boolean(saveMenuPos)}>
        <button
          ref={saveBtnRef}
          type="button"
          style={newBtnStyle}
          onClick={(e) => {
            e.stopPropagation();
            setNewMenuPos(null);
            setShowMoreSubMenu(false);
            // 单击保存按钮切换弹出/关闭菜单
            if (saveMenuPos) {
              setSaveMenuPos(null);
            } else {
              const rect = e.currentTarget.getBoundingClientRect();
              const menuWidth = 160;
              const x = Math.min(rect.left, window.innerWidth - menuWidth - 8);
              setSaveMenuPos({ x, y: rect.bottom + 4 });
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setNewMenuPos(null);
            setShowMoreSubMenu(false);
            // 右键保存按钮弹出菜单
            setSaveMenuPos({ x: e.clientX, y: e.clientY });
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.borderColor = 'var(--tab-border)';
            e.currentTarget.style.color = 'var(--editor-accent)';
            e.currentTarget.style.transform = 'scale(1.08)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = 'transparent';
            e.currentTarget.style.color = 'var(--editor-text-secondary)';
            e.currentTarget.style.transform = 'scale(1)';
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-active)';
            e.currentTarget.style.transform = 'scale(0.92)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.transform = 'scale(1.08)';
          }}
          aria-label="保存与另存为"
        >
          <Save size={15} />
        </button>
      </Tooltip>

      {/* 回到主界面 Home 按钮 */}
      <Tooltip content="回到主界面" side="bottom" sideOffset={6}>
        <button
          type="button"
          style={newBtnStyle}
          onClick={() => {
            setSaveMenuPos(null);
            setNewMenuPos(null);
            setShowMoreSubMenu(false);
            // 切换回到主界面 (将 activeKey 置为 null，保留已打开 tabs)
            useWindowStore.setState({ activeKey: null });
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.borderColor = 'var(--tab-border)';
            e.currentTarget.style.color = 'var(--editor-accent)';
            e.currentTarget.style.transform = 'scale(1.08)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = 'transparent';
            e.currentTarget.style.color = 'var(--editor-text-secondary)';
            e.currentTarget.style.transform = 'scale(1)';
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-active)';
            e.currentTarget.style.transform = 'scale(0.92)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.transform = 'scale(1.08)';
          }}
          aria-label="回到主界面"
        >
          <Home size={15} />
        </button>
      </Tooltip>

      {/* 新建标签按钮（+） */}
      <Tooltip content="新建或打开" side="bottom" sideOffset={6} disabled={Boolean(newMenuPos)}>
        <button
          ref={newBtnRef}
          type="button"
          style={newBtnStyle}
          onClick={(e) => {
            e.stopPropagation();
            setSaveMenuPos(null);
            // 单击加号按钮切换弹出/关闭菜单
            if (newMenuPos) {
              setNewMenuPos(null);
            } else {
              const rect = e.currentTarget.getBoundingClientRect();
              const menuWidth = 180;
              const x = Math.min(rect.left, window.innerWidth - menuWidth - 8);
              setNewMenuPos({ x, y: rect.bottom + 4 });
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setSaveMenuPos(null);
            // 右键加号按钮弹出菜单
            setNewMenuPos({ x: e.clientX, y: e.clientY });
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.borderColor = 'var(--tab-border)';
            e.currentTarget.style.color = 'var(--editor-text)';
            e.currentTarget.style.transform = 'scale(1.08)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = 'transparent';
            e.currentTarget.style.color = 'var(--editor-text-secondary)';
            e.currentTarget.style.transform = 'scale(1)';
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-active)';
            e.currentTarget.style.transform = 'scale(0.92)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.transform = 'scale(1.08)';
          }}
          aria-label="新建或打开"
        >
          <Plus size={16} />
        </button>
      </Tooltip>

      {/* 新建弹出菜单 */}
      {newMenuPos && (
        <div
          ref={newMenuRef}
          style={{
            position: 'fixed',
            top: newMenuPos.y,
            left: newMenuPos.x,
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
          {/* 新建 Markdown 笔记 */}
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              setShowMoreSubMenu(false);
              newMarkdown();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <FileText size={13} color="var(--editor-accent)" />
            <span>新建 Markdown 笔记 (.md)</span>
          </button>

          {/* 新建文本文档 (.txt) */}
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              setShowMoreSubMenu(false);
              newText();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <FileText size={13} color="#64748b" />
            <span>新建文本文档 (.txt)</span>
          </button>

          {/* 新建多维表格 */}
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              setShowMoreSubMenu(false);
              newBitable();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <Table2 size={13} color="#2563eb" />
            <span>新建多维表格 (.bitable)</span>
          </button>

          {/* 新建自由画板 */}
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              setShowMoreSubMenu(false);
              newBoard();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <PencilRuler size={13} color="var(--accent-strong)" />
            <span>新建自由画板 (.excalidraw)</span>
          </button>

          {/* 新建思维导图 */}
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              setShowMoreSubMenu(false);
              newMindmap();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <Network size={13} color="#f97316" />
            <span>新建思维导图 (.mindmap)</span>
          </button>

          {/* 文本对比（纯前端工具视图，不落盘） */}
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              setShowMoreSubMenu(false);
              newTextDiff();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <GitCompare size={13} color="#10b981" />
            <span>文本对比</span>
          </button>

          <div style={{ height: 1, background: 'var(--editor-border)', margin: '4px 0' }} />

          {/* 更多格式新建（带二级菜单，防抖无缝悬停与自适应向左展开） */}
          <div
            ref={moreItemRef}
            style={{ position: 'relative' }}
            onMouseEnter={handleOpenSubMenu}
            onMouseLeave={handleCloseSubMenuDelayed}
          >
            <button
              type="button"
              style={{
                ...getMenuItemStyle(false),
                justifyContent: 'space-between',
              }}
              onClick={() => setShowMoreSubMenu((prev) => !prev)}
              onMouseEnter={handleMenuItemMouseEnter}
              onMouseLeave={handleMenuItemMouseLeave}
              onMouseDown={handleMenuItemMouseDown}
              onMouseUp={handleMenuItemMouseUp}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <FileCode size={13} color="var(--editor-accent)" />
                <span>更多新建格式</span>
              </div>
              <ChevronRight size={13} color="var(--editor-text-muted)" />
            </button>

            {/* 二级菜单 */}
            {showMoreSubMenu && (
              <div
                onMouseEnter={handleOpenSubMenu}
                onMouseLeave={handleCloseSubMenuDelayed}
                style={{
                  position: 'absolute',
                  top: -4,
                  ...(flipSubMenuLeft
                    ? { right: 'calc(100% - 2px)', left: 'auto' }
                    : { left: 'calc(100% - 2px)', right: 'auto' }),
                  zIndex: 10000,
                  background: 'var(--editor-surface)',
                  border: '1px solid var(--editor-border)',
                  borderRadius: 'var(--radius-sm)',
                  boxShadow: 'var(--shadow-md)',
                  padding: '4px',
                  minWidth: 175,
                }}
              >
                {/* 新建 Draw.io 架构图 */}
                <button
                  type="button"
                  style={getMenuItemStyle(false)}
                  onClick={() => {
                    setNewMenuPos(null);
                    setShowMoreSubMenu(false);
                    newDrawio();
                  }}
                  onMouseEnter={handleMenuItemMouseEnter}
                  onMouseLeave={handleMenuItemMouseLeave}
                  onMouseDown={handleMenuItemMouseDown}
                  onMouseUp={handleMenuItemMouseUp}
                >
                  <Layout size={13} color="#ea580c" />
                  <span>Draw.io 架构图 (.drawio)</span>
                </button>

                {/* 新建信息图（.infographic 声明式源码，与 md 内嵌信息图块同源） */}
                <button
                  type="button"
                  style={getMenuItemStyle(false)}
                  onClick={() => {
                    setNewMenuPos(null);
                    setShowMoreSubMenu(false);
                    newInfographic();
                  }}
                  onMouseEnter={handleMenuItemMouseEnter}
                  onMouseLeave={handleMenuItemMouseLeave}
                  onMouseDown={handleMenuItemMouseDown}
                  onMouseUp={handleMenuItemMouseUp}
                >
                  <ChartColumn size={13} color="#14b8a6" />
                  <span>信息图 (.infographic)</span>
                </button>

                {/* 新建 Mermaid 图表 */}
                <button
                  type="button"
                  style={getMenuItemStyle(false)}
                  onClick={() => {
                    setNewMenuPos(null);
                    setShowMoreSubMenu(false);
                    newMermaid();
                  }}
                  onMouseEnter={handleMenuItemMouseEnter}
                  onMouseLeave={handleMenuItemMouseLeave}
                  onMouseDown={handleMenuItemMouseDown}
                  onMouseUp={handleMenuItemMouseUp}
                >
                  <Workflow size={13} color="#00bfb2" />
                  <span>Mermaid 图表 (.mmd)</span>
                </button>

                {/* 新建 PlantUML / UML */}
                <button
                  type="button"
                  style={getMenuItemStyle(false)}
                  onClick={() => {
                    setNewMenuPos(null);
                    setShowMoreSubMenu(false);
                    newPlantUml();
                  }}
                  onMouseEnter={handleMenuItemMouseEnter}
                  onMouseLeave={handleMenuItemMouseLeave}
                  onMouseDown={handleMenuItemMouseDown}
                  onMouseUp={handleMenuItemMouseUp}
                >
                  <GitMerge size={13} color="#a855f7" />
                  <span>PlantUML 建模 (.puml)</span>
                </button>

                <div style={{ height: 1, background: 'var(--editor-border)', margin: '4px 0' }} />

                {/* 新建 JSON 配置文件 */}
                <button
                  type="button"
                  style={getMenuItemStyle(false)}
                  onClick={() => {
                    setNewMenuPos(null);
                    setShowMoreSubMenu(false);
                    newJson();
                  }}
                  onMouseEnter={handleMenuItemMouseEnter}
                  onMouseLeave={handleMenuItemMouseLeave}
                  onMouseDown={handleMenuItemMouseDown}
                  onMouseUp={handleMenuItemMouseUp}
                >
                  <Braces size={13} color="#eab308" />
                  <span>JSON 配置文件 (.json)</span>
                </button>

                {/* 新建 SQL 数据库脚本 */}
                <button
                  type="button"
                  style={getMenuItemStyle(false)}
                  onClick={() => {
                    setNewMenuPos(null);
                    setShowMoreSubMenu(false);
                    newSql();
                  }}
                  onMouseEnter={handleMenuItemMouseEnter}
                  onMouseLeave={handleMenuItemMouseLeave}
                  onMouseDown={handleMenuItemMouseDown}
                  onMouseUp={handleMenuItemMouseUp}
                >
                  <Database size={13} color="#3b82f6" />
                  <span>SQL 数据库脚本 (.sql)</span>
                </button>
              </div>
            )}
          </div>

          <div style={{ height: 1, background: 'var(--editor-border)', margin: '4px 0' }} />

          {/* 打开文件 */}
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              setShowMoreSubMenu(false);
              openFileDialog();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <File size={13} color="#3b82f6" />
            <span>{formatShortcut('打开文件 (Ctrl+O)')}</span>
          </button>

          {/* 打开文件夹 */}
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              setShowMoreSubMenu(false);
              openFolderDialog();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <FolderOpen size={13} color="#eab308" />
            <span>{formatShortcut('打开文件夹 (Ctrl+Shift+O)')}</span>
          </button>

          {/* 收藏夹：打开收藏夹管理弹窗 */}
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              setShowMoreSubMenu(false);
              useFavoritesStore.getState().openFavoritesModal();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <Star size={13} color="#f97316" fill="#f97316" />
            <span>打开收藏夹</span>
          </button>

          {/* 打开暂存区：紧随打开文件夹，载入设置中固定的暂存目录。 */}
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              setShowMoreSubMenu(false);
              openStagingArea();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <Archive size={13} color="#8b5cf6" />
            <span>打开暂存区</span>
          </button>

          {/* 打开同步文件夹：仅在设置了多端同步文件夹时显示 */}
          {syncRoot && (
            <button
              type="button"
              style={getMenuItemStyle(false)}
              onClick={() => {
                setNewMenuPos(null);
                setShowMoreSubMenu(false);
                void openSyncFolder();
              }}
              onMouseEnter={handleMenuItemMouseEnter}
              onMouseLeave={handleMenuItemMouseLeave}
              onMouseDown={handleMenuItemMouseDown}
              onMouseUp={handleMenuItemMouseUp}
            >
              <FolderSync size={13} color="#0ea5e9" />
              <span>打开同步文件夹</span>
            </button>
          )}
        </div>
      )}

      {/* 保存弹出菜单 */}
      {saveMenuPos && (
        <div
          ref={saveMenuRef}
          style={{
            position: 'fixed',
            top: saveMenuPos.y,
            left: saveMenuPos.x,
            zIndex: 9999,
            background: 'var(--editor-surface)',
            border: '1px solid var(--editor-border)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)',
            padding: '4px',
            minWidth: 160,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 保存当前文件 */}
          <button
            type="button"
            disabled={!activeKey}
            style={getMenuItemStyle(!activeKey)}
            onClick={() => {
              setSaveMenuPos(null);
              if (activeKey) {
                saveDocument(activeKey);
              }
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <Save size={13} color={activeKey ? 'var(--editor-accent)' : undefined} />
            <span>{formatShortcut('保存 (Ctrl+S)')}</span>
          </button>

          {/* 另存为 */}
          <button
            type="button"
            disabled={!activeKey}
            style={getMenuItemStyle(!activeKey)}
            onClick={() => {
              setSaveMenuPos(null);
              if (activeKey) {
                saveAs(activeKey, '');
              }
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
            onMouseDown={handleMenuItemMouseDown}
            onMouseUp={handleMenuItemMouseUp}
          >
            <SaveAll size={13} color={activeKey ? '#06b6d4' : undefined} />
            <span>{formatShortcut('另存为 (Ctrl+Shift+S)')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
