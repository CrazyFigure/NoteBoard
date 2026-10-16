// NoteBoard 块级原始 HTML 节点视图
// 可渲染的 HTML 块按过滤后的结果显示（与 GitHub 渲染 README 一致），不可渲染的保持只读源码样式；
// 双击或点击"编辑"进入源码编辑，修改只作用于 raw 原文，渲染结果从不写回文件。
// 从插入菜单新建的块 raw 为空：挂载后直接进入编辑；未输入内容时失焦或"完成"保留空块（显示占位，序列化时忽略），
// 仅按 Esc / "取消" 时移除。

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Selection } from '@tiptap/pm/state';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Code2 } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { handleRenderedHtmlLinkClick, isAbsoluteLocalPath, resolveRelativeDocPath } from './linkHandler';
import { renderRawHtmlPreview } from './rawHtmlRender';

/** 可视化模式插入的空 HTML 块 */
export function insertRawHtmlContent() {
  return { type: 'rawHtmlBlock', attrs: { raw: '' } };
}

/** 源码模式插入的 HTML 片段：前后空行保证被识别为独立的块级 HTML，块内不能有空行 */
export const RAW_HTML_SOURCE_SNIPPET = '\n<p align="center">\n  HTML 内容\n</p>\n\n';

// 新建空块时编辑框的输入提示
const EDITOR_PLACEHOLDER = '输入 HTML，例如：\n<p align="center"><b>标题</b><br>副标题</p>\n\n块内不要留空行；Ctrl+Enter 完成，Esc 取消';

// 网络地址、内联数据与已转换的 asset 地址无需解析
const PASSTHROUGH_SRC_PATTERN = /^(?:https?:|data:|blob:|asset:)/i;

/** 当前文档所在目录（与图片节点一致：未保存的文档回退到资源管理器根目录） */
function currentBaseDir(): string | null {
  const activeKey = useWindowStore.getState().activeKey;
  const currentDoc = activeKey ? useDocumentStore.getState().getDocument(activeKey) : null;
  return currentDoc?.dirPath || useExplorerStore.getState().root || null;
}

/** 本地图片路径转换为 webview 可加载的 asset 地址 */
function resolveLocalSrc(src: string, baseDir: string | null): string {
  if (PASSTHROUGH_SRC_PATTERN.test(src) || src.startsWith('#')) return src;
  const absPath = baseDir ? resolveRelativeDocPath(baseDir, src) : isAbsoluteLocalPath(src) ? src : null;
  if (!absPath) return src;
  try {
    return convertFileSrc(absPath);
  } catch {
    return src;
  }
}

/** 按当前文档目录解析 HTML 中的图片地址（行内 HTML 视图共用） */
export function resolveDocumentImageSrc(src: string): string {
  return resolveLocalSrc(src, currentBaseDir());
}

export function RawHtmlBlockComponent({ node, editor, getPos, selected, updateAttributes, deleteNode }: NodeViewProps) {
  const raw = String(node.attrs.raw ?? '');
  // 新插入的空块直接进入编辑
  const [editing, setEditing] = useState(() => raw === '' && editor.isEditable);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const baseDir = currentBaseDir();
  const preview = useMemo(() => renderRawHtmlPreview(raw, (src) => resolveLocalSrc(src, baseDir)), [raw, baseDir]);

  const startEditing = () => {
    if (!editor.isEditable) return;
    setDraft(raw);
    setEditing(true);
  };

  // 提交修改：末尾空白与解析时的处理保持一致；内容为空时保留空块（点到外面不让块消失），
  // 空块显示占位、序列化时被忽略，不会写出多余空行
  const commit = () => {
    const next = draft.replace(/\s+$/, '');
    setEditing(false);
    if (next !== raw) {
      updateAttributes({ raw: next });
    }
  };

  // 取消修改：空块（刚插入、尚未输入）直接移除
  const cancel = () => {
    setEditing(false);
    if (raw === '') deleteNode();
  };

  // 通过按钮或快捷键结束编辑后把焦点交还编辑器，便于继续输入（失焦提交不抢焦点）。
  // 光标放到块后的文本位置：若停留在节点选中态，继续打字会把整个 HTML 块替换掉
  const finish = (action: () => void) => {
    const pos = getPos();
    action();
    if (typeof pos !== 'number') {
      editor.commands.focus();
      return;
    }
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        // 块仍在时从其后方查找，被移除时从原位置查找
        const target = Math.min(tr.doc.nodeAt(pos)?.type.name === 'rawHtmlBlock' ? pos + 1 : pos, tr.doc.content.size);
        const $target = tr.doc.resolve(target);
        const selection = Selection.findFrom($target, 1, true) ?? Selection.findFrom($target, -1, true);
        if (selection) tr.setSelection(selection);
        return true;
      })
      .run();
  };

  // 进入编辑时聚焦编辑框：插入命令链中的 focus() 会在下一帧把焦点交还编辑器，需排在其后执行
  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  if (editing) {
    return (
      <NodeViewWrapper className="nb-raw-html is-editing" contentEditable={false}>
        <div className="nb-raw-html-editor-bar">
          <span>编辑 HTML 源码</span>
          <span className="nb-raw-html-editor-actions">
            {/* 按下时阻止 textarea 失焦，否则失焦提交会先于"取消"执行 */}
            <button type="button" className="nb-raw-html-btn is-primary" onMouseDown={(e) => e.preventDefault()} onClick={() => finish(commit)}>
              完成
            </button>
            <button type="button" className="nb-raw-html-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => finish(cancel)}>
              取消
            </button>
          </span>
        </div>
        <textarea
          ref={textareaRef}
          className="nb-raw-html-textarea"
          value={draft}
          placeholder={EDITOR_PLACEHOLDER}
          rows={Math.min(Math.max(draft.split('\n').length, 4), 24)}
          spellCheck={false}
          // 用户主动进入编辑，移动端聚焦守卫需放行
          data-nb-allow-autofocus=""
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') {
              e.preventDefault();
              finish(cancel);
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              finish(commit);
            }
          }}
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      className={`nb-raw-html${selected ? ' is-selected' : ''}${editor.isEditable ? ' is-editable' : ''}`}
      contentEditable={false}
      // 双击进入编辑：在第二次按下时（捕获阶段）判定，而非依赖 dblclick——
      // 渲染内容里的链接、图片会被浏览器当作拖拽源，按下后轻微移动即取消 dblclick，导致这些区域双击无效
      onMouseDownCapture={(e: ReactMouseEvent<HTMLElement>) => {
        if (e.detail !== 2 || e.button !== 0 || (e.target as Element).closest('button')) return;
        e.preventDefault();
        e.stopPropagation();
        startEditing();
      }}
    >
      {preview.kind === 'render' ? (
        <div
          className="nb-md-html-render"
          // 内容已经过 DOMPurify 白名单过滤
          dangerouslySetInnerHTML={{ __html: preview.html }}
          // 链接一律拦截原生跳转；Ctrl/Cmd + 单击或中键单击用系统默认浏览器打开（本地文件在 NoteBoard 内打开）
          onClick={(e) => {
            handleRenderedHtmlLinkClick(e);
          }}
          onAuxClick={(e) => {
            handleRenderedHtmlLinkClick(e);
          }}
        />
      ) : (
        <pre className="nb-md-raw-block nb-md-raw-html" data-label="HTML">
          {/* 空块：新建后未输入即失焦，或清空了源码 */}
          {raw || '空 HTML 块（双击编辑）'}
        </pre>
      )}
      {editor.isEditable && (
        <span className="nb-raw-html-toolbar">
          <Tooltip content="编辑 HTML 源码（双击块亦可）" side="top" sideOffset={4}>
            <button
              type="button"
              className="nb-raw-html-btn"
              aria-label="编辑 HTML 源码"
              onMouseDown={(e) => e.preventDefault()}
              onClick={startEditing}
            >
              <Code2 size={12} />
              <span>HTML</span>
            </button>
          </Tooltip>
        </span>
      )}
    </NodeViewWrapper>
  );
}
