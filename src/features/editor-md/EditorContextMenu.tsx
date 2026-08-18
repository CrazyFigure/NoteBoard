// NoteBoard Markdown 编辑器右键双模上下文菜单
// 1. 选中文本：浮现加粗、斜体、代码、多色高亮(二级菜单)、标题转换(H1~H6二级菜单)、引用、复制剪切
// 2. 未选中文本：浮现标题(H1~H6二级菜单)、提示块(二级菜单)、列表(二级菜单)、代码块、表格、公式、图表等
// 详见 docs/07-UI布局与交互规范.md

import React, { useState, useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Highlighter,
  Link,
  Heading,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Table,
  FileCode,
  Sigma,
  Workflow,
  Boxes,
  Info,
  Lightbulb,
  AlertCircle,
  AlertTriangle,
  Flame,
  Minus,
  Copy,
  Scissors,
  Clipboard,
  ChevronRight,
  RemoveFormatting,
  X,
} from 'lucide-react';

interface EditorContextMenuProps {
  editor: Editor;
  position: { x: number; y: number } | null;
  hasSelection: boolean;
  onClose: () => void;
}

/** 高亮颜色选项 */
const HIGHLIGHT_COLOR_OPTIONS = [
  { name: '柠檬黄', color: '#fef08a', border: '#facc15' },
  { name: '清新绿', color: '#bbf7d0', border: '#4ade80' },
  { name: '天空蓝', color: '#bfdbfe', border: '#60a5fa' },
  { name: '浅紫', color: '#e9d5ff', border: '#c084fc' },
  { name: '蜜桃粉', color: '#fbcfe8', border: '#f472b6' },
  { name: '暖阳橙', color: '#fed7aa', border: '#fb923c' },
  { name: '珊瑚红', color: '#fecaca', border: '#f87171' },
  { name: '湖水青', color: '#a5f3fc', border: '#22d3ee' },
];

export function EditorContextMenu({
  editor,
  position,
  hasSelection,
  onClose,
}: EditorContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // 二级子菜单容器引用，防止全局 mousedown 误判为点击外部而关闭
  const submenuRef = useRef<HTMLDivElement>(null);
  // 当前激活的二级子菜单标识
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ top: number; left: number; flipLeft: boolean }>({
    top: 0,
    left: 0,
    flipLeft: false,
  });

  useEffect(() => {
    if (!position) return;
    const handleDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // 检查点击目标是否在主菜单或二级子菜单内部
      const isInsideMenu = menuRef.current?.contains(target);
      const isInsideSubmenu = submenuRef.current?.contains(target);
      if (!isInsideMenu && !isInsideSubmenu) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [position, onClose]);

  if (!position) return null;

  const btnStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '7px 12px',
    background: 'transparent',
    border: 'none',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: 13,
    color: 'var(--editor-text, #1e293b)',
    borderRadius: 6,
    userSelect: 'none',
    transition: 'background 100ms ease',
  };

  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: 'var(--editor-border, rgba(0,0,0,0.08))',
    margin: '4px 0',
  };

  // 计算主菜单位置与越界防护
  const adjustedX = Math.min(position.x, window.innerWidth - 220);
  const adjustedY = Math.min(position.y, window.innerHeight - 440);

  // 打开二级子菜单并计算位置
  const handleOpenSubmenu = (submenuKey: string, e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const spaceOnRight = window.innerWidth - rect.right;
    const flipLeft = spaceOnRight < 190;
    setSubmenuPos({
      top: rect.top,
      left: flipLeft ? rect.left - 185 : rect.right + 4,
      flipLeft,
    });
    setActiveSubmenu(submenuKey);
  };

  return (
    <>
      {/* ── 主右键菜单容器 ── */}
      <div
        ref={menuRef}
        style={{
          position: 'fixed',
          top: Math.max(adjustedY, 40),
          left: Math.max(adjustedX, 10),
          zIndex: 9999,
          background: 'var(--editor-surface, #ffffff)',
          border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
          borderRadius: 8,
          boxShadow: '0 10px 30px -4px rgba(0, 0, 0, 0.16), 0 3px 8px -2px rgba(0, 0, 0, 0.08)',
          backdropFilter: 'blur(8px)',
          padding: '5px',
          minWidth: 195,
          maxHeight: 460,
          overflowY: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {hasSelection ? (
          // ── 模式 A：选中文本时的格式化与编辑菜单 ──
          <>
            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().toggleBold().run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Bold size={15} color="var(--accent-500, #3b82f6)" />
                <span>加粗 (Ctrl+B)</span>
              </div>
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().toggleItalic().run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Italic size={15} />
                <span>斜体 (Ctrl+I)</span>
              </div>
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().toggleStrike().run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Strikethrough size={15} />
                <span>删除线</span>
              </div>
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().toggleCode().run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Code size={15} />
                <span>行内代码</span>
              </div>
            </button>

            {/* ── 文本高亮 (带多色二级子菜单) ── */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'selection-highlight'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('selection-highlight', e)}
              onClick={(e) => handleOpenSubmenu('selection-highlight', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Highlighter size={15} color="#eab308" />
                <span>文本高亮颜色</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                const previousUrl = editor.getAttributes('link').href || '';
                const url = window.prompt('输入链接地址 URL:', previousUrl);
                if (url === null) return;
                if (url === '') {
                  editor.chain().focus().unsetLink().run();
                } else {
                  editor.chain().focus().setLink({ href: url }).run();
                }
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Link size={15} />
                <span>超链接</span>
              </div>
            </button>

            <div style={dividerStyle} />

            {/* ── 转为标题 (带 H1~H6 二级子菜单) ── */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'selection-heading'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('selection-heading', e)}
              onClick={(e) => handleOpenSubmenu('selection-heading', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Heading size={15} color="var(--accent-500, #3b82f6)" />
                <span>转为标题 (H1~H6)</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().toggleBlockquote().run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Quote size={15} />
                <span>转为引用块</span>
              </div>
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().unsetAllMarks().clearNodes().run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <RemoveFormatting size={15} />
                <span>清除格式</span>
              </div>
            </button>

            <div style={dividerStyle} />

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                document.execCommand('copy');
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Copy size={15} />
                <span>复制 (Ctrl+C)</span>
              </div>
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                document.execCommand('cut');
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Scissors size={15} />
                <span>剪切 (Ctrl+X)</span>
              </div>
            </button>
          </>
        ) : (
          // ── 模式 B：未选中文本时的富文本插入菜单 ──
          <>
            {/* ── 插入标题 (带 H1~H6 二级子菜单) ── */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'insert-heading'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('insert-heading', e)}
              onClick={(e) => handleOpenSubmenu('insert-heading', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Heading size={15} color="var(--accent-500, #3b82f6)" />
                <span>插入标题 (H1~H6)</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            {/* ── 插入列表 (带二级子菜单) ── */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'insert-list'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('insert-list', e)}
              onClick={(e) => handleOpenSubmenu('insert-list', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <List size={15} />
                <span>插入列表</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            {/* ── GitHub 提示块 (带二级子菜单) ── */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'insert-alert'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('insert-alert', e)}
              onClick={(e) => handleOpenSubmenu('insert-alert', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Boxes size={15} color="#3b82f6" />
                <span>GitHub 提示块</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            <div style={dividerStyle} />

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Table size={15} />
                <span>插入表格 (3x3)</span>
              </div>
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().toggleCodeBlock().run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FileCode size={15} color="var(--accent-strong, #6366f1)" />
                <span>插入代码块</span>
              </div>
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().toggleBlockquote().run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Quote size={15} />
                <span>插入引用块</span>
              </div>
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().setHorizontalRule().run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Minus size={15} />
                <span>水平分割线 (---)</span>
              </div>
            </button>

            <div style={dividerStyle} />

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().insertContent({ type: 'mathInline', attrs: { latex: 'E=mc^2' } }).run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Sigma size={15} />
                <span>行内公式 ($...$)</span>
              </div>
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().insertContent({ type: 'mermaidBlock', attrs: { code: 'graph TD\n  A --> B' } }).run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Workflow size={15} color="var(--accent-500, #3b82f6)" />
                <span>Mermaid 图表</span>
              </div>
            </button>

            <div style={dividerStyle} />

            <button
              type="button"
              style={btnStyle}
              onClick={async () => {
                onClose();
                try {
                  const text = await navigator.clipboard.readText();
                  if (text) {
                    editor.chain().focus().insertContent(text).run();
                  }
                } catch {
                  document.execCommand('paste');
                }
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Clipboard size={15} />
                <span>粘贴 (Ctrl+V)</span>
              </div>
            </button>
          </>
        )}
      </div>

      {/* ── 独立二级子菜单浮层 ── */}
      {activeSubmenu && (
        <div
          ref={submenuRef}
          style={{
            position: 'fixed',
            top: Math.min(submenuPos.top, window.innerHeight - 300),
            left: submenuPos.left,
            zIndex: 10000,
            background: 'var(--editor-surface, #ffffff)',
            border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
            borderRadius: 8,
            boxShadow: '0 10px 30px -4px rgba(0, 0, 0, 0.18), 0 3px 8px -2px rgba(0, 0, 0, 0.08)',
            backdropFilter: 'blur(8px)',
            padding: '5px',
            minWidth: 170,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 二级：高亮颜色挑选 */}
          {activeSubmenu === 'selection-highlight' && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--editor-text-secondary, #64748b)', padding: '4px 8px' }}>
                选择高亮颜色
              </div>
              {HIGHLIGHT_COLOR_OPTIONS.map((item) => (
                <button
                  key={item.color}
                  type="button"
                  style={btnStyle}
                  onClick={() => {
                    // 执行文本高亮
                    editor.chain().focus().toggleHighlight({ color: item.color }).run();
                    onClose();
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 3,
                        background: item.color,
                        border: `1px solid ${item.border}`,
                      }}
                    />
                    <span>{item.name}</span>
                  </div>
                </button>
              ))}
              <div style={dividerStyle} />
              <button
                type="button"
                style={btnStyle}
                onClick={() => {
                  // 清除高亮标记
                  editor.chain().focus().unsetHighlight().run();
                  onClose();
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--editor-text-secondary, #64748b)' }}>
                  <X size={14} />
                  <span>清除高亮</span>
                </div>
              </button>
            </>
          )}

          {/* 二级：标题 H1~H6 */}
          {(activeSubmenu === 'selection-heading' || activeSubmenu === 'insert-heading') && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--editor-text-secondary, #64748b)', padding: '4px 8px' }}>
                标题层级 (H1~H6)
              </div>
              {[
                { level: 1 as const, label: '一级标题 (H1)', icon: <Heading1 size={15} /> },
                { level: 2 as const, label: '二级标题 (H2)', icon: <Heading2 size={15} /> },
                { level: 3 as const, label: '三级标题 (H3)', icon: <Heading3 size={15} /> },
                { level: 4 as const, label: '四级标题 (H4)', icon: <Heading4 size={15} /> },
                { level: 5 as const, label: '五级标题 (H5)', icon: <Heading5 size={15} /> },
                { level: 6 as const, label: '六级标题 (H6)', icon: <Heading6 size={15} /> },
              ].map((h) => (
                <button
                  key={h.level}
                  type="button"
                  style={btnStyle}
                  onClick={() => {
                    // 设置或切换对应层级的标题
                    editor.chain().focus().toggleHeading({ level: h.level }).run();
                    onClose();
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {h.icon}
                    <span>{h.label}</span>
                  </div>
                </button>
              ))}
            </>
          )}

          {/* 二级：列表类型 */}
          {activeSubmenu === 'insert-list' && (
            <>
              <button
                type="button"
                style={btnStyle}
                onClick={() => {
                  // 插入或切换任务待办列表
                  editor.chain().focus().toggleTaskList().run();
                  onClose();
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ListTodo size={15} color="#10b981" />
                  <span>任务清单 (Todo)</span>
                </div>
              </button>

              <button
                type="button"
                style={btnStyle}
                onClick={() => {
                  // 插入或切换无序圆点列表
                  editor.chain().focus().toggleBulletList().run();
                  onClose();
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <List size={15} />
                  <span>无序列表 (Bullet)</span>
                </div>
              </button>

              <button
                type="button"
                style={btnStyle}
                onClick={() => {
                  // 插入或切换数字编号有序列表
                  editor.chain().focus().toggleOrderedList().run();
                  onClose();
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ListOrdered size={15} />
                  <span>有序列表 (Numbered)</span>
                </div>
              </button>
            </>
          )}

          {/* 二级：GitHub 提示块 */}
          {activeSubmenu === 'insert-alert' && (
            <>
              {[
                { kind: 'note' as const, label: 'Note 提示', icon: <Info size={15} color="#3b82f6" /> },
                { kind: 'tip' as const, label: 'Tip 建议', icon: <Lightbulb size={15} color="#10b981" /> },
                { kind: 'important' as const, label: 'Important 重要', icon: <AlertCircle size={15} color="#8b5cf6" /> },
                { kind: 'warning' as const, label: 'Warning 警告', icon: <AlertTriangle size={15} color="#f59e0b" /> },
                { kind: 'caution' as const, label: 'Caution 危险', icon: <Flame size={15} color="#ef4444" /> },
              ].map((a) => (
                <button
                  key={a.kind}
                  type="button"
                  style={btnStyle}
                  onClick={() => {
                    // 插入 GitHub 风格的彩色提示警告块
                    editor.chain().focus().insertContent({ type: 'githubAlert', attrs: { kind: a.kind }, content: [{ type: 'paragraph' }] }).run();
                    onClose();
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {a.icon}
                    <span>{a.label}</span>
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}

