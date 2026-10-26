// NoteBoard Markdown 编辑器右键双模上下文菜单
// 1. 选中文本：浮现加粗、斜体、代码、多色高亮(二级菜单)、标题转换(H1~H6二级菜单)、转为代码块/提示块/高亮块/引用块/折叠块、复制剪切
// 2. 未选中文本：浮现标题(H1~H6二级菜单)、提示块(二级菜单)、高亮块(二级菜单)、列表(二级菜单)、代码块、引用块、折叠块、分栏(二级菜单)、表格(二级菜单)、公式与图表(二级菜单)、图片(二级菜单)、表情(二级面板)等
// 详见 docs/07-UI布局与交互规范.md

import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { isInTable } from '@tiptap/pm/tables';
import { applyTablePaste } from './tableClipboard';
import { DEFAULT_DETAILS_SUMMARY, insertDetailsContent, requestDetailsSummaryFocus } from './detailsExtension';
import { insertColumnsBlock } from './columnsExtension';
import { insertCalloutBlock } from './calloutExtension';
import { convertSelectionToCodeBlock, wrapSelectionInBlock } from './blockConvert';
import { ALERT_KINDS, AlertMenuIcon, alertMenuLabel } from './alertExtension';
import { CALLOUT_PRESETS, CalloutPresetIcon } from './calloutPickers';
import { insertRawHtmlContent } from './rawHtmlBlockView';
import { InlineEmojiGrid, insertInlineEmoji } from './inlineEmoji';
import { insertLocalImageWithDialog } from './imagePaste';
import { DEFAULT_INFOGRAPHIC_CODE } from '../infographic/infographicTemplates';
import { promptImageUrl, promptLinkUrl } from '../../components/promptPresets';
import { useWindowStore } from '../../stores/windowStore';
import { insertWikiLinkInEditor } from '../wikilink/wikiLinkActions';
import {
  Bold,
  Italic,
  Underline,
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
  ListCollapse,
  SquareCode,
  Columns2,
  Columns3,
  Columns4,
  Table,
  FileCode,
  Sigma,
  Workflow,
  BarChart3,
  Image as ImageIcon,
  Boxes,
  Minus,
  Copy,
  Scissors,
  Clipboard,
  ClipboardType,
  ChevronRight,
  RemoveFormatting,
  Smile,
  Waypoints,
  X,
} from 'lucide-react';
import { formatShortcut } from '../../core/shortcuts';

interface EditorContextMenuProps {
  editor: Editor;
  position: { x: number; y: number } | null;
  hasSelection: boolean;
  onClose: () => void;
  onOpenLinkModal?: () => void;
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
  onOpenLinkModal,
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
  // 按子菜单实际高度做底部越界防护后的 top，避免矮子菜单也被按固定高度上推而与触发项错位
  const [submenuTop, setSubmenuTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = submenuRef.current;
    if (!activeSubmenu || !el) return;
    // 绘制前量出子菜单真实高度，仅在确实会超出视口底部时才上移
    const maxTop = window.innerHeight - el.offsetHeight - 8;
    setSubmenuTop(Math.max(8, Math.min(submenuPos.top, maxTop)));
  }, [activeSubmenu, submenuPos]);

  // 主菜单按实际高度做底部越界防护（选中文本模式菜单项较多，固定高度估算会让菜单出现滚动条或越出视口）
  const [menuTop, setMenuTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!position || !el) return;
    const maxTop = window.innerHeight - el.offsetHeight - 8;
    setMenuTop(Math.max(40, Math.min(position.y, maxTop)));
  }, [position, hasSelection]);

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
    // Esc 只关闭菜单本身：捕获阶段拦截，避免同时关闭外层弹层（如多维表格的单元格编辑弹层）
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey, true);
    };
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
    const viewportWidth = window.innerWidth;
    // 表情面板为 8 列网格，比普通列表子菜单宽
    const submenuWidth = submenuKey === 'insert-emoji' ? 310 : 185;
    const spaceOnRight = viewportWidth - rect.right;
    const flipLeft = spaceOnRight < submenuWidth + 5;
    // 窄屏（手机）左右两侧都放不下子菜单时，改为在触发项下方展开并夹进视口，避免被推到屏幕外
    const fitsSide = !flipLeft || rect.left - submenuWidth >= 8;
    const rawLeft = fitsSide ? (flipLeft ? rect.left - submenuWidth : rect.right + 4) : rect.left + 16;
    setSubmenuPos({
      top: fitsSide ? rect.top : rect.bottom + 2,
      left: Math.max(8, Math.min(rawLeft, viewportWidth - submenuWidth - 8)),
      flipLeft,
    });
    setActiveSubmenu(submenuKey);
  };

  return (
    <>
      {/* ── 主右键菜单容器 ── */}
      <div
        ref={menuRef}
        className="nb-context-menu"
        style={{
          position: 'fixed',
          top: menuTop ?? Math.max(adjustedY, 40),
          left: Math.max(adjustedX, 10),
          zIndex: 9999,
          background: 'var(--editor-surface, #ffffff)',
          border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
          borderRadius: 8,
          boxShadow: '0 10px 30px -4px rgba(0, 0, 0, 0.16), 0 3px 8px -2px rgba(0, 0, 0, 0.08)',
          backdropFilter: 'blur(8px)',
          padding: '5px',
          minWidth: 195,
          // 上方预留 40px（与 top 下限一致）、下方 8px，只有视口实在放不下时才滚动
          maxHeight: 'calc(100vh - 48px)',
          overflowY: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {hasSelection ? (
          // ── 模式 A：选中文本时的格式化与编辑菜单（剪切复制置顶） ──
          <>
            {/* ── 剪贴板操作组（置顶） ── */}
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
                <Scissors size={15} color="var(--accent-500, #3b82f6)" />
                <span>{formatShortcut('剪切 (Ctrl+X)')}</span>
              </div>
            </button>

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
                <Copy size={15} color="var(--accent-500, #3b82f6)" />
                <span>{formatShortcut('复制 (Ctrl+C)')}</span>
              </div>
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={async () => {
                onClose();
                try {
                  const text = await navigator.clipboard.readText();
                  if (text) {
                    if (isInTable(editor.state) && applyTablePaste(editor, text)) {
                      return;
                    }
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
                <Clipboard size={15} color="var(--accent-500, #3b82f6)" />
                <span>{formatShortcut('粘贴 (Ctrl+V)')}</span>
              </div>
            </button>

            <div style={dividerStyle} />

            {/* ── 文本格式化组 ── */}
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
                <span>{formatShortcut('加粗 (Ctrl+B)')}</span>
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
                <span>{formatShortcut('斜体 (Ctrl+I)')}</span>
              </div>
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().toggleUnderline().run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Underline size={15} />
                <span>{formatShortcut('下划线 (Ctrl+U)')}</span>
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

            {/* ── 转为代码块（多个段落合并为一个代码块，每段一行） ── */}
            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                convertSelectionToCodeBlock(editor);
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FileCode size={15} color="var(--accent-strong, #6366f1)" />
                <span>转为代码块</span>
              </div>
            </button>

            {/* ── 转为 GitHub 提示块 (带类型二级子菜单) ── */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'selection-alert'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('selection-alert', e)}
              onClick={(e) => handleOpenSubmenu('selection-alert', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Boxes size={15} color="#3b82f6" />
                <span>转为 GitHub 提示块</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            {/* ── 转为高亮块 (带预设二级子菜单) ── */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'selection-callout'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('selection-callout', e)}
              onClick={(e) => handleOpenSubmenu('selection-callout', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Highlighter size={15} color="#8b5cf6" />
                <span>转为高亮块</span>
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

            {/* ── 转为折叠块（选中内容作为折叠正文，随后聚焦标题输入框） ── */}
            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                requestDetailsSummaryFocus();
                wrapSelectionInBlock(editor, 'detailsBlock', { summary: DEFAULT_DETAILS_SUMMARY });
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ListCollapse size={15} />
                <span>转为折叠块</span>
              </div>
            </button>

            <div style={dividerStyle} />

            {/* ── 超链接 ── */}
            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                if (onOpenLinkModal) {
                  onOpenLinkModal();
                } else {
                  const previousUrl = editor.getAttributes('link').href || '';
                  void promptLinkUrl(previousUrl).then((url) => {
                    if (url === null || editor.isDestroyed) return;
                    if (url === '') {
                      editor.chain().focus().unsetLink().run();
                    } else {
                      editor.chain().focus().setLink({ href: url }).run();
                    }
                  });
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
                <span>{formatShortcut('超链接 (Ctrl+K)')}</span>
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
                <RemoveFormatting size={15} color="#ef4444" />
                <span>清除格式</span>
              </div>
            </button>
          </>
        ) : (
          // ── 模式 B：未选中文本时的富文本插入菜单（剪贴板置顶，插入项严格遵循：标题 > 列表 > 代码块 > github提示 > 引用块 > 表格 > 其他） ──
          <>
            {/* ── 剪贴板操作组（置顶） ── */}
            <button
              type="button"
              style={btnStyle}
              onClick={async () => {
                onClose();
                try {
                  const text = await navigator.clipboard.readText();
                  if (text) {
                    if (isInTable(editor.state) && applyTablePaste(editor, text)) {
                      return;
                    }
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
                <Clipboard size={15} color="var(--accent-500, #3b82f6)" />
                <span>{formatShortcut('粘贴 (Ctrl+V)')}</span>
              </div>
            </button>

            <button
              type="button"
              style={btnStyle}
              onClick={async () => {
                onClose();
                try {
                  const text = await navigator.clipboard.readText();
                  if (text) {
                    if (isInTable(editor.state) && applyTablePaste(editor, text)) {
                      return;
                    }
                    editor.chain().focus().insertContent({ type: 'text', text }).run();
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
                <ClipboardType size={15} color="var(--accent-500, #3b82f6)" />
                <span>{formatShortcut('纯文本粘贴 (Ctrl+Shift+V)')}</span>
              </div>
            </button>

            <div style={dividerStyle} />

            {/* 1. 插入标题 (带 H1~H6 二级子菜单) */}
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

            {/* 2. 插入列表 (带二级子菜单) */}
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

            {/* 3. 插入代码块 */}
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

            {/* 4. GitHub 提示块 (带二级子菜单) */}
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
                <span>插入 GitHub 提示块</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            {/* 4.5 高亮块 (带二级子菜单：常用颜色与图标组合) */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'insert-callout'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('insert-callout', e)}
              onClick={(e) => handleOpenSubmenu('insert-callout', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Highlighter size={15} color="#8b5cf6" />
                <span>插入高亮块</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            {/* 5. 插入引用块 */}
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

            {/* 5.1 插入折叠块（<details>，可展开/收起） */}
            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().insertContent(insertDetailsContent()).run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ListCollapse size={15} />
                <span>插入折叠块</span>
              </div>
            </button>

            {/* 5.15 插入分栏卡片 (带二级子菜单：两栏 / 三栏 / 四栏) */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'insert-columns'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('insert-columns', e)}
              onClick={(e) => handleOpenSubmenu('insert-columns', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Columns2 size={15} />
                <span>插入分栏</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            {/* 5.2 插入 HTML 块（插入后直接进入源码编辑） */}
            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                editor.chain().focus().insertContent(insertRawHtmlContent()).run();
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <SquareCode size={15} />
                <span>插入 HTML 块</span>
              </div>
            </button>

            {/* 6. 插入表格 (带二级子菜单：3x3 / 2x2 / 4x4，与工具栏「插入」下拉一致) */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'insert-table'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('insert-table', e)}
              onClick={(e) => handleOpenSubmenu('insert-table', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Table size={15} />
                <span>插入表格</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            <div style={dividerStyle} />

            {/* 7. 公式与图表 (带二级子菜单：行内公式 / 独立公式块 / Mermaid / Infographic，与工具栏「插入」下拉一致) */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'insert-math'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('insert-math', e)}
              onClick={(e) => handleOpenSubmenu('insert-math', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Sigma size={15} />
                <span>插入公式与图表</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            {/* 8. 图片 (带二级子菜单：本地图片 / 网络图片) */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'insert-image'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('insert-image', e)}
              onClick={(e) => handleOpenSubmenu('insert-image', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ImageIcon size={15} />
                <span>插入图片</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            {/* 8.5 表情 (带二级表情面板，写入标准 Unicode 表情) */}
            <button
              type="button"
              style={{
                ...btnStyle,
                background:
                  activeSubmenu === 'insert-emoji'
                    ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                    : 'transparent',
              }}
              onMouseEnter={(e) => handleOpenSubmenu('insert-emoji', e)}
              onClick={(e) => handleOpenSubmenu('insert-emoji', e)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Smile size={15} color="#f59e0b" />
                <span>插入表情</span>
              </div>
              <ChevronRight size={14} style={{ opacity: 0.6 }} />
            </button>

            {/* 9. 插入超链接 */}
            <button
              type="button"
              style={btnStyle}
              onClick={() => {
                onClose();
                if (onOpenLinkModal) {
                  onOpenLinkModal();
                } else {
                  void promptLinkUrl().then((url) => {
                    if (url && !editor.isDestroyed) {
                      editor.chain().focus().setLink({ href: url }).run();
                    }
                  });
                }
              }}
              onMouseEnter={(e) => {
                setActiveSubmenu(null);
                e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Link size={15} color="var(--accent-500, #3b82f6)" />
                <span>插入超链接</span>
              </div>
            </button>

            {/* 9.5 插入双向链接：弹窗选择笔记与显示方式（未启用双链的编辑器不显示） */}
            {editor.schema.nodes.wikiLink && (
              <button
                type="button"
                style={btnStyle}
                onClick={() => {
                  onClose();
                  void insertWikiLinkInEditor(editor, useWindowStore.getState().activeKey ?? '');
                }}
                onMouseEnter={(e) => {
                  setActiveSubmenu(null);
                  e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))';
                }}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Waypoints size={15} color="#8b5cf6" />
                  <span>插入双向链接…</span>
                </div>
              </button>
            )}

            {/* 10. 水平分割线 */}
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
                <span>插入水平分割线 (---)</span>
              </div>
            </button>
          </>
        )}
      </div>

      {/* ── 独立二级子菜单浮层 ── */}
      {activeSubmenu && (
        <div
          ref={submenuRef}
          className="nb-context-menu"
          style={{
            position: 'fixed',
            top: submenuTop ?? submenuPos.top,
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

          {/* 二级：高亮块（插入 / 选区转换共用） */}
          {(activeSubmenu === 'insert-callout' || activeSubmenu === 'selection-callout') && (
            <>
              {CALLOUT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  style={btnStyle}
                  onClick={() => {
                    if (activeSubmenu === 'selection-callout') {
                      // 用预设颜色与图标的高亮块包裹选中的块
                      wrapSelectionInBlock(editor, 'calloutBlock', { color: preset.color, icon: preset.icon });
                    } else {
                      // 插入预设颜色与图标的高亮块，光标落在块内
                      insertCalloutBlock(editor, preset);
                    }
                    onClose();
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CalloutPresetIcon preset={preset} />
                    <span>{preset.label}</span>
                    <span style={{ fontSize: 12, opacity: 0.55 }}>{preset.description.split(' · ')[0]}</span>
                  </div>
                </button>
              ))}
            </>
          )}

          {/* 二级：表情面板 */}
          {activeSubmenu === 'insert-emoji' && (
            <InlineEmojiGrid
              onSelect={(char) => {
                // 在右键位置的光标处插入表情字符
                insertInlineEmoji(editor, char);
                onClose();
              }}
            />
          )}

          {/* 二级：分栏卡片 */}
          {activeSubmenu === 'insert-columns' && (
            <>
              {[
                { count: 2, label: '两栏', icon: <Columns2 size={15} /> },
                { count: 3, label: '三栏', icon: <Columns3 size={15} /> },
                { count: 4, label: '四栏', icon: <Columns4 size={15} /> },
              ].map((c) => (
                <button
                  key={c.count}
                  type="button"
                  style={btnStyle}
                  onClick={() => {
                    // 插入均分的分栏卡片，光标落在第一栏
                    insertColumnsBlock(editor, c.count);
                    onClose();
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {c.icon}
                    <span>{c.label}</span>
                  </div>
                </button>
              ))}
            </>
          )}

          {/* 二级：表格尺寸 */}
          {activeSubmenu === 'insert-table' && (
            <>
              {[
                { rows: 3, cols: 3, label: '标准表格 (3x3)' },
                { rows: 2, cols: 2, label: '紧凑表格 (2x2)' },
                { rows: 4, cols: 4, label: '宽表格 (4x4)' },
              ].map((t) => (
                <button
                  key={t.label}
                  type="button"
                  style={btnStyle}
                  onClick={() => {
                    // 插入带表头行的指定尺寸表格
                    editor.chain().focus().insertTable({ rows: t.rows, cols: t.cols, withHeaderRow: true }).run();
                    onClose();
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Table size={15} />
                    <span>{t.label}</span>
                  </div>
                </button>
              ))}
            </>
          )}

          {/* 二级：公式与图表 */}
          {activeSubmenu === 'insert-math' && (
            <>
              {[
                { key: 'mathInline', label: '行内公式 ($...$)', icon: <Sigma size={15} />, content: { type: 'mathInline', attrs: { latex: 'E=mc^2' } } },
                { key: 'mathBlock', label: '独立公式块 ($$...$$)', icon: <Sigma size={15} />, content: { type: 'mathBlock', attrs: { latex: '' } } },
                {
                  key: 'mermaid',
                  label: 'Mermaid 流程图表',
                  icon: <Workflow size={15} color="var(--accent-500, #3b82f6)" />,
                  content: { type: 'mermaidBlock', attrs: { code: 'graph TD\n  A[开始] --> B[处理]\n  B --> C[完成]' } },
                },
                {
                  key: 'infographic',
                  label: 'Infographic 现代信息图',
                  icon: <BarChart3 size={15} color="#3b82f6" />,
                  // 默认信息图模板与工具栏、斜杠命令共用
                  content: { type: 'infographicBlock', attrs: { code: DEFAULT_INFOGRAPHIC_CODE } },
                },
              ].map((m) => (
                <button
                  key={m.key}
                  type="button"
                  style={btnStyle}
                  onClick={() => {
                    editor.chain().focus().insertContent(m.content).run();
                    onClose();
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {m.icon}
                    <span>{m.label}</span>
                  </div>
                </button>
              ))}
            </>
          )}

          {/* 二级：图片 */}
          {activeSubmenu === 'insert-image' && (
            <>
              <button
                type="button"
                style={btnStyle}
                onClick={() => {
                  onClose();
                  // 选择本地图片并保存到当前文档的 img 目录（与斜杠命令一致，按活动标签定位文档）
                  const docKey = useWindowStore.getState().activeKey;
                  if (docKey) {
                    void insertLocalImageWithDialog(editor, docKey);
                  }
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ImageIcon size={15} />
                  <span>本地图片</span>
                </div>
              </button>
              <button
                type="button"
                style={btnStyle}
                onClick={() => {
                  onClose();
                  void promptImageUrl().then((url) => {
                    // 弹窗期间标签可能已被关闭，编辑器实例随之销毁
                    if (url && !editor.isDestroyed) {
                      editor.chain().focus().setImage({ src: url }).run();
                    }
                  });
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ImageIcon size={15} style={{ opacity: 0.7 }} />
                  <span>网络图片</span>
                </div>
              </button>
            </>
          )}

          {/* 二级：GitHub 提示块（插入 / 选区转换共用） */}
          {(activeSubmenu === 'insert-alert' || activeSubmenu === 'selection-alert') && (
            <>
              {/* 文案与图标取自 alertExtension，与斜杠命令、工具栏保持一致 */}
              {ALERT_KINDS.map((kind) => ({ kind, label: alertMenuLabel(kind), icon: <AlertMenuIcon kind={kind} /> })).map((a) => (
                <button
                  key={a.kind}
                  type="button"
                  style={btnStyle}
                  onClick={() => {
                    if (activeSubmenu === 'selection-alert') {
                      // 用对应类型的提示块包裹选中的块
                      wrapSelectionInBlock(editor, 'githubAlert', { kind: a.kind });
                    } else {
                      // 插入 GitHub 风格的彩色提示警告块
                      editor.chain().focus().insertContent({ type: 'githubAlert', attrs: { kind: a.kind }, content: [{ type: 'paragraph' }] }).run();
                    }
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

