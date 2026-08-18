// NoteBoard Markdown 编辑器右键双模上下文菜单
// 1. 选中文本：浮现加粗、斜体、代码、高亮、链接、转换格式、复制剪切
// 2. 未选中文本：浮现标题、代码块、表格、公式、图表、列表等插入菜单
// 详见 docs/07-UI布局与交互规范.md

import React, { useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Highlighter,
  Link,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Table,
  FileCode,
  Sigma,
  GitGraph,
  AlertCircle,
  Minus,
  Copy,
  Scissors,
  Clipboard,
} from 'lucide-react';

interface EditorContextMenuProps {
  editor: Editor;
  position: { x: number; y: number } | null;
  hasSelection: boolean;
  onClose: () => void;
}

export function EditorContextMenu({
  editor,
  position,
  hasSelection,
  onClose,
}: EditorContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!position) return;
    const handleDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
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
    gap: 8,
    width: '100%',
    padding: '6px 12px',
    background: 'transparent',
    border: 'none',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: 12,
    color: 'var(--editor-text)',
    borderRadius: 3,
    userSelect: 'none',
  };

  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: 'var(--editor-border)',
    margin: '4px 0',
  };

  // 视口边界溢出防护
  const adjustedX = Math.min(position.x, window.innerWidth - 200);
  const adjustedY = Math.min(position.y, window.innerHeight - 380);

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        top: Math.max(adjustedY, 40),
        left: Math.max(adjustedX, 10),
        zIndex: 9999,
        background: 'var(--editor-surface)',
        border: '1px solid var(--editor-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        padding: '4px',
        minWidth: 180,
        maxHeight: 380,
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
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Bold size={13} color="var(--editor-accent)" />
            <span>加粗 (Ctrl+B)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleItalic().run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Italic size={13} />
            <span>斜体 (Ctrl+I)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleStrike().run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Strikethrough size={13} />
            <span>删除线 (Ctrl+Shift+S)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleCode().run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Code size={13} color="var(--accent-strong)" />
            <span>行内代码 (`code`)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleHighlight().run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Highlighter size={13} color="var(--warning-600)" />
            <span>文本高亮 (Highlight)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              const url = window.prompt('输入链接地址 URL:');
              if (url) {
                editor.chain().focus().setLink({ href: url }).run();
              }
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Link size={13} />
            <span>插入/修改链接</span>
          </button>

          <div style={dividerStyle} />

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleHeading({ level: 1 }).run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Heading1 size={13} />
            <span>转为一级标题</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleHeading({ level: 2 }).run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Heading2 size={13} />
            <span>转为二级标题</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleBlockquote().run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Quote size={13} />
            <span>转为引用块</span>
          </button>

          <div style={dividerStyle} />

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              document.execCommand('copy');
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Copy size={13} />
            <span>复制 (Ctrl+C)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              document.execCommand('cut');
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Scissors size={13} />
            <span>剪切 (Ctrl+X)</span>
          </button>
        </>
      ) : (
        // ── 模式 B：未选中文本时的富文本插入菜单 ──
        <>
          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleHeading({ level: 1 }).run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Heading1 size={13} color="var(--editor-accent)" />
            <span>一级标题 (H1)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleHeading({ level: 2 }).run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Heading2 size={13} color="var(--editor-accent)" />
            <span>二级标题 (H2)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleHeading({ level: 3 }).run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Heading3 size={13} color="var(--editor-accent)" />
            <span>三级标题 (H3)</span>
          </button>

          <div style={dividerStyle} />

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleCodeBlock().run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <FileCode size={13} color="var(--accent-strong)" />
            <span>插入代码块 (/daima)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Table size={13} />
            <span>插入表格 (3x3)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleTaskList().run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <ListTodo size={13} color="var(--success-600)" />
            <span>任务清单 (Task List)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleBulletList().run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <List size={13} />
            <span>无序列表 (Bullet)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleOrderedList().run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <ListOrdered size={13} />
            <span>有序列表 (Numbered)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().toggleBlockquote().run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Quote size={13} />
            <span>引用块 (Quote)</span>
          </button>

          <div style={dividerStyle} />

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().insertContent({ type: 'mathInline', attrs: { latex: 'E=mc^2' } }).run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Sigma size={13} />
            <span>行内公式 ($...$)</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().insertContent({ type: 'mermaidBlock', attrs: { code: 'graph TD\n  A --> B' } }).run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <GitGraph size={13} color="var(--editor-accent)" />
            <span>Mermaid 图表</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().insertContent({ type: 'githubAlert', attrs: { kind: 'note' }, content: [{ type: 'paragraph' }] }).run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <AlertCircle size={13} color="var(--primary-600)" />
            <span>Note 提示块</span>
          </button>

          <button
            type="button"
            style={btnStyle}
            onClick={() => {
              onClose();
              editor.chain().focus().setHorizontalRule().run();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Minus size={13} />
            <span>水平分割线 (---)</span>
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
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--toolbar-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Clipboard size={13} />
            <span>粘贴 (Ctrl+V)</span>
          </button>
        </>
      )}
    </div>
  );
}
