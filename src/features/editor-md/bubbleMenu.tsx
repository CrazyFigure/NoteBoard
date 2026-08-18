// NoteBoard 浮层菜单
// extension-bubble-menu，选区上方 8px，空间不足翻下
// 详见 docs/09-开发路线图.md 8.8
//
// 表格浮动工具条 (8.9)

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { type Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';

interface BubbleButtonProps {
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  title?: string;
}

function BubbleButton({ icon, onClick, active, title }: BubbleButtonProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '4px 6px',
        border: 'none',
        background: active ? 'var(--editor-selection-background)' : hovered ? 'var(--editor-hover-background)' : 'transparent',
        color: 'var(--editor-text)',
        cursor: 'pointer',
        fontSize: 14,
        lineHeight: 1,
        borderRadius: 3,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      {icon}
    </button>
  );
}

/** 浮层菜单组件 */
export function EditorBubbleMenu({ editor }: { editor: Editor }) {
  if (!editor) return null;

  const separator = (
    <div style={{ width: 1, height: 16, background: 'var(--editor-border)', margin: '0 2px' }} />
  );

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor, state }: { editor: Editor; state: { selection: { empty: boolean } } }) => {
        const { selection } = state;
        const { empty } = selection;
        if (empty) return false;
        // 不在代码块/数学节点中显示
        if (editor.isActive('codeBlock')) return false;
        return true;
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          padding: '2px 4px',
          background: 'var(--editor-surface)',
          border: '1px solid var(--editor-border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <BubbleButton
          title="粗体"
          icon={<strong>B</strong>}
          onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive('bold')}
        />
        <BubbleButton
          title="斜体"
          icon={<em>I</em>}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive('italic')}
        />
        <BubbleButton
          title="下划线"
          icon={<u>U</u>}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          active={editor.isActive('underline')}
        />
        <BubbleButton
          title="删除线"
          icon={<s>S</s>}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          active={editor.isActive('strike')}
        />
        {separator}
        <BubbleButton
          title="行内代码"
          icon={<code>{'</>'}</code>}
          onClick={() => editor.chain().focus().toggleCode().run()}
          active={editor.isActive('code')}
        />
        <BubbleButton
          title="高亮"
          icon={<span style={{ background: 'var(--editor-accent)', color: 'white', padding: '0 4px', borderRadius: 2, fontSize: 10 }}>H</span>}
          onClick={() => editor.chain().focus().toggleHighlight().run()}
          active={editor.isActive('highlight')}
        />
        {separator}
        <BubbleButton
          title="链接"
          icon={<span>🔗</span>}
          onClick={() => {
            const url = window.prompt('输入链接 URL:');
            if (url) editor.chain().focus().setLink({ href: url }).run();
          }}
          active={editor.isActive('link')}
        />
      </div>
    </BubbleMenu>
  );
}

/** 表格浮动工具条 */
export function TableToolbar({ editor }: { editor: Editor }) {
  const [show, setShow] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!editor) return;

    const updateToolbar = () => {
      const isInTable = editor.isActive('table');
      setShow(isInTable);

      if (isInTable) {
        const { $from } = editor.state.selection;
        const dom = editor.view.nodeDOM($from.before(-1));
        if (dom instanceof HTMLElement) {
          const rect = dom.getBoundingClientRect();
          setPosition({
            top: rect.top - 36,
            left: rect.left + rect.width / 2,
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

  const btn = (icon: ReactNode, action: () => void, title: string) => (
    <BubbleButton
      title={title}
      icon={icon}
      onClick={action}
    />
  );

  return (
    <div
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        padding: '2px 4px',
        background: 'var(--editor-surface)',
        border: '1px solid var(--editor-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        zIndex: 1000,
      }}
    >
      {btn('⬆', () => editor.chain().focus().addColumnBefore().run(), '左插列')}
      {btn('⬇', () => editor.chain().focus().addColumnAfter().run(), '右插列')}
      {btn('✖', () => editor.chain().focus().deleteColumn().run(), '删列')}
      {separator()}
      {btn('↑', () => editor.chain().focus().addRowBefore().run(), '上插行')}
      {btn('↓', () => editor.chain().focus().addRowAfter().run(), '下插行')}
      {btn('✕', () => editor.chain().focus().deleteRow().run(), '删行')}
      {separator()}
      {btn('☰', () => editor.chain().focus().toggleHeaderColumn().run(), '切换表头列')}
      {btn('⊟', () => editor.chain().focus().mergeCells().run(), '合并')}
      {btn('⊞', () => editor.chain().focus().splitCell().run(), '拆分')}
      {separator()}
      {btn('🗑', () => editor.chain().focus().deleteTable().run(), '删表')}
    </div>
  );
}

function separator() {
  return <div style={{ width: 1, height: 16, background: 'var(--editor-border)', margin: '0 2px' }} />;
}
