// NoteBoard TabBar
// tab 栏 + dnd-kit 排序 + 横向滚动 + 右键上下文操作菜单
// 详见 docs/07-UI布局与交互规范.md §3

import { useRef, useState, useEffect } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
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
  FileText,
  File,
  Database,
  Braces,
  FileCode,
  CodeXml,
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
  Archive,
  Table2,
} from 'lucide-react';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import { useDocumentStore } from '../../stores/documentStore';
import { useExplorerStore } from '../../features/explorer/explorerStore';
import { moveToNewWindow } from '../../features/window/windowManager';
import {
  newMarkdown,
  newMindmap,
  newDrawio,
  newBitable,
  newBoard,
  newMermaid,
  newPlantUml,
  newJson,
  newYaml,
  newSql,
  newXml,
  newText,
  openFileDialog,
  openFolderDialog,
  openStagingArea,
} from '../../features/welcome/welcomeActions';
import * as ipc from '../../core/ipc/commands';
import { getExplorerFileIcon } from '../../features/explorer/fileIcons';
import { checkOpenDocumentStillExists } from '../../features/external/missingFileGuard';

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
}

function TabItem({ tab, isActive, onActivate, onClose }: TabItemProps) {
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

  // 单个 Tab 的外观样式（采用现代圆角卡片设计，短标题自动紧凑缩短，长标题受限截断）
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
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
    // 左右留出充足的间距，防止任何边缘遮挡
    margin: '0 3px',
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
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
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
        title={tab.path ?? tab.displayName}
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

          {tab.path && (
            <>
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

// ── TabBar ──

export function TabBar() {
  const { tabs, activeKey, activateTab, requestCloseTab, reorderTabs } = useWindowStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [newMenuPos, setNewMenuPos] = useState<{ x: number; y: number } | null>(null);
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

  useEffect(() => {
    if (!newMenuPos) return;
    const handleDown = (e: MouseEvent) => {
      // 点击菜单及加号按钮外部时关闭菜单
      if (
        newMenuRef.current &&
        !newMenuRef.current.contains(e.target as Node) &&
        !newBtnRef.current?.contains(e.target as Node)
      ) {
        setNewMenuPos(null);
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [newMenuPos]);

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const fromIndex = tabs.findIndex((t) => t.key === active.id);
    const toIndex = tabs.findIndex((t) => t.key === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    reorderTabs(fromIndex, toIndex);
  };

  // 滚轮横滚
  const handleWheel = (e: React.WheelEvent) => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft += e.deltaY;
    }
  };

  // Tab 栏横向滚动容器
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    height: '100%',
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'none',
    flex: '0 1 auto',
    minWidth: 0,
    padding: '0 4px',
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
    marginLeft: 4,
    marginRight: 6,
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
      <div
        ref={scrollRef}
        style={containerStyle}
        onWheel={handleWheel}
        role="tablist"
      >
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext
            items={tabs.map((t) => t.key)}
            strategy={horizontalListSortingStrategy}
          >
            {tabs.map((tab) => (
              <TabItem
                key={tab.key}
                tab={tab}
                isActive={tab.key === activeKey}
                onActivate={() => handleActivateTab(tab.key)}
                onClose={() => requestCloseTab(tab.key)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* 回到主界面 Home 按钮 */}
      <button
        type="button"
        style={newBtnStyle}
        onClick={() => {
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
        title="回到主界面"
        aria-label="回到主界面"
      >
        <Home size={15} />
      </button>

      {/* 新建标签按钮（+） */}
      <button
        ref={newBtnRef}
        type="button"
        style={newBtnStyle}
        onClick={(e) => {
          e.stopPropagation();
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
        title="新建或打开 (Ctrl+N)"
        aria-label="新建或打开"
      >
        <Plus size={16} />
      </button>

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
            <span>新建 Markdown 笔记 (Ctrl+N)</span>
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
                  <span>飞书多维表格 (.bitable)</span>
                </button>

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

                {/* 新建 YAML 配置文件 */}
                <button
                  type="button"
                  style={getMenuItemStyle(false)}
                  onClick={() => {
                    setNewMenuPos(null);
                    setShowMoreSubMenu(false);
                    newYaml();
                  }}
                  onMouseEnter={handleMenuItemMouseEnter}
                  onMouseLeave={handleMenuItemMouseLeave}
                  onMouseDown={handleMenuItemMouseDown}
                  onMouseUp={handleMenuItemMouseUp}
                >
                  <FileCode size={13} color="#06b6d4" />
                  <span>YAML 配置文件 (.yaml)</span>
                </button>

                {/* 新建 XML 标记文档 */}
                <button
                  type="button"
                  style={getMenuItemStyle(false)}
                  onClick={() => {
                    setNewMenuPos(null);
                    setShowMoreSubMenu(false);
                    newXml();
                  }}
                  onMouseEnter={handleMenuItemMouseEnter}
                  onMouseLeave={handleMenuItemMouseLeave}
                  onMouseDown={handleMenuItemMouseDown}
                  onMouseUp={handleMenuItemMouseUp}
                >
                  <CodeXml size={13} color="#ec4899" />
                  <span>XML 标记文档 (.xml)</span>
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
            <File size={13} />
            <span>打开文件… (Ctrl+O)</span>
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
            <FolderOpen size={13} />
            <span>打开文件夹… (Ctrl+K Ctrl+O)</span>
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
        </div>
      )}
    </div>
  );
}
