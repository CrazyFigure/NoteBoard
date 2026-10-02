// NoteBoard 代码/纯文本编辑器（CodeMirror 6）右键菜单
// 覆盖 txt、json、yaml、sql 等所有走 CodeEditor 的格式；当前仅提供「复制」「粘贴」
// 视觉与 Markdown 编辑器右键菜单（editor-md/EditorContextMenu.tsx）保持一致，全部取主题 CSS 变量

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { Copy, Clipboard } from 'lucide-react';

interface CodeEditorContextMenuProps {
  view: EditorView;
  position: { x: number; y: number };
  onClose: () => void;
}

/** 读取当前所有非空选区的文本（多光标选区按行分隔符拼接） */
function getSelectedText(view: EditorView): string {
  const { state } = view;
  return state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => state.sliceDoc(range.from, range.to))
    .join(state.lineBreak);
}

export function CodeEditorContextMenu({ view, position, onClose }: CodeEditorContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // 打开菜单时快照选中文本，有内容才允许复制
  const [selectedText] = useState(() => getSelectedText(view));
  const canCopy = selectedText.length > 0;
  // 实测菜单尺寸后的防溢出坐标
  const [pos, setPos] = useState(position);

  // 首帧布局后按真实尺寸修正位置，避免贴近窗口右/下边缘时溢出
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const x = position.x + width > window.innerWidth - 8 ? Math.max(8, position.x - width) : position.x;
    const y = position.y + height > window.innerHeight - 8 ? Math.max(8, position.y - height) : position.y;
    setPos({ x, y });
  }, [position]);

  // 点击外部、按 Esc、滚动、窗口失焦或尺寸变化时关闭菜单
  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        view.focus();
      }
    };
    document.addEventListener('mousedown', handleDown, true);
    document.addEventListener('keydown', handleKey, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    view.scrollDOM.addEventListener('scroll', onClose);
    return () => {
      document.removeEventListener('mousedown', handleDown, true);
      document.removeEventListener('keydown', handleKey, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      view.scrollDOM.removeEventListener('scroll', onClose);
    };
  }, [view, onClose]);

  // 复制：直接写入系统剪贴板（写权限无需授权），失败时回退原生 copy 命令
  const handleCopy = async () => {
    if (!canCopy) return;
    onClose();
    view.focus();
    try {
      await navigator.clipboard.writeText(selectedText);
    } catch {
      document.execCommand('copy');
    }
  };

  // 粘贴：读取剪贴板文本替换当前选区，标记为 input.paste 以进入统一撤销历史
  const handlePaste = async () => {
    onClose();
    view.focus();
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      view.dispatch(view.state.replaceSelection(text), {
        userEvent: 'input.paste',
        scrollIntoView: true,
      });
    } catch {
      document.execCommand('paste');
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      className="nb-context-menu"
      style={{
        position: 'fixed',
        top: pos.y,
        left: pos.x,
        zIndex: 9999,
        background: 'var(--editor-surface, #ffffff)',
        border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
        borderRadius: 8,
        boxShadow: '0 10px 30px -4px rgba(0, 0, 0, 0.16), 0 3px 8px -2px rgba(0, 0, 0, 0.08)',
        backdropFilter: 'blur(8px)',
        padding: 5,
        minWidth: 168,
      }}
      onMouseDown={(e) => {
        // 阻止按下时编辑器失焦导致选区高亮消失
        e.preventDefault();
      }}
      onContextMenu={(e) => {
        // 菜单内右键不冒泡到编辑器容器，避免菜单被重新定位
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <MenuItem icon={Copy} label="复制" shortcut="Ctrl+C" disabled={!canCopy} onClick={handleCopy} />
      <MenuItem icon={Clipboard} label="粘贴" shortcut="Ctrl+V" onClick={handlePaste} />
    </div>
  );
}

// ── 菜单项（具备 Hover / Active / Disabled 状态反馈） ──

function MenuItem({
  icon: Icon,
  label,
  shortcut,
  disabled,
  onClick,
}: {
  icon: React.ComponentType<{ size: number; color?: string; style?: React.CSSProperties }>;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  // 背景色随交互状态切换：按下 > 悬停 > 默认透明；禁用态不响应
  let background = 'transparent';
  if (!disabled && active) background = 'var(--toolbar-active, rgba(125, 125, 125, 0.2))';
  else if (!disabled && hover) background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';

  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        width: '100%',
        padding: '7px 12px',
        background,
        border: 'none',
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 13,
        color: 'var(--editor-text, #1e293b)',
        opacity: disabled ? 0.4 : 1,
        borderRadius: 6,
        userSelect: 'none',
        transition: 'background 100ms ease',
      }}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setActive(false);
      }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon size={15} color={disabled ? 'currentColor' : 'var(--accent-500, #3b82f6)'} />
        <span>{label}</span>
      </span>
      {shortcut && (
        <span style={{ fontSize: 11, color: 'var(--editor-text-muted, currentColor)', opacity: 0.7 }}>
          {shortcut}
        </span>
      )}
    </button>
  );
}
