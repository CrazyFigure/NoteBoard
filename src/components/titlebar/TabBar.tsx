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
  FileText,
  File,
  Database,
  Braces,
  FileCode,
  CodeXml,
  PencilRuler,
  AlertTriangle,
  Unlink,
  FileQuestion,
  ExternalLink,
  Copy,
  FolderOpen,
  ChevronLeft,
  ChevronRight,
  Trash2,
} from 'lucide-react';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import { useDocumentStore } from '../../stores/documentStore';
import { useExplorerStore, sameKey } from '../../features/explorer/explorerStore';
import { extFromPath } from '../../core/docKind';
import { moveToNewWindow } from '../../features/window/windowManager';
import {
  newMarkdown,
  newBoard,
  openFileDialog,
  openFolderDialog,
} from '../../features/welcome/welcomeActions';
import * as ipc from '../../core/ipc/commands';

// ── 类型图标映射 ──

function getTabIcon(tab: Tab) {
  const ext = tab.path ? extFromPath(tab.path) : '';
  const iconProps = { size: 14, style: { flexShrink: 0 } };

  // 外部变更图标
  if (tab.externalStatus === 'modified' || tab.externalStatus === 'renamed') {
    return <AlertTriangle {...iconProps} color="var(--warning-600)" />;
  }
  if (tab.isDetached) {
    return <Unlink {...iconProps} color="var(--error-500)" />;
  }

  switch (ext) {
    case 'md':
    case 'markdown':
      return <FileText {...iconProps} color="var(--editor-accent)" />;
    case 'txt':
    case 'log':
      return <File {...iconProps} color="var(--editor-text-muted)" />;
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
      if (!ext) return <File {...iconProps} color="var(--editor-text-muted)" />;
      return <FileQuestion {...iconProps} color="var(--editor-text-muted)" />;
  }
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
  const { tabs, closeOtherTabs, closeTabsLeft, closeTabsRight, closeAllTabs } = useWindowStore();

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
    fontFamily: 'inherit',
    fontSize: 13,
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
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
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
              closeTabsLeft(tab.key);
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
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
              closeTabsRight(tab.key);
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
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
              closeOtherTabs(tab.key);
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
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
              closeAllTabs();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
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
          >
            <ExternalLink size={13} />
            <span>在独立新窗口中打开</span>
          </button>

          {tab.path && (
            <>
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
    fontSize: 12,
    color: disabled ? 'var(--editor-text-muted)' : 'var(--editor-text)',
    opacity: disabled ? 0.45 : 1,
    transition: 'background var(--transition-fast)',
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
}

// ── TabBar ──

export function TabBar() {
  const { tabs, activeKey, activateTab, closeTab, reorderTabs } = useWindowStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [newMenuPos, setNewMenuPos] = useState<{ x: number; y: number } | null>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => {
    if (!newMenuPos) return;
    const handleDown = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
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

  // 点击激活或重复点击 Tab：激活并主动定位资源管理器至该文件所在目录
  const handleActivateTab = (tabKey: string) => {
    activateTab(tabKey);
    const doc = useDocumentStore.getState().documents.get(tabKey);
    if (doc?.dirPath) {
      const { root, setRoot, setRevealed } = useExplorerStore.getState();
      if (!sameKey(root, doc.dirPath)) {
        ipc.readDir(doc.dirPath, false).then((nodes) => {
          setRoot(doc.dirPath, nodes);
          if (doc.key) {
            setRevealed(doc.key);
          }
        });
      } else {
        if (doc.key) {
          setRevealed(doc.key);
        }
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
                onClose={() => closeTab(tab.key)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* 新建标签按钮（+） */}
      <button
        type="button"
        style={newBtnStyle}
        onClick={() => newMarkdown()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setNewMenuPos({ x: e.clientX, y: e.clientY });
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--toolbar-hover)';
          e.currentTarget.style.borderColor = 'var(--tab-border)';
          e.currentTarget.style.color = 'var(--editor-text)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.borderColor = 'transparent';
          e.currentTarget.style.color = 'var(--editor-text-secondary)';
        }}
        title="新建 Markdown 笔记 (Ctrl+N) · 右键更多"
        aria-label="新建标签页"
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
            minWidth: 160,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              newMarkdown();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
          >
            <FileText size={13} color="var(--editor-accent)" />
            <span>新建 Markdown 笔记</span>
          </button>
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              newBoard();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
          >
            <PencilRuler size={13} color="var(--accent-strong)" />
            <span>新建自由画板</span>
          </button>
          <div style={{ height: 1, background: 'var(--editor-border)', margin: '4px 0' }} />
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              openFileDialog();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
          >
            <File size={13} />
            <span>打开文件… (Ctrl+O)</span>
          </button>
          <button
            type="button"
            style={getMenuItemStyle(false)}
            onClick={() => {
              setNewMenuPos(null);
              openFolderDialog();
            }}
            onMouseEnter={handleMenuItemMouseEnter}
            onMouseLeave={handleMenuItemMouseLeave}
          >
            <FolderOpen size={13} />
            <span>打开文件夹… (Ctrl+K Ctrl+O)</span>
          </button>
        </div>
      )}
    </div>
  );
}
