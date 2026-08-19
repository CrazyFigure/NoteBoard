// NoteBoard 浮层菜单与表格工具条
// 支持选中文本浮层菜单（粗体/斜体/多色高亮/代码/链接/清除格式等）与精美表格操作工具条
// 详见 docs/09-开发路线图.md 8.8, 8.9

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { type Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
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
  Merge,
  Split,
  ChevronDown,
  X,
} from 'lucide-react';

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

  return (
    <button
      type="button"
      title={title}
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
    >
      {icon}
    </button>
  );
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
          <button
            key={item.color}
            type="button"
            title={item.name}
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
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'scale(1.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
            }}
          />
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
          border: '1px solid var(--editor-border, rgba(0,0,0,0.1))',
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

/** 选中文本浮层菜单组件 */
export function EditorBubbleMenu({ editor }: { editor: Editor }) {
  const [showColorPicker, setShowColorPicker] = useState(false);

  if (!editor) return null;

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor, state }: { editor: Editor; state: { selection: { empty: boolean } } }) => {
        const { selection } = state;
        const { empty } = selection;
        if (empty) return false;
        // 不在代码块中显示浮层菜单
        if (editor.isActive('codeBlock')) return false;
        return true;
      }}
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
          title="粗体 (Ctrl+B)"
          icon={<Bold size={16} />}
          onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive('bold')}
        />
        <BubbleButton
          title="斜体 (Ctrl+I)"
          icon={<Italic size={16} />}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive('italic')}
        />
        <BubbleButton
          title="下划线 (Ctrl+U)"
          icon={<Underline size={16} />}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          active={editor.isActive('underline')}
        />
        <BubbleButton
          title="删除线 (Ctrl+Shift+X)"
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
          <button
            type="button"
            title="文本多色高亮"
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
          >
            <Highlighter size={16} />
            <ChevronDown size={12} style={{ opacity: 0.7 }} />
          </button>

          {showColorPicker && (
            <HighlightPalette editor={editor} onClose={() => setShowColorPicker(false)} />
          )}
        </div>

        <MenuDivider />

        <BubbleButton
          title="超链接"
          icon={<Link2 size={16} />}
          onClick={() => {
            const previousUrl = editor.getAttributes('link').href || '';
            const url = window.prompt('输入链接 URL:', previousUrl);
            if (url === null) return;
            if (url === '') {
              editor.chain().focus().extendMarkRange('link').unsetLink().run();
            } else {
              editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
            }
          }}
          active={editor.isActive('link')}
        />

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

/** 向左插入列图标 */
function InsertColumnLeftIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="3" width="14" height="18" rx="2" />
      <path d="M14 3v18" />
      <path d="M4 12h-2" strokeWidth="2.5" />
      <path d="M3 10l-2 2 2 2" strokeWidth="2" />
    </svg>
  );
}

/** 向右插入列图标 */
function InsertColumnRightIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="14" height="18" rx="2" />
      <path d="M10 3v18" />
      <path d="M20 12h2" strokeWidth="2.5" />
      <path d="M21 10l2 2-2 2" strokeWidth="2" />
    </svg>
  );
}

/** 删除列图标 */
function DeleteColumnIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3" />
      <rect x="8" y="3" width="8" height="18" fill="rgba(239, 68, 68, 0.15)" stroke="currentColor" />
      <line x1="10" y1="10" x2="14" y2="14" />
      <line x1="14" y1="10" x2="10" y2="14" />
    </svg>
  );
}

/** 向上插入行图标 */
function InsertRowAboveIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="18" height="14" rx="2" />
      <path d="M3 14h18" />
      <path d="M12 4v-2" strokeWidth="2.5" />
      <path d="M10 3l2-2 2 2" strokeWidth="2" />
    </svg>
  );
}

/** 向下插入行图标 */
function InsertRowBelowIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="14" rx="2" />
      <path d="M3 10h18" />
      <path d="M12 20v2" strokeWidth="2.5" />
      <path d="M10 21l2 2 2-2" strokeWidth="2" />
    </svg>
  );
}

/** 删除行图标 */
function DeleteRowIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3" />
      <rect x="3" y="8" width="18" height="8" fill="rgba(239, 68, 68, 0.15)" stroke="currentColor" />
      <line x1="10" y1="10" x2="14" y2="14" />
      <line x1="14" y1="10" x2="10" y2="14" />
    </svg>
  );
}

/** 表头列图标 */
function HeaderColumnIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect x="3" y="3" width="6" height="18" fill="currentColor" fillOpacity="0.25" />
      <path d="M9 3v18" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
    </svg>
  );
}

/** 表头行图标 */
function HeaderRowIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect x="3" y="3" width="18" height="6" fill="currentColor" fillOpacity="0.25" />
      <path d="M3 9h18" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </svg>
  );
}

/** 表格浮动工具条（精美分类与方向直观区分） */
export function TableToolbar({ editor }: { editor: Editor }) {
  const [show, setShow] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!editor) return;

    const updateToolbar = () => {
      const isInTable = editor.isActive('table');
      setShow(isInTable);

      if (isInTable) {
        const { selection } = editor.state;
        const { $from } = selection;

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
          const rect = tableDom.getBoundingClientRect();
          // 如果表格顶部距离视口很近，工具条下移到表格内部上方
          const topPos = rect.top > 52 ? rect.top - 46 : Math.max(rect.top + 8, 8);
          setPosition({
            top: topPos,
            left: Math.max(rect.left + rect.width / 2, 200),
          });
        }
      }
    };

    editor.on('selectionUpdate', updateToolbar);
    editor.on('transaction', updateToolbar);

    return () => {
      editor.off('selectionUpdate', updateToolbar);
      editor.off('transaction', updateToolbar);
    };
  }, [editor]);

  if (!show) return null;

  return (
    <div
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
      }}
    >
      {/* ── 列操作组（左右插列、删列） ── */}
      <BubbleButton
        title="向左插入列"
        icon={<InsertColumnLeftIcon />}
        onClick={() => editor.chain().focus().addColumnBefore().run()}
      />
      <BubbleButton
        title="向右插入列"
        icon={<InsertColumnRightIcon />}
        onClick={() => editor.chain().focus().addColumnAfter().run()}
      />
      <BubbleButton
        title="删除当前列"
        icon={<DeleteColumnIcon />}
        onClick={() => editor.chain().focus().deleteColumn().run()}
        danger
      />

      <MenuDivider />

      {/* ── 行操作组（上下插行、删行） ── */}
      <BubbleButton
        title="在上方插入行"
        icon={<InsertRowAboveIcon />}
        onClick={() => editor.chain().focus().addRowBefore().run()}
      />
      <BubbleButton
        title="在下方插入行"
        icon={<InsertRowBelowIcon />}
        onClick={() => editor.chain().focus().addRowAfter().run()}
      />
      <BubbleButton
        title="删除当前行"
        icon={<DeleteRowIcon />}
        onClick={() => editor.chain().focus().deleteRow().run()}
        danger
      />

      <MenuDivider />

      {/* ── 表头与单元格操作 ── */}
      <BubbleButton
        title="切换表头行"
        icon={<HeaderRowIcon />}
        onClick={() => editor.chain().focus().toggleHeaderRow().run()}
      />
      <BubbleButton
        title="切换表头列"
        icon={<HeaderColumnIcon />}
        onClick={() => editor.chain().focus().toggleHeaderColumn().run()}
      />
      <BubbleButton
        title="合并选中单元格"
        icon={<Merge size={16} />}
        onClick={() => editor.chain().focus().mergeCells().run()}
      />
      <BubbleButton
        title="拆分单元格"
        icon={<Split size={16} />}
        onClick={() => editor.chain().focus().splitCell().run()}
      />

      <MenuDivider />

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
