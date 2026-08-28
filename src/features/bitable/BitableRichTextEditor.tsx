// NoteBoard 多维表格多行文本的富文本编辑器
// 基于 TipTap 提供所见即所得编辑（可视化模式），并可通过 @tiptap/markdown 与 Markdown 源码互转
// 与笔记本编辑器刻意保持独立：单元格编辑只需基础块与行内标记，避免拖入图表/公式等重型扩展

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Code } from '@tiptap/extension-code';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import {
  Bold,
  Italic,
  Strikethrough,
  Code as CodeIcon,
  Braces,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Link2,
  RemoveFormatting,
  Minus,
} from 'lucide-react';

/** Markdown 允许粗体/斜体包裹行内代码；默认 Code 的 excludes: '_' 会导致解析出非法 marks */
const MarkdownCompatibleCode = Code.extend({ excludes: '' });

/**
 * 构建多行文本编辑器的扩展集
 * 单独导出以便单元测试直接验证「扩展装配 + Markdown 往返」，无需挂载 React 组件。
 */
export function buildLongTextExtensions(placeholder = '输入内容，支持 Markdown…') {
  return [
    StarterKit.configure({
      // 换用允许与粗体/斜体嵌套的 Code 扩展，避免同名扩展与 schema 冲突
      code: false,
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: null },
      },
      // 单元格浮层内的撤销不应与文件级历史混淆，保留编辑器自带的短程撤销
      undoRedo: { depth: 100, newGroupDelay: 300 },
    }),
    MarkdownCompatibleCode,
    Placeholder.configure({ placeholder }),
    // Markdown 序列化/解析：使 setContent/getMarkdown 直接以 Markdown 为载体
    Markdown,
  ];
}

/** 编辑器与源码两种编辑形态 */
export type RichTextMode = 'rich' | 'source';

interface BitableRichTextEditorProps {
  /** Markdown 源码 */
  value: string;
  /** 内容变化回调，回传 Markdown 源码 */
  onChange: (markdown: string) => void;
  /** 占位提示文案 */
  placeholder?: string;
  /** 编辑区最小高度（像素） */
  minHeight?: number;
  /** 受控的模式切换：由外层浮层持有，切换源码时不销毁编辑器实例 */
  mode: RichTextMode;
  onModeChange: (mode: RichTextMode) => void;
  /**
   * 失去焦点时触发提交，两种编辑模式都会调用
   * 逐键实时写入会让撤销栈被每个字符塞满，改为失焦提交可让一次编辑只留一条历史。
   * 不回传内容：调用方持有的草稿已由 onChange 同步到最新，直接用它提交即可。
   */
  onBlurCommit?: () => void;
}

/** 编辑器样式：只注入一次，供所有实例共享 */
let styleInjected = false;

const EDITOR_CSS = `
.nb-bitable-rte { position: relative; display: flex; flex-direction: column; min-height: 0; }
.nb-bitable-rte-toolbar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 2px;
  padding: 5px 6px; border-bottom: 1px solid var(--editor-border, #e5e7eb);
  background: var(--editor-surface, #f8fafc); flex-shrink: 0;
}
.nb-bitable-rte-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: none; border-radius: 4px;
  background: transparent; color: var(--editor-text-secondary, #64748b); cursor: pointer; flex-shrink: 0;
  transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}
.nb-bitable-rte-btn:hover { background: var(--editor-hover-background, rgba(59,130,246,0.10)); color: var(--editor-text, #1e293b); }
.nb-bitable-rte-btn:active { transform: scale(0.92); }
.nb-bitable-rte-btn.active { background: var(--editor-selection-background, rgba(59,130,246,0.16)); color: var(--editor-accent, #3b82f6); }
.nb-bitable-rte-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.nb-bitable-rte-sep { width: 1px; height: 16px; margin: 0 3px; background: var(--editor-border, #e5e7eb); flex-shrink: 0; }
.nb-bitable-rte-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 10px; }
.nb-bitable-rte .ProseMirror { outline: none; min-height: 100%; color: var(--editor-text, #1e293b); font-size: 13px; line-height: 1.6; }
.nb-bitable-rte .ProseMirror > * + * { margin-top: 0.5em; }
.nb-bitable-rte .ProseMirror p { margin: 0; }
.nb-bitable-rte .ProseMirror h1 { font-size: 1.45em; font-weight: 700; color: var(--editor-heading, #0f172a); }
.nb-bitable-rte .ProseMirror h2 { font-size: 1.25em; font-weight: 700; color: var(--editor-heading, #0f172a); }
.nb-bitable-rte .ProseMirror h3 { font-size: 1.1em; font-weight: 700; color: var(--editor-heading, #0f172a); }
.nb-bitable-rte .ProseMirror ul, .nb-bitable-rte .ProseMirror ol { padding-left: 1.4em; }
.nb-bitable-rte .ProseMirror li > p { margin: 0; }
.nb-bitable-rte .ProseMirror blockquote {
  border-left: 3px solid var(--editor-accent, #3b82f6); padding-left: 0.7em; margin-left: 0;
  background: var(--editor-quote-bg, rgba(59,130,246,0.08)); color: var(--editor-text-secondary, #64748b);
}
.nb-bitable-rte .ProseMirror code {
  font-family: var(--editor-font-mono, 'Cascadia Code', Consolas, monospace);
  background: var(--editor-code-bg, #f8fafc); border: 1px solid var(--editor-border, #e5e7eb);
  border-radius: 3px; padding: 0.05em 0.3em; font-size: 0.9em;
}
.nb-bitable-rte .ProseMirror pre {
  background: var(--editor-code-bg, #f8fafc); border: 1px solid var(--editor-border, #e5e7eb);
  border-radius: 6px; padding: 0.6em 0.75em; overflow-x: auto;
  font-family: var(--editor-font-mono, 'Cascadia Code', Consolas, monospace); font-size: 0.88em; line-height: 1.5;
}
.nb-bitable-rte .ProseMirror pre code { background: transparent; border: none; padding: 0; font-size: 1em; }
.nb-bitable-rte .ProseMirror a { color: var(--editor-link, #2563eb); cursor: pointer; }
.nb-bitable-rte .ProseMirror hr { border: none; border-top: 1px solid var(--editor-border, #e5e7eb); margin: 0.7em 0; }
.nb-bitable-rte .ProseMirror p.is-editor-empty:first-child::before {
  content: attr(data-placeholder); float: left; height: 0; pointer-events: none;
  color: var(--editor-text-muted, #94a3b8);
}
.nb-bitable-rte-source {
  width: 100%; min-height: 100%; box-sizing: border-box; resize: none; outline: none;
  border: none; background: transparent; color: var(--editor-text, #1e293b);
  font-family: var(--editor-font-mono, 'Cascadia Code', Consolas, monospace);
  font-size: 12.5px; line-height: 1.65;
}
`;

function ensureStyleInjected() {
  if (styleInjected || typeof document === 'undefined') return;
  if (document.getElementById('nb-bitable-rte-style')) {
    styleInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'nb-bitable-rte-style';
  style.textContent = EDITOR_CSS;
  document.head.appendChild(style);
  styleInjected = true;
}

/** 工具栏按钮：按下时不抢占焦点，避免编辑器失焦导致选区丢失 */
function ToolButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      className={`nb-bitable-rte-btn${active ? ' active' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function BitableRichTextEditor({
  value,
  onChange,
  placeholder = '输入内容，支持 Markdown…',
  minHeight = 160,
  mode,
  onModeChange,
  onBlurCommit,
}: BitableRichTextEditorProps) {
  ensureStyleInjected();

  /**
   * 最近一次由本组件向上抛出的 Markdown
   * 用于区分「外部值变化」与「自身输入回传」，避免把用户正在输入的内容又 setContent 回去打断光标。
   */
  const lastEmittedRef = useRef<string>(value);
  const [sourceDraft, setSourceDraft] = useState(value);

  // 失焦提交用 ref 承接：回调身份变化不应触发编辑器重建
  const blurCommitRef = useRef(onBlurCommit);
  blurCommitRef.current = onBlurCommit;

  const editor = useEditor({
    extensions: buildLongTextExtensions(placeholder),
    content: value,
    contentType: 'markdown',
    // 弹层打开即聚焦，省去用户再点一次编辑区
    autofocus: 'end',
    editorProps: {
      attributes: { class: 'nb-bitable-rte-prose' },
      handleDOMEvents: {
        blur: () => {
          blurCommitRef.current?.();
          return false;
        },
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md = ed.getMarkdown();
      lastEmittedRef.current = md;
      onChange(md);
    },
    // 编辑器实例在浮层关闭时销毁，无需 immediatelyRender 之类 SSR 处理
  });

  // 外部值（如切换记录、撤销）与编辑器内容不一致时同步回写
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    editor.commands.setContent(value, { contentType: 'markdown' });
    setSourceDraft(value);
  }, [value, editor]);

  // 切到源码模式时，用编辑器当前内容的 Markdown 覆盖草稿，保证不丢未同步的编辑
  const handleSwitchToSource = useCallback(() => {
    if (editor && !editor.isDestroyed) {
      const md = editor.getMarkdown();
      setSourceDraft(md);
      if (md !== lastEmittedRef.current) {
        lastEmittedRef.current = md;
        onChange(md);
      }
    }
    onModeChange('source');
  }, [editor, onChange, onModeChange]);

  // 切回可视化模式时，把源码草稿解析回编辑器（解析失败则保留原内容，不丢数据）
  const handleSwitchToRich = useCallback(() => {
    if (editor && !editor.isDestroyed) {
      try {
        editor.commands.setContent(sourceDraft, { contentType: 'markdown' });
        lastEmittedRef.current = sourceDraft;
        onChange(sourceDraft);
      } catch {
        // 源码非法时保持编辑器原状，交由用户在源码模式继续修正
      }
    }
    onModeChange('rich');
  }, [editor, sourceDraft, onChange, onModeChange]);

  /** 插入或清除链接：用原生输入获取地址，避免在单元格浮层里再嵌一层弹窗 */
  const handleLink = useCallback(() => {
    if (!editor || editor.isDestroyed) return;
    const previous = editor.getAttributes('link').href as string | undefined;
    const input = window.prompt('输入链接地址（留空则移除链接）', previous ?? 'https://');
    if (input === null) return;
    const url = input.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  const toolbar = useMemo(() => {
    if (!editor) return null;
    const ed: Editor = editor;
    return (
      <>
        <ToolButton
          title="加粗 (Ctrl+B)"
          active={ed.isActive('bold')}
          onClick={() => ed.chain().focus().toggleBold().run()}
        >
          <Bold size={14} />
        </ToolButton>
        <ToolButton
          title="斜体 (Ctrl+I)"
          active={ed.isActive('italic')}
          onClick={() => ed.chain().focus().toggleItalic().run()}
        >
          <Italic size={14} />
        </ToolButton>
        <ToolButton
          title="删除线"
          active={ed.isActive('strike')}
          onClick={() => ed.chain().focus().toggleStrike().run()}
        >
          <Strikethrough size={14} />
        </ToolButton>
        <ToolButton
          title="行内代码"
          active={ed.isActive('code')}
          onClick={() => ed.chain().focus().toggleCode().run()}
        >
          <CodeIcon size={14} />
        </ToolButton>
        <ToolButton
          title="链接"
          active={ed.isActive('link')}
          onClick={handleLink}
        >
          <Link2 size={14} />
        </ToolButton>

        <span className="nb-bitable-rte-sep" />

        <ToolButton
          title="代码块"
          active={ed.isActive('codeBlock')}
          onClick={() => ed.chain().focus().toggleCodeBlock().run()}
        >
          <Braces size={14} />
        </ToolButton>
        <ToolButton
          title="一级标题"
          active={ed.isActive('heading', { level: 1 })}
          onClick={() => ed.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          <Heading1 size={14} />
        </ToolButton>
        <ToolButton
          title="二级标题"
          active={ed.isActive('heading', { level: 2 })}
          onClick={() => ed.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 size={14} />
        </ToolButton>
        <ToolButton
          title="三级标题"
          active={ed.isActive('heading', { level: 3 })}
          onClick={() => ed.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 size={14} />
        </ToolButton>

        <span className="nb-bitable-rte-sep" />

        <ToolButton
          title="无序列表"
          active={ed.isActive('bulletList')}
          onClick={() => ed.chain().focus().toggleBulletList().run()}
        >
          <List size={14} />
        </ToolButton>
        <ToolButton
          title="有序列表"
          active={ed.isActive('orderedList')}
          onClick={() => ed.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={14} />
        </ToolButton>
        <ToolButton
          title="引用"
          active={ed.isActive('blockquote')}
          onClick={() => ed.chain().focus().toggleBlockquote().run()}
        >
          <Quote size={14} />
        </ToolButton>
        <ToolButton
          title="分割线"
          onClick={() => ed.chain().focus().setHorizontalRule().run()}
        >
          <Minus size={14} />
        </ToolButton>

        <span className="nb-bitable-rte-sep" />

        <ToolButton
          title="清除格式"
          onClick={() => ed.chain().focus().unsetAllMarks().clearNodes().run()}
        >
          <RemoveFormatting size={14} />
        </ToolButton>
      </>
    );
  }, [editor, handleLink]);

  return (
    <div className="nb-bitable-rte" style={{ minHeight }}>
      {mode === 'rich' && (
        <div className="nb-bitable-rte-toolbar">{toolbar}</div>
      )}

      <div
        className="nb-bitable-rte-body"
        style={{ minHeight, display: mode === 'rich' ? 'block' : 'none' }}
      >
        <EditorContent editor={editor} />
      </div>

      {mode === 'source' && (
        <div className="nb-bitable-rte-body" style={{ minHeight }}>
          <textarea
            className="nb-bitable-rte-source"
            value={sourceDraft}
            placeholder={placeholder}
            onChange={(e) => {
              const next = e.target.value;
              setSourceDraft(next);
              lastEmittedRef.current = next;
              onChange(next);
            }}
            onBlur={() => blurCommitRef.current?.()}
            style={{ minHeight: minHeight - 16 }}
          />
        </div>
      )}

      {/* 模式切换：放在编辑区外，避免随内容滚动 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 4,
          padding: '4px 8px',
          borderTop: '1px solid var(--editor-border, #e5e7eb)',
          background: 'var(--editor-surface, #f8fafc)',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          className="nb-bitable-btn-secondary"
          onClick={mode === 'rich' ? handleSwitchToSource : handleSwitchToRich}
          title={mode === 'rich' ? '查看与编辑 Markdown 源码' : '返回可视化编辑'}
          style={{
            padding: '3px 8px',
            fontSize: 11,
          }}
        >
          {mode === 'rich' ? 'Markdown 源码' : '返回可视化'}
        </button>
      </div>
    </div>
  );
}
