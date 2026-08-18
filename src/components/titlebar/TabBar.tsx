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
} from 'lucide-react';
import { useWindowStore, type Tab } from '../../stores/windowStore';
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
  const { closeOtherTabs, closeTabsRight } = useWindowStore();

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

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 140,
    maxWidth: 240,
    flex: '0 1 180px',
    height: 36,
    padding: '0 12px',
    background: isActive
      ? 'var(--tab-active-bg)'
      : 'var(--tab-inactive-bg)',
    color: isActive
      ? 'var(--editor-text)'
      : 'var(--editor-text-secondary)',
    borderBottom: isActive
      ? '2px solid var(--tab-active-indicator)'
      : '2px solid transparent',
    cursor: 'pointer',
    flexShrink: 0,
    userSelect: 'none',
    position: 'relative',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    fontSize: 13,
  };

  const closeBtnStyle: React.CSSProperties = {
    display: isActive ? 'flex' : 'none',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    borderRadius: 3,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    flexShrink: 0,
    color: 'inherit',
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
          e.currentTarget.querySelector('.tab-close')?.setAttribute('style', 'display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 3px; border: none; background: transparent; cursor: pointer; flex-shrink: 0; color: inherit;');
        }}
        onMouseLeave={(e) => {
          if (!isActive) {
            e.currentTarget.style.background = 'var(--tab-inactive-bg)';
            e.currentTarget.style.color = 'var(--editor-text-secondary)';
            e.currentTarget.querySelector('.tab-close')?.setAttribute('style', 'display: none; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 3px; border: none; background: transparent; cursor: pointer; flex-shrink: 0; color: inherit;');
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

        {/* 文件名 */}
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 160,
            fontStyle: tab.isPreview ? 'italic' : 'normal',
          }}
        >
          {tab.displayName}
        </span>

        {/* 关闭按钮 */}
        <button
          className="tab-close"
          style={closeBtnStyle}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
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
            padding: '4px 0',
            minWidth: 160,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            style={menuItemStyle}
            onClick={() => {
              setMenuPos(null);
              onClose();
            }}
          >
            <X size={13} />
            <span>关闭标签页</span>
          </button>
          <button
            type="button"
            style={menuItemStyle}
            onClick={() => {
              setMenuPos(null);
              closeOtherTabs(tab.key);
            }}
          >
            <span>关闭其他标签页</span>
          </button>
          <button
            type="button"
            style={menuItemStyle}
            onClick={() => {
              setMenuPos(null);
              closeTabsRight(tab.key);
            }}
          >
            <span>关闭右侧标签页</span>
          </button>
          <div style={{ height: 1, background: 'var(--editor-border)', margin: '4px 0' }} />
          <button
            type="button"
            style={menuItemStyle}
            onClick={() => {
              setMenuPos(null);
              moveToNewWindow(tab.key);
            }}
          >
            <ExternalLink size={13} />
            <span>在独立新窗口中打开</span>
          </button>
          {tab.path && (
            <>
              <button
                type="button"
                style={menuItemStyle}
                onClick={() => {
                  setMenuPos(null);
                  if (tab.path) navigator.clipboard.writeText(tab.path);
                }}
              >
                <Copy size={13} />
                <span>复制文件完整路径</span>
              </button>
              <button
                type="button"
                style={menuItemStyle}
                onClick={() => {
                  setMenuPos(null);
                  if (tab.path) ipc.revealInExplorer(tab.path);
                }}
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

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    height: '100%',
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'none',
    flex: '0 1 auto',
    maxWidth: 'calc(100% - 40px)',
  };

  const newBtnStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: 'var(--radius-sm)',
    border: 'none',
    background: 'transparent',
    color: 'var(--editor-text-secondary)',
    cursor: 'pointer',
    flexShrink: 0,
    marginLeft: 4,
    marginRight: 4,
    transition: 'background var(--transition-fast)',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', height: '100%', maxWidth: 'calc(100% - 36px - 46px * 3 - 160px)' }}>
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
                onActivate={() => activateTab(tab.key)}
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
          e.currentTarget.style.color = 'var(--editor-text)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
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
            padding: '4px 0',
            minWidth: 160,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            style={menuItemStyle}
            onClick={() => {
              setNewMenuPos(null);
              newMarkdown();
            }}
          >
            <FileText size={13} color="var(--editor-accent)" />
            <span>新建 Markdown 笔记</span>
          </button>
          <button
            type="button"
            style={menuItemStyle}
            onClick={() => {
              setNewMenuPos(null);
              newBoard();
            }}
          >
            <PencilRuler size={13} color="var(--accent-strong)" />
            <span>新建自由画板</span>
          </button>
          <div style={{ height: 1, background: 'var(--editor-border)', margin: '4px 0' }} />
          <button
            type="button"
            style={menuItemStyle}
            onClick={() => {
              setNewMenuPos(null);
              openFileDialog();
            }}
          >
            <File size={13} />
            <span>打开文件… (Ctrl+O)</span>
          </button>
          <button
            type="button"
            style={menuItemStyle}
            onClick={() => {
              setNewMenuPos(null);
              openFolderDialog();
            }}
          >
            <FolderOpen size={13} />
            <span>打开文件夹… (Ctrl+K Ctrl+O)</span>
          </button>
        </div>
      )}
    </div>
  );
}
