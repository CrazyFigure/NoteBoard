// NoteBoard 浮层菜单与表格工具条
// 支持选中文本浮层菜单（粗体/斜体/多色高亮/代码/链接/清除格式等）与精美表格操作工具条
// 详见 docs/09-开发路线图.md 8.8, 8.9

import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from 'react';
import { type Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import { NodeSelection, type Selection } from '@tiptap/pm/state';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Highlighter,
  Link2,
  RemoveFormatting,
  Trash2,
  ChevronDown,
  X,
  ExternalLink,
} from 'lucide-react';
import { handleLinkClick } from './linkHandler';
import { useWindowStore } from '../../stores/windowStore';
import { Tooltip } from '../../components/Tooltip';
import { promptLinkUrl } from '../../components/promptPresets';
import { formatShortcut } from '../../core/shortcuts';

interface BubbleButtonProps {
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  title?: string;
  danger?: boolean;
}

/** 悬浮菜单基础按钮组件（舒适 32px 尺寸与精美悬停/按压动效） */
function BubbleButton({ icon, onClick, active, title, danger }: BubbleButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  let background = 'transparent';
  let color = 'var(--editor-text)';

  if (active) {
    background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.15))';
    color = 'var(--accent-500, #3b82f6)';
  } else if (pressed) {
    background = 'var(--toolbar-active, rgba(0, 0, 0, 0.12))';
  } else if (hovered) {
    if (danger) {
      background = 'rgba(239, 68, 68, 0.12)';
      color = '#ef4444';
    } else {
      background = 'var(--editor-hover-background, rgba(0, 0, 0, 0.06))';
    }
  }

  const btn = (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        setPressed(true);
      }}
      onMouseUp={() => setPressed(false)}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      style={{
        width: 32,
        height: 32,
        minWidth: 32,
        padding: 0,
        border: 'none',
        background,
        color,
        cursor: 'pointer',
        fontSize: 14,
        borderRadius: 6,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform: pressed ? 'scale(0.92)' : hovered ? 'scale(1.06)' : 'scale(1)',
        transition: 'all var(--transition-fast)',
        userSelect: 'none',
      }}
      aria-label={title}
    >
      {icon}
    </button>
  );

  if (title) {
    return (
      <Tooltip content={title} side="top" sideOffset={6}>
        {btn}
      </Tooltip>
    );
  }

  return btn;
}

/** 分组垂直分割线 */
function MenuDivider() {
  return (
    <div
      style={{
        width: 1,
        height: 18,
        background: 'var(--editor-border, rgba(0,0,0,0.12))',
        margin: '0 4px',
        flexShrink: 0,
      }}
    />
  );
}

/** 高亮预设颜色列表 */
const HIGHLIGHT_COLORS = [
  { name: '柠檬黄', color: '#fef08a', border: '#facc15' },
  { name: '清新绿', color: '#bbf7d0', border: '#4ade80' },
  { name: '天空蓝', color: '#bfdbfe', border: '#60a5fa' },
  { name: '浅紫', color: '#e9d5ff', border: '#c084fc' },
  { name: '蜜桃粉', color: '#fbcfe8', border: '#f472b6' },
  { name: '暖阳橙', color: '#fed7aa', border: '#fb923c' },
  { name: '珊瑚红', color: '#fecaca', border: '#f87171' },
  { name: '湖水青', color: '#a5f3fc', border: '#22d3ee' },
];

/** 多色高亮调色盘组件 */
function HighlightPalette({
  editor,
  onClose,
}: {
  editor: Editor;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'var(--editor-surface, #ffffff)',
        border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
        borderRadius: 8,
        boxShadow: '0 8px 24px -4px rgba(0, 0, 0, 0.15), 0 2px 6px -1px rgba(0, 0, 0, 0.08)',
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        zIndex: 1010,
        minWidth: 180,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--editor-text-secondary, #64748b)', paddingLeft: 2 }}>
        选择高亮背景颜色
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {HIGHLIGHT_COLORS.map((item) => (
          <Tooltip key={item.color} content={item.name} side="top" sideOffset={4}>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                editor.chain().focus().toggleHighlight({ color: item.color }).run();
                onClose();
              }}
              style={{
                width: 32,
                height: 26,
                background: item.color,
                border: `1px solid ${item.border}`,
                borderRadius: 4,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'transform 100ms ease',
              }}
              aria-label={item.name}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'scale(1.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              {editor.isActive('highlight', { color: item.color }) && (
                <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.6)', fontWeight: 'bold' }}>✓</span>
              )}
            </button>
          </Tooltip>
        ))}
      </div>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          editor.chain().focus().unsetHighlight().run();
          onClose();
        }}
        style={{
          marginTop: 2,
          padding: '4px 8px',
          border: '1px solid var(--control-border, rgba(0,0,0,0.1))',
          borderRadius: 4,
          background: 'transparent',
          color: 'var(--editor-text-secondary, #64748b)',
          cursor: 'pointer',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
        }}
      >
        <X size={13} />
        <span>清除高亮</span>
      </button>
    </div>
  );
}

/** 从编辑器向外查找真正承载滚动的容器 */
function findScrollParent(editorDom: HTMLElement): HTMLElement {
  let current = editorDom.parentElement;
  while (current) {
    const { overflowY } = window.getComputedStyle(current);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      return current;
    }
    current = current.parentElement;
  }
  return editorDom.parentElement ?? editorDom;
}

/** 判断当前选区是否为表格跨单元格多选（CellSelection） */
function isCellSelection(selection: unknown): boolean {
  if (!selection || typeof selection !== 'object') return false;
  return (
    (selection as { constructor?: { name?: string } }).constructor?.name === 'CellSelection' ||
    '$headCell' in selection ||
    'isCellSelection' in selection
  );
}

/** 选中文本浮层菜单组件 */
export function EditorBubbleMenu({
  editor,
  onOpenLinkModal,
}: {
  editor: Editor;
  onOpenLinkModal?: () => void;
}) {
  const [showColorPicker, setShowColorPicker] = useState(false);

  // EditorContent 挂载时会把正文从 TipTap 临时容器迁入页面；必须等挂载完成后再查找滚动边界。
  // 同时记录编辑器身份，切换实例时不让新菜单沿用旧编辑器的容器。
  const [mountedContainer, setMountedContainer] = useState<{
    editor: Editor;
    scrollParent: HTMLElement;
  } | null>(null);
  useEffect(() => {
    setMountedContainer({ editor, scrollParent: findScrollParent(editor.view.dom) });
  }, [editor]);
  const scrollParent = mountedContainer?.editor === editor ? mountedContainer.scrollParent : undefined;

  // TipTap 3.30 的 BubbleMenu 会在 shouldShow/options 引用变化时派发更新事务。
  // 选区变化期间若每次渲染都创建新对象，会形成 React → TipTap 事务 → React 的
  // 无限更新闭环（React #185）；按 editor 身份稳定所有配置引用。
  const shouldShow = useCallback(({
    editor: currentEditor,
    state,
  }: {
    editor: Editor;
    state: { selection: Selection };
  }) => {
    const { selection } = state;
    if (selection.empty) return false;
    // 不在代码块中显示浮层菜单
    if (currentEditor.isActive('codeBlock')) return false;
    // 跨单元格多选时不弹出行内文本气泡菜单，交由表格工具栏处理
    if (isCellSelection(selection)) return false;
    // 选中原子节点（Mermaid / 信息图 / 公式 / 图片 / HTML 块 / 分割线等）时文本格式无从施加，
    // 且浮层会遮挡节点自带的操作栏；容器类节点（折叠块、提示块等）内含文本，仍保留菜单
    if (selection instanceof NodeSelection && selection.node.isAtom) return false;
    return true;
  }, []);
  const menuElementRef = useRef<HTMLDivElement>(null);
  const bubbleMenuOptions = useMemo(() => ({
    // 首次弹出定位修正：插件在算完第一次位置后才给浮层写入 position: fixed 与 width: max-content，
    // 第一次测量时浮层仍是撑满容器宽度的 absolute 块，shift 把它挤到滚动容器左上角；
    // onShow 在挂载之后、计算位置之前调用，这里提前补齐这两项样式
    onShow: () => {
      const element = menuElementRef.current;
      if (!element) return;
      element.style.position = 'fixed';
      element.style.width = 'max-content';
    },
    strategy: 'fixed' as const,
    placement: 'top' as const,
    offset: 8,
    flip: {
      // 以编辑器滚动容器为边界约束，顶部空间不足时翻转到文本下方。
      boundary: scrollParent,
      padding: 8,
    },
    shift: {
      // 左右与上下边缘预留安全间距，防止浮层超出编辑器视口。
      boundary: scrollParent,
      padding: 8,
    },
    // 监听编辑器真实滚动容器，滚动时即时更新定位与翻转。
    scrollTarget: scrollParent,
  }), [scrollParent]);

  // 未取得真实容器时暂不注册定位插件，避免零尺寸临时边界把菜单挤向窗口左侧。
  if (!scrollParent) return null;

  return (
    <BubbleMenu
      ref={menuElementRef}
      editor={editor}
      shouldShow={shouldShow}
      options={bubbleMenuOptions}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 6px',
          background: 'var(--editor-surface, #ffffff)',
          border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
          borderRadius: 8,
          boxShadow: '0 6px 20px -2px rgba(0, 0, 0, 0.12), 0 2px 6px -1px rgba(0, 0, 0, 0.08)',
          backdropFilter: 'blur(8px)',
          position: 'relative',
          gap: 2,
        }}
      >
        <BubbleButton
          title={formatShortcut('粗体 (Ctrl+B)')}
          icon={<Bold size={16} />}
          onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive('bold')}
        />
        <BubbleButton
          title={formatShortcut('斜体 (Ctrl+I)')}
          icon={<Italic size={16} />}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive('italic')}
        />
        <BubbleButton
          title={formatShortcut('下划线 (Ctrl+U)')}
          icon={<Underline size={16} />}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          active={editor.isActive('underline')}
        />
        <BubbleButton
          title={formatShortcut('删除线 (Ctrl+Shift+X)')}
          icon={<Strikethrough size={16} />}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          active={editor.isActive('strike')}
        />

        <MenuDivider />

        <BubbleButton
          title="行内代码"
          icon={<Code size={16} />}
          onClick={() => editor.chain().focus().toggleCode().run()}
          active={editor.isActive('code')}
        />

        {/* 多色高亮按钮与调色盘 */}
        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <Tooltip content="文本多色高亮" side="top" sideOffset={6} disabled={showColorPicker}>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setShowColorPicker((v) => !v)}
              style={{
                height: 32,
                padding: '0 6px',
                border: 'none',
                background: editor.isActive('highlight')
                  ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.15))'
                  : showColorPicker
                  ? 'var(--editor-hover-background, rgba(0,0,0,0.06))'
                  : 'transparent',
                color: editor.isActive('highlight') ? 'var(--accent-500, #3b82f6)' : 'var(--editor-text)',
                cursor: 'pointer',
                borderRadius: 6,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                transition: 'all 120ms ease',
              }}
              aria-label="文本多色高亮"
            >
              <Highlighter size={16} />
              <ChevronDown size={12} style={{ opacity: 0.7 }} />
            </button>
          </Tooltip>

          {showColorPicker && (
            <HighlightPalette editor={editor} onClose={() => setShowColorPicker(false)} />
          )}
        </div>

        <MenuDivider />

        {/* 超链接设置按钮：优先打开定制美观弹窗 */}
        <BubbleButton
          title={formatShortcut('设置/修改超链接 (Ctrl+K)')}
          icon={<Link2 size={16} />}
          onClick={() => {
            if (onOpenLinkModal) {
              onOpenLinkModal();
            } else {
              const previousUrl = editor.getAttributes('link').href || '';
              void promptLinkUrl(previousUrl).then((url) => {
                if (url === null || editor.isDestroyed) return;
                if (url === '') {
                  editor.chain().focus().extendMarkRange('link').unsetLink().run();
                } else {
                  editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
                }
              });
            }
          }}
          active={editor.isActive('link')}
        />

        {editor.isActive('link') && (
          <BubbleButton
            title={`打开链接: ${editor.getAttributes('link').href || ''}`}
            icon={<ExternalLink size={15} />}
            onClick={() => {
              const href = editor.getAttributes('link').href;
              const activeKey = useWindowStore.getState().activeKey;
              if (href && activeKey) {
                handleLinkClick(href, activeKey);
              }
            }}
          />
        )}

        <BubbleButton
          title="清除格式"
          icon={<RemoveFormatting size={16} />}
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
        />
      </div>
    </BubbleMenu>
  );
}

// ── 表格操作定制矢量图标 ──
// 风格：只画一根行/列，加号放在插入的一侧、删除在条内打叉；笔画与 lucide 一致，保持 16px 下简洁

/** 表格图标公共外壳（与 lucide 默认属性一致） */
function TableIcon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

/** 向左插入列图标 */
function InsertColumnLeftIcon() {
  return (
    <TableIcon>
      <rect x="13" y="3" width="8" height="18" rx="2" />
      <path d="M6 8.5v7" />
      <path d="M2.5 12h7" />
    </TableIcon>
  );
}

/** 向右插入列图标 */
function InsertColumnRightIcon() {
  return (
    <TableIcon>
      <rect x="3" y="3" width="8" height="18" rx="2" />
      <path d="M18 8.5v7" />
      <path d="M14.5 12h7" />
    </TableIcon>
  );
}

/** 删除列图标 */
function DeleteColumnIcon() {
  return (
    <TableIcon>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="m10 10 4 4" />
      <path d="m14 10-4 4" />
    </TableIcon>
  );
}

/** 向上插入行图标 */
function InsertRowAboveIcon() {
  return (
    <TableIcon>
      <rect x="3" y="13" width="18" height="8" rx="2" />
      <path d="M12 2.5v7" />
      <path d="M8.5 6h7" />
    </TableIcon>
  );
}

/** 向下插入行图标 */
function InsertRowBelowIcon() {
  return (
    <TableIcon>
      <rect x="3" y="3" width="18" height="8" rx="2" />
      <path d="M12 14.5v7" />
      <path d="M8.5 18h7" />
    </TableIcon>
  );
}

/** 删除行图标 */
function DeleteRowIcon() {
  return (
    <TableIcon>
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <path d="m10 10 4 4" />
      <path d="m14 10-4 4" />
    </TableIcon>
  );
}

/** 表头列图标 */
function HeaderColumnIcon() {
  return (
    <TableIcon>
      <path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4z" fill="currentColor" fillOpacity="0.3" stroke="none" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </TableIcon>
  );
}

/** 表头行图标 */
function HeaderRowIcon() {
  return (
    <TableIcon>
      <path d="M3 9V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4z" fill="currentColor" fillOpacity="0.3" stroke="none" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
    </TableIcon>
  );
}

/** 合并单元格图标（两侧箭头向中间汇合） */
function MergeCellsIcon() {
  return (
    <TableIcon>
      <path d="M3 12h6" />
      <path d="m6 9 3 3-3 3" />
      <path d="M21 12h-6" />
      <path d="m18 9-3 3 3 3" />
    </TableIcon>
  );
}

/** 拆分单元格图标（从中线向两侧分开） */
function SplitCellIcon() {
  return (
    <TableIcon>
      <path d="M12 5v14" />
      <path d="M8 12H3" />
      <path d="m6 9-3 3 3 3" />
      <path d="M16 12h5" />
      <path d="m18 9 3 3-3 3" />
    </TableIcon>
  );
}

interface TableMenuItem {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

/** 表格下拉菜单项 */
function TableMenuItemButton({ item, onDone }: { item: TableMenuItem; onDone: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  let background = 'transparent';
  if (pressed) {
    background = item.danger ? 'rgba(239, 68, 68, 0.18)' : 'var(--toolbar-active, rgba(0, 0, 0, 0.12))';
  } else if (hovered) {
    background = item.danger ? 'rgba(239, 68, 68, 0.12)' : 'var(--editor-hover-background, rgba(0, 0, 0, 0.06))';
  }

  return (
    <button
      type="button"
      role="menuitem"
      // 阻止默认行为，保留编辑器焦点与单元格选区
      onMouseDown={(e) => {
        e.preventDefault();
        setPressed(true);
      }}
      onMouseUp={() => setPressed(false)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onClick={() => {
        item.onClick();
        onDone();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '6px 10px',
        border: 'none',
        borderRadius: 5,
        background,
        color: item.danger ? '#ef4444' : 'var(--editor-text)',
        cursor: 'pointer',
        fontSize: 13,
        textAlign: 'left',
        whiteSpace: 'nowrap',
        transition: 'background-color 120ms ease',
      }}
    >
      {item.icon}
      <span>{item.label}</span>
    </button>
  );
}

/** 表格工具条下拉按钮（「行」「列」分组，收纳插入、表头与删除） */
function TableDropdown({
  label,
  icon,
  items,
  open,
  onOpenChange,
}: {
  label: string;
  icon: ReactNode;
  items: TableMenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    if (!open) return;
    // 点击下拉外部关闭；只做包含判断，不拦截事件，避免影响其它「点外部关闭」的浮层
    const handleOutsideMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    // Esc 只关闭菜单：窗口捕获阶段拦截，避免连带关闭外层弹层（如多维表格单元格编辑弹层）
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onOpenChange(false);
    };
    document.addEventListener('mousedown', handleOutsideMouseDown);
    window.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      window.removeEventListener('keydown', handleEscape, true);
    };
  }, [open, onOpenChange]);

  let background = 'transparent';
  if (pressed) {
    background = 'var(--toolbar-active, rgba(0, 0, 0, 0.12))';
  } else if (open || hovered) {
    background = 'var(--editor-hover-background, rgba(0, 0, 0, 0.06))';
  }

  // 危险项（删除）前加一条分隔线
  const dangerIndex = items.findIndex((item) => item.danger);

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => {
          e.preventDefault();
          setPressed(true);
        }}
        onMouseUp={() => setPressed(false)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          setPressed(false);
        }}
        onClick={() => onOpenChange(!open)}
        style={{
          height: 32,
          padding: '0 6px 0 8px',
          border: 'none',
          borderRadius: 6,
          background,
          color: 'var(--editor-text)',
          cursor: 'pointer',
          fontSize: 13,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          transform: pressed ? 'scale(0.95)' : 'scale(1)',
          transition: 'background-color 120ms ease, transform 80ms ease',
          userSelect: 'none',
        }}
      >
        {icon}
        <span>{label}</span>
        <ChevronDown size={12} style={{ opacity: 0.6, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease' }} />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            minWidth: 156,
            padding: 4,
            background: 'var(--editor-surface, #ffffff)',
            border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
            borderRadius: 8,
            boxShadow: '0 8px 24px -4px rgba(0, 0, 0, 0.15), 0 2px 6px -1px rgba(0, 0, 0, 0.08)',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 1010,
          }}
        >
          {items.map((item, index) => (
            <div key={item.label}>
              {index === dangerIndex && index > 0 && (
                <div style={{ height: 1, margin: '4px 6px', background: 'var(--editor-border, rgba(0,0,0,0.12))' }} />
              )}
              <TableMenuItemButton item={item} onDone={() => onOpenChange(false)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 表格浮动工具条（行/列分组下拉 + 按需出现的合并/拆分，支持滚动实时跟随与智能避让） */
export function TableToolbar({ editor }: { editor: Editor }) {
  const [show, setShow] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  // 合并/拆分只在可用时出现：多选单元格可合并，光标在已合并单元格内可拆分
  const [cellAction, setCellAction] = useState<'merge' | 'split' | null>(null);
  const [openMenu, setOpenMenu] = useState<'row' | 'column' | null>(null);
  // 用于测量工具条实际高度，计算表格外侧的悬浮位置
  const toolbarRef = useRef<HTMLDivElement>(null);

  // 工具条隐藏时同步收起下拉
  useEffect(() => {
    if (!show) setOpenMenu(null);
  }, [show]);

  const setRowMenuOpen = useCallback((open: boolean) => setOpenMenu(open ? 'row' : null), []);
  const setColumnMenuOpen = useCallback((open: boolean) => setOpenMenu(open ? 'column' : null), []);

  useEffect(() => {
    if (!editor) return;

    const editorDom = editor.view.dom;
    const scrollParent = findScrollParent(editorDom);

    const updateToolbar = () => {
      const isInTable = editor.isActive('table');
      if (!isInTable) {
        setShow(false);
        return;
      }

      const { selection } = editor.state;
      const { $from } = selection;

      // 判断是否有非空普通文本选区（此时用户正在进行划词文本格式化，隐藏表格工具栏避免遮挡）
      const cellSelecting = isCellSelection(selection);
      const hasTextSelection = !selection.empty && !cellSelecting;

      if (hasTextSelection) {
        setShow(false);
        return;
      }

      // 寻找当前 table 节点或最靠近选区的单元格 DOM
      let tableDom: HTMLElement | null = null;
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.name === 'table') {
          const pos = $from.before(d);
          const dom = editor.view.nodeDOM(pos);
          if (dom instanceof HTMLElement) {
            tableDom = dom;
          }
          break;
        }
      }

      if (!tableDom) {
        const dom = editor.view.nodeDOM($from.before(-1));
        if (dom instanceof HTMLElement) {
          tableDom = dom.closest('table') || dom;
        }
      }

      if (tableDom) {
        // nodeDOM 取到的是表格外层包装容器（带内边距），以内部 <table> 的可见边框为准定位
        const tableEl = tableDom.tagName === 'TABLE' ? tableDom : tableDom.querySelector('table') ?? tableDom;
        const rect = tableEl.getBoundingClientRect();
        const containerRect = scrollParent.getBoundingClientRect();

        // 表格完全滚出编辑容器可视区域时隐藏
        if (rect.bottom < containerRect.top + 30 || rect.top > containerRect.bottom - 20) {
          setShow(false);
          return;
        }

        setShow(true);
        setCellAction(editor.can().mergeCells() ? 'merge' : editor.can().splitCell() ? 'split' : null);

        // 计算顶部悬浮位置（工具条常驻显示，尽量放在表格外侧，不遮挡表头）：
        // 1. 表格上方空间足够时，工具条悬浮于表格顶边外侧，留 6px 间隙
        // 2. 表格顶边仍可见但上方空间不足（如表格位于文档开头），改放到表格底边外侧
        // 3. 表格已向上滚出容器顶部，表头本就不可见，工具条吸顶在容器顶部下方安全区（containerRect.top + 8px）
        const toolbarHeight = toolbarRef.current?.offsetHeight ?? 42;
        const gap = 6;
        const aboveTop = rect.top - toolbarHeight - gap;
        const belowTop = rect.bottom + gap;
        let topPos: number;
        if (aboveTop >= containerRect.top + 6) {
          topPos = aboveTop;
        } else if (rect.top >= containerRect.top && belowTop + toolbarHeight <= containerRect.bottom - 6) {
          topPos = belowTop;
        } else {
          topPos = Math.max(rect.top + 8, containerRect.top + 8);
        }

        // 计算水平居中位置，并施加容器边界安全约束（工具条宽约 230px，下拉菜单向右展开，留安全边距）
        const targetLeft = rect.left + rect.width / 2;
        const clampedLeft = Math.max(
          containerRect.left + 130,
          Math.min(targetLeft, containerRect.right - 130)
        );

        setPosition({
          top: topPos,
          left: clampedLeft,
        });
      } else {
        setShow(false);
      }
    };

    editor.on('selectionUpdate', updateToolbar);
    editor.on('transaction', updateToolbar);
    scrollParent.addEventListener('scroll', updateToolbar, { passive: true });
    window.addEventListener('resize', updateToolbar, { passive: true });
    window.addEventListener('scroll', updateToolbar, { passive: true });

    return () => {
      editor.off('selectionUpdate', updateToolbar);
      editor.off('transaction', updateToolbar);
      scrollParent.removeEventListener('scroll', updateToolbar);
      window.removeEventListener('resize', updateToolbar);
      window.removeEventListener('scroll', updateToolbar);
    };
  }, [editor]);

  if (!show) return null;

  return (
    <div
      ref={toolbarRef}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        padding: '4px 6px',
        background: 'var(--editor-surface, #ffffff)',
        border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
        borderRadius: 8,
        boxShadow: '0 6px 20px -2px rgba(0, 0, 0, 0.14), 0 2px 6px -1px rgba(0, 0, 0, 0.08)',
        backdropFilter: 'blur(8px)',
        zIndex: 1000,
        gap: 2,
        userSelect: 'none',
        transition: 'top 80ms ease, opacity 120ms ease',
      }}
    >
      {/* ── 行操作下拉（上下插行、表头行、删行） ── */}
      <TableDropdown
        label="行"
        icon={<InsertRowBelowIcon />}
        open={openMenu === 'row'}
        onOpenChange={setRowMenuOpen}
        items={[
          { label: '在上方插入行', icon: <InsertRowAboveIcon />, onClick: () => editor.chain().focus().addRowBefore().run() },
          { label: '在下方插入行', icon: <InsertRowBelowIcon />, onClick: () => editor.chain().focus().addRowAfter().run() },
          { label: '切换表头行', icon: <HeaderRowIcon />, onClick: () => editor.chain().focus().toggleHeaderRow().run() },
          { label: '删除当前行', icon: <DeleteRowIcon />, onClick: () => editor.chain().focus().deleteRow().run(), danger: true },
        ]}
      />

      {/* ── 列操作下拉（左右插列、表头列、删列） ── */}
      <TableDropdown
        label="列"
        icon={<InsertColumnRightIcon />}
        open={openMenu === 'column'}
        onOpenChange={setColumnMenuOpen}
        items={[
          { label: '向左插入列', icon: <InsertColumnLeftIcon />, onClick: () => editor.chain().focus().addColumnBefore().run() },
          { label: '向右插入列', icon: <InsertColumnRightIcon />, onClick: () => editor.chain().focus().addColumnAfter().run() },
          { label: '切换表头列', icon: <HeaderColumnIcon />, onClick: () => editor.chain().focus().toggleHeaderColumn().run() },
          { label: '删除当前列', icon: <DeleteColumnIcon />, onClick: () => editor.chain().focus().deleteColumn().run(), danger: true },
        ]}
      />

      <MenuDivider />

      {/* ── 合并/拆分：按选区状态只出现其一 ── */}
      {cellAction === 'merge' && (
        <BubbleButton
          title="合并选中单元格"
          icon={<MergeCellsIcon />}
          onClick={() => editor.chain().focus().mergeCells().run()}
        />
      )}
      {cellAction === 'split' && (
        <BubbleButton
          title="拆分单元格"
          icon={<SplitCellIcon />}
          onClick={() => editor.chain().focus().splitCell().run()}
        />
      )}

      {/* ── 删除表格 ── */}
      <BubbleButton
        title="删除整个表格"
        icon={<Trash2 size={16} />}
        onClick={() => editor.chain().focus().deleteTable().run()}
        danger
      />
    </div>
  );
}
