// NoteBoard 多维表格多行文本的富文本编辑器
// 基于 TipTap 提供所见即所得编辑（可视化模式），并可与 Markdown 源码互转
// 与笔记本编辑器共用同一套扩展、序列化管线与交互（斜杠菜单、右键菜单、气泡菜单、顶部插入菜单），
// 笔记本里新增的语法（公式、图表、高亮块、折叠块、分栏等）在单元格里同样可用、往返无损。
// 差异只在宿主层：单元格没有独立的文档历史，撤销沿用编辑器自带的短程撤销栈。

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { SuggestionPluginKey } from '@tiptap/suggestion';
import { Selection } from '@tiptap/pm/state';
import { Tooltip } from '../../components/Tooltip';
import { promptLinkUrl } from '../../components/promptPresets';
import { buildExtensions } from '../editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../editor-md/serialize';
import { EditorBubbleMenu, TableToolbar } from '../editor-md/bubbleMenu';
import { BlockDragHandle } from '../editor-md/blockDragHandle';
import { EditorContextMenu } from '../editor-md/EditorContextMenu';
import { handlePastedImageFile } from '../editor-md/imagePaste';
import { MarkdownToolbar, type MarkdownToolbarHistory } from '../toolbar/MarkdownToolbar';
import { on, off, emit } from '../../core/emitter';
import { useWindowStore } from '../../stores/windowStore';

const DEFAULT_PLACEHOLDER = '输入内容，键入 / 插入块，支持 Markdown';

/**
 * 构建多行文本编辑器的扩展集
 * 直接复用笔记本编辑器的唯一装配点，只关闭文件级撤销接管。
 * 单独导出以便单元测试直接验证「扩展装配 + Markdown 往返」，无需挂载 React 组件。
 */
export function buildLongTextExtensions(placeholder = DEFAULT_PLACEHOLDER, onOpenLinkModal?: () => void) {
  return buildExtensions('', {
    // 单元格浮层内的撤销不应与文件级历史混淆，保留编辑器自带的短程撤销
    documentHistory: false,
    placeholder,
    onOpenLinkModal,
  });
}

/** 实例序号：区分同时挂载的多个单元格编辑器（侧栏表单与编辑弹层可能并存） */
let nextInstanceId = 0;

/** 最近获得焦点的实例：斜杠菜单按当前文档广播的链接请求只交给它处理 */
let lastFocusedInstanceKey: string | null = null;

/**
 * 链接弹窗唤起回调必须在模块级工厂中创建（原因同 VisualKernel 的 makeLinkModalOpener）：
 * 扩展 options 处于 schema 引用链上，组件内闭包会让已销毁的编辑器无法回收。
 */
function makeLinkModalOpener(instanceKey: string): () => void {
  return () => {
    emit('open-link-modal', { key: instanceKey });
  };
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
  /**
   * 正文中按 Esc 且没有斜杠菜单等编辑器内浮层需要关闭时触发
   * ProseMirror 对 Esc 一律 preventDefault，外层无法据 defaultPrevented 区分，需由编辑器判定后通知。
   */
  onEscape?: () => void;
  /**
   * 挂载后是否自动聚焦到末尾
   * 只有独立的编辑弹层需要（打开即编辑）；记录侧栏里的表单编辑器若自动聚焦，
   * 一打开详情就会把焦点和光标抢进正文，多个 Markdown 字段时还会互相争抢。
   */
  autoFocus?: boolean;
}

/** 编辑器样式：只注入一次，供所有实例共享 */
let styleInjected = false;

const EDITOR_CSS = `
.nb-bitable-rte { position: relative; display: flex; flex-direction: column; min-height: 0; }
.nb-bitable-rte-toolbar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 2px;
  padding: 4px 6px; border-bottom: 1px solid var(--editor-border, #e5e7eb);
  background: var(--editor-surface, #f8fafc); flex-shrink: 0;
}
/* 编辑区需作为定位容器：块拖拽把手按滚动容器绝对定位 */
.nb-bitable-rte-body { position: relative; flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px; cursor: text; }
/* 左侧留出块拖拽把手的位置 */
.nb-bitable-rte .ProseMirror { outline: none; min-height: 100%; padding-left: 18px; color: var(--editor-text, #1e293b); font-size: 13px; line-height: 1.6; }
.nb-bitable-rte .ProseMirror > * + * { margin-top: 0.5em; }
.nb-bitable-rte .ProseMirror p { margin: 0; }
/* 覆盖笔记本正文的大标题排版：单元格内不需要分隔线与悬浮级别标签 */
.nb-bitable-rte .ProseMirror :is(h1, h2, h3, h4, h5, h6) { margin: 0.6em 0 0.3em; padding-bottom: 0; border-bottom: none; line-height: 1.35; }
.nb-bitable-rte .ProseMirror > :is(h1, h2, h3, h4, h5, h6):first-child { margin-top: 0; }
.nb-bitable-rte .ProseMirror :is(h1, h2, h3, h4, h5, h6)::before { display: none; }
.nb-bitable-rte .ProseMirror h1 { font-size: 1.45em; font-weight: 700; color: var(--editor-heading, #0f172a); }
.nb-bitable-rte .ProseMirror h2 { font-size: 1.25em; font-weight: 700; color: var(--editor-heading, #0f172a); }
.nb-bitable-rte .ProseMirror h3 { font-size: 1.1em; font-weight: 700; color: var(--editor-heading, #0f172a); }
.nb-bitable-rte .ProseMirror :is(h4, h5, h6) { font-size: 1em; font-weight: 700; color: var(--editor-heading, #0f172a); }
/* 引用、代码块、表格、任务列表、图表等其余块沿用笔记本编辑器的全局 .ProseMirror 样式，两处观感一致；
   任务列表有自己的缩进规则，普通列表的紧凑缩进不能波及它 */
.nb-bitable-rte .ProseMirror :is(ul:not([data-type="taskList"]), ol) { padding-left: 1.4em; }
.nb-bitable-rte .ProseMirror li > p { margin: 0; }
.nb-bitable-rte .ProseMirror > p.is-empty:first-child:last-child::before {
  content: attr(data-placeholder); float: left; height: 0; pointer-events: none;
  color: var(--editor-text-muted, #94a3b8);
}
.nb-bitable-rte-footer {
  display: flex; justify-content: flex-end; gap: 4px; padding: 4px 8px; flex-shrink: 0;
  border-top: 1px solid var(--editor-border, #e5e7eb); background: var(--editor-surface, #f8fafc);
}
/* 带圆角边框的宿主（侧栏表单）：容器不能裁剪溢出（工具栏下拉需要伸出），改由首尾栏自行圆角 */
.nb-bitable-rte-framed .nb-bitable-rte-toolbar { border-radius: 5px 5px 0 0; }
.nb-bitable-rte-framed .nb-bitable-rte-footer { border-radius: 0 0 5px 5px; }
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

export function BitableRichTextEditor({
  value,
  onChange,
  placeholder = DEFAULT_PLACEHOLDER,
  minHeight = 160,
  mode,
  onModeChange,
  onBlurCommit,
  onEscape,
  autoFocus = false,
}: BitableRichTextEditorProps) {
  ensureStyleInjected();

  /**
   * 最近一次由本组件向上抛出的 Markdown
   * 用于区分「外部值变化」与「自身输入回传」，避免把用户正在输入的内容又 setContent 回去打断光标。
   */
  const lastEmittedRef = useRef<string>(value);
  const [sourceDraft, setSourceDraft] = useState(value);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);

  // 实例标识只在首次渲染分配，用于链接请求的定向分发
  const [instanceKey] = useState(() => `bitable-rte:${++nextInstanceId}`);

  // 回调统一用 ref 承接：回调身份变化不应触发编辑器重建
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const blurCommitRef = useRef(onBlurCommit);
  blurCommitRef.current = onBlurCommit;
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  /**
   * 程序化写入锁：初始化、外部值回写、源码切回可视化时同步加锁，
   * 期间触发的 onUpdate 不视为用户编辑（否则仅打开弹层就会因序列化规范化而显示「有未保存的修改」）
   */
  const syncingRef = useRef(false);

  // 扩展只构建一次；链接回调经模块级工厂创建，不捕获组件作用域
  const extensions = useMemo(
    () => buildLongTextExtensions(placeholder, makeLinkModalOpener(instanceKey)),
    [placeholder, instanceKey],
  );

  const editor = useEditor({
    extensions,
    content: '',
    // 弹层打开即聚焦，省去用户再点一次编辑区；侧栏表单不自动聚焦
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: 'nb-bitable-rte-prose' },
      handleDOMEvents: {
        blur: () => {
          blurCommitRef.current?.();
          return false;
        },
      },
      handleKeyDown: (view, event) => {
        // Esc：直接 props 先于插件执行，此时斜杠菜单尚未消费按键；菜单激活时交给它关闭自身，
        // 其余情况（含图片预览等已标记 defaultPrevented 的浮层之外）通知宿主
        if (event.key === 'Escape') {
          if (!event.defaultPrevented && !SuggestionPluginKey.getState(view.state)?.active) {
            escapeRef.current?.();
          }
          return false;
        }
        // Ctrl+K 插入/编辑链接（笔记本的同名快捷键只对 Markdown 标签生效）
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          emit('open-link-modal', { key: instanceKey });
          return true;
        }
        return false;
      },
      // 粘贴/拖入图片：与笔记本一致，按当前文档目录保存为本地图片
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        const docKey = useWindowStore.getState().activeKey;
        if (!items || !docKey || !editor) return false;
        for (const item of Array.from(items)) {
          if (!item.type.startsWith('image/')) continue;
          const file = item.getAsFile();
          if (!file) continue;
          event.preventDefault();
          void handlePastedImageFile(editor, file, docKey);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = event.dataTransfer?.files;
        const docKey = useWindowStore.getState().activeKey;
        if (!files || files.length === 0 || !docKey || !editor) return false;
        for (const file of Array.from(files)) {
          if (!file.type.startsWith('image/')) continue;
          event.preventDefault();
          void handlePastedImageFile(editor, file, docKey);
          return true;
        }
        return false;
      },
    },
    onFocus: () => {
      lastFocusedInstanceKey = instanceKey;
    },
    onUpdate: ({ editor: ed, transaction }) => {
      if (syncingRef.current || !transaction.docChanged) return;
      // 与笔记本共用序列化管线（含转义与规范化），保证单元格内容与 .md 文件写法一致
      const md = serializeMarkdown(ed);
      lastEmittedRef.current = md;
      onChangeRef.current(md);
    },
    // 编辑器实例在浮层关闭时销毁，无需 immediatelyRender 之类 SSR 处理
  });

  /** 以程序化方式写入 Markdown（不入撤销栈、不回抛 onChange）；返回 false 表示解析降级 */
  const applyMarkdown = useCallback((markdown: string): boolean => {
    if (!editor || editor.isDestroyed) return false;
    syncingRef.current = true;
    try {
      return parseMarkdown(editor, markdown);
    } finally {
      syncingRef.current = false;
    }
  }, [editor]);

  // 初始内容：在首帧绘制前解析写入，走与笔记本相同的解析管线（重复 mark 修复、解析失败降级）
  const initializedRef = useRef(false);
  useLayoutEffect(() => {
    if (!editor || initializedRef.current) return;
    initializedRef.current = true;
    applyMarkdown(lastEmittedRef.current);
  }, [editor, applyMarkdown]);

  // 外部值（如切换记录、撤销）与编辑器内容不一致时同步回写
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    applyMarkdown(value);
    setSourceDraft(value);
  }, [value, editor, applyMarkdown]);

  // 卸载时释放「最近聚焦」标记，避免链接请求落到已销毁的实例
  useEffect(() => () => {
    if (lastFocusedInstanceKey === instanceKey) lastFocusedInstanceKey = null;
  }, [instanceKey]);

  // 切到源码模式时，用编辑器当前内容的 Markdown 覆盖草稿，保证不丢未同步的编辑
  const handleSwitchToSource = useCallback(() => {
    setContextMenu(null);
    if (editor && !editor.isDestroyed) {
      const md = serializeMarkdown(editor);
      setSourceDraft(md);
      if (md !== lastEmittedRef.current) {
        lastEmittedRef.current = md;
        onChangeRef.current(md);
      }
    }
    onModeChange('source');
  }, [editor, onModeChange]);

  // 切回可视化模式时，把源码草稿解析回编辑器；解析降级时留在源码模式，交由用户继续修正
  const handleSwitchToRich = useCallback(() => {
    if (editor && !editor.isDestroyed) {
      if (!applyMarkdown(sourceDraft)) return;
      lastEmittedRef.current = sourceDraft;
      onChangeRef.current(sourceDraft);
    }
    onModeChange('rich');
  }, [editor, sourceDraft, applyMarkdown, onModeChange]);

  /**
   * 插入或清除链接：使用全局输入弹窗获取地址
   * 弹窗挂在 body 下且层级高于单元格编辑弹层，并在捕获阶段接管 Esc，不会误关外层弹层
   */
  const handleLink = useCallback(async () => {
    if (!editor || editor.isDestroyed) return;
    const previous = editor.getAttributes('link').href as string | undefined;
    const url = await promptLinkUrl(previous);
    if (url === null || editor.isDestroyed) return;
    if (!url) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    if (editor.state.selection.empty && !editor.isActive('link')) {
      // 空选区直接插入以地址为文字的链接，否则 setLink 不会产生任何可见内容
      editor.chain().focus().insertContent({
        type: 'text',
        text: url,
        marks: [{ type: 'link', attrs: { href: url } }],
      }).run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  /**
   * 链接请求分发：
   * 1. 本实例扩展（点击链接、Ctrl+K）按实例标识定向发出；
   * 2. 斜杠菜单按当前文档 key 广播，只由最近聚焦的单元格编辑器响应。
   */
  useEffect(() => {
    const handleOpen = (payload: { key?: string }) => {
      const activeKey = useWindowStore.getState().activeKey;
      const isMine =
        payload.key === instanceKey ||
        (!!payload.key && payload.key === activeKey && lastFocusedInstanceKey === instanceKey);
      if (isMine) void handleLink();
    };
    on('open-link-modal', handleOpen);
    return () => off('open-link-modal', handleOpen);
  }, [instanceKey, handleLink]);

  // 顶部工具栏的撤销/重做走编辑器自带历史（单元格没有文件级时间线）
  const toolbarHistory = useMemo<MarkdownToolbarHistory | undefined>(() => {
    if (!editor) return undefined;
    return {
      canUndo: () => !editor.isDestroyed && editor.can().undo(),
      canRedo: () => !editor.isDestroyed && editor.can().redo(),
      undo: () => editor.chain().focus().undo().run(),
      redo: () => editor.chain().focus().redo().run(),
    };
  }, [editor]);

  // 图片插入等按文档目录保存资源：取所在多维表格文档
  const activeDocKey = useWindowStore((s) => s.activeKey) ?? '';

  // 右键菜单：与笔记本一致，空选区时先把光标移到点击处，使「在此处插入」符合直觉
  const handleContextMenu = (e: React.MouseEvent) => {
    if (!editor || editor.isDestroyed) return;
    // 节点内部的输入框（图表源码、公式等）保留原生菜单，便于复制粘贴
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea')) return;
    e.preventDefault();
    e.stopPropagation();
    const { empty } = editor.state.selection;
    if (empty) {
      const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (pos) editor.commands.setTextSelection(pos.pos);
    }
    setContextMenu({ x: e.clientX, y: e.clientY, hasSelection: !empty });
  };

  /**
   * 点击编辑区留白（四周内边距、内容下方的空白）时把光标送进正文
   * 正文元素只有内容高度，留白属于外层滚动容器，ProseMirror 收不到这些点击，
   * 不处理的话需要精确点中文字才能开始输入，且焦点会落到外层面板上。
   */
  const handleBodyMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget || !editor || editor.isDestroyed) return;
    // 阻止默认的焦点转移，避免先失焦（触发失焦提交）再聚焦
    e.preventDefault();
    const { view, state } = editor;
    const pmRect = view.dom.getBoundingClientRect();

    // 点在内容下方：落到文末；末尾是表格、代码块、图表等非段落块时补一个空段落，否则无法在其后继续输入
    if (e.clientY >= pmRect.bottom) {
      const last = state.doc.lastChild;
      if (last && last.type.name !== 'paragraph') {
        editor.chain().insertContentAt(state.doc.content.size, { type: 'paragraph' }).focus('end').run();
      } else {
        editor.commands.focus('end');
      }
      return;
    }

    // 点在左右内边距：按同一高度取最近的文本位置，效果同点在该行行首/行尾
    const left = Math.min(Math.max(e.clientX, pmRect.left + 1), pmRect.right - 1);
    const top = Math.min(Math.max(e.clientY, pmRect.top + 1), pmRect.bottom - 1);
    const hit = view.posAtCoords({ left, top });
    if (!hit) {
      editor.commands.focus('end');
      return;
    }
    // 用 Selection.near 取合法落点：坐标可能落在两个块之间，直接建 TextSelection 会产生无效选区
    view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(hit.pos))));
    view.focus();
  };

  const isRich = mode === 'rich';

  return (
    <div className="nb-bitable-rte" style={{ minHeight }}>
      {isRich && editor && (
        <div className="nb-bitable-rte-toolbar">
          <MarkdownToolbar
            docKey={activeDocKey}
            editor={editor}
            viewMode="visual"
            history={toolbarHistory}
            onOpenLink={() => void handleLink()}
            wrap
          />
        </div>
      )}

      <div
        className="nb-bitable-rte-body"
        style={{ minHeight, display: isRich ? 'block' : 'none' }}
        onMouseDown={handleBodyMouseDown}
        onContextMenu={handleContextMenu}
      >
        {isRich && editor && <EditorBubbleMenu editor={editor} onOpenLinkModal={() => void handleLink()} />}
        {isRich && editor && <TableToolbar editor={editor} />}
        {isRich && editor && <BlockDragHandle editor={editor} formatMenu={false} />}
        {isRich && editor && contextMenu && (
          <EditorContextMenu
            editor={editor}
            position={{ x: contextMenu.x, y: contextMenu.y }}
            hasSelection={contextMenu.hasSelection}
            onClose={() => setContextMenu(null)}
            onOpenLinkModal={() => void handleLink()}
          />
        )}
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
              onChangeRef.current(next);
            }}
            onBlur={() => blurCommitRef.current?.()}
            style={{ minHeight: minHeight - 16 }}
          />
        </div>
      )}

      {/* 模式切换：放在编辑区外，避免随内容滚动 */}
      <div className="nb-bitable-rte-footer">
        <Tooltip content={isRich ? '查看与编辑 Markdown 源码' : '返回可视化编辑'} side="top" sideOffset={4}>
          <button
            type="button"
            className="nb-bitable-btn-secondary"
            onClick={isRich ? handleSwitchToSource : handleSwitchToRich}
            aria-label={isRich ? '查看与编辑 Markdown 源码' : '返回可视化编辑'}
            style={{
              padding: '3px 8px',
              fontSize: 11,
            }}
          >
            {isRich ? 'Markdown 源码' : '返回可视化'}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
