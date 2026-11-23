// NoteBoard Markdown 内嵌思维导图画布（按需懒加载）
// 复用 MindmapRenderer、MindmapCanvasToolbar、mindmapActions 与 canvasEditors.css，
// 提供与 .mindmap 文件「导图模式」一致的功能与多主题外观（不提供大纲模式），支持内联调高与全屏编辑。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { Maximize2, Minimize2, Network, Redo2, Undo2 } from 'lucide-react';
import '../../styles/canvasEditors.css';
import type {
  MindNode,
  MindmapEdgeStyle,
  MindmapImageFit,
  MindmapLayout,
  MindmapTextAlign,
} from '../mindmap/mindmapTypes';
import {
  DEFAULT_MINDMAP_LAYOUT,
  DEFAULT_MINDMAP_THEME,
  parseMindmapDocument,
  parseMindmapDocumentMeta,
  serializeMindmapDocument,
} from '../mindmap/mindmapConverter';
import { getMindmapTheme } from '../mindmap/mindmapTheme';
import type { MindmapImageFormat } from '../mindmap/mindmapImageExport';
import { clampNodeMaxWidth, FALLBACK_FONT_FAMILY } from '../mindmap/mindmapTextMeasure';
import {
  clearNodeWidths,
  exportMindmapAsImage,
  exportMindmapAsMarkdown,
  exportMindmapAsXmind,
  hasCustomNodeWidth,
  readMindmapImportFile,
} from '../mindmap/mindmapActions';
import { MindmapCanvasToolbar } from '../mindmap/MindmapCanvasToolbar';
import {
  MindmapRenderer,
  type MindmapRendererHandle,
  type MindmapSelectionInfo,
} from '../mindmap/MindmapRenderer';
import { createInitialMindmapView } from '../mindmap/mindmapView';
import { useSettingsStore } from '../../stores/settingsStore';
import { useDocumentStore } from '../../stores/documentStore';
import { showToast } from '../../stores/toastStore';
import { buildExportFileName } from '../export/chartExport';
import { Tooltip } from '../../components/Tooltip';
import {
  hasDocumentHistory,
  redoDocumentHistory,
  undoDocumentHistory,
  useDocumentHistory,
} from '../history/documentHistory';
import { hasPendingVisualSnapshot } from './visualSnapshot';
import { IS_MOBILE_UI } from '../../core/platform';

const DEFAULT_INLINE_HEIGHT = IS_MOBILE_UI ? 320 : 420;
const MIN_INLINE_HEIGHT = 240;
const MAX_INLINE_HEIGHT = 800;

export interface MdMindmapCanvasProps {
  code: string;
  docKey: string;
  editor: Editor;
  readOnly: boolean;
  onChangeCode: (nextCode: string) => void;
}

/** 限制内联画布高度到安全区间 */
function clampInlineHeight(height: number): number {
  return Math.max(MIN_INLINE_HEIGHT, Math.min(MAX_INLINE_HEIGHT, Math.round(height)));
}

/** 判断事件目标是否为原生文本输入控件 */
function isTextInputTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

/** 屏蔽导图非文本输入区域的右键事件，防止冒泡到 Markdown 正文弹出 EditorContextMenu */
function handleCanvasContextMenu(e: React.MouseEvent): void {
  if (!isTextInputTarget(e.target)) {
    e.preventDefault();
  }
  e.stopPropagation();
}

export default function MdMindmapCanvas({
  code,
  docKey,
  editor,
  readOnly,
  onChangeCode,
}: MdMindmapCanvasProps) {
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [inlineHeight, setInlineHeight] = useState(DEFAULT_INLINE_HEIGHT);
  const [isResizingHeight, setIsResizingHeight] = useState(false);

  const [rootNode, setRootNode] = useState<MindNode>(() => parseMindmapDocument(code));
  const [autoCollapse, setAutoCollapse] = useState(true);
  const displayedRoot = useMemo(
    () => (autoCollapse ? createInitialMindmapView(rootNode) : rootNode),
    [rootNode, autoCollapse],
  );
  const [layout, setLayout] = useState<MindmapLayout>(
    () => parseMindmapDocumentMeta(code).layout ?? DEFAULT_MINDMAP_LAYOUT,
  );
  const [themeId, setThemeId] = useState<string>(
    () => parseMindmapDocumentMeta(code).theme ?? DEFAULT_MINDMAP_THEME,
  );
  const [edgeStyle, setEdgeStyle] = useState<MindmapEdgeStyle | undefined>(
    () => parseMindmapDocumentMeta(code).edgeStyle,
  );

  const theme = getMindmapTheme(themeId);
  const resolvedEdgeStyle = edgeStyle ?? theme.edgeStyle;

  // 全局导图排版设置（与独立 .mindmap 文件保持一致）
  const maxNodeWidth = clampNodeMaxWidth(
    useSettingsStore((s) => s.settings.editor.mindmapNodeMaxWidth),
  );
  const defaultTextAlign: MindmapTextAlign =
    useSettingsStore((s) => s.settings.editor.mindmapTextAlign) === 'center' ? 'center' : 'left';
  const defaultImageFit: MindmapImageFit =
    useSettingsStore((s) => s.settings.editor.mindmapImageFit) === 'fill' ? 'fill' : 'original';

  // 导出文件名前缀：优先使用当前 Markdown 文档名，否则回退「思维导图」
  const docDisplayName = useDocumentStore((s) =>
    docKey ? s.documents.get(docKey)?.displayName : undefined,
  );
  const exportBaseName = buildExportFileName(docDisplayName, '思维导图');

  const rootElRef = useRef<HTMLDivElement>(null);
  const fullscreenElRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MindmapRendererHandle>(null);
  const [selection, setSelection] = useState<MindmapSelectionInfo>({
    nodeIds: [],
    includesRoot: false,
  });

  // 最新状态引用，避免高频编辑或异步操作读到过期闭包
  const rootNodeRef = useRef(rootNode);
  rootNodeRef.current = rootNode;
  const displayedRootRef = useRef(displayedRoot);
  displayedRootRef.current = displayedRoot;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const themeIdRef = useRef(themeId);
  themeIdRef.current = themeId;
  const edgeStyleRef = useRef(edgeStyle);
  edgeStyleRef.current = edgeStyle;
  const lastCommittedCodeRef = useRef(code);
  const onChangeCodeRef = useRef(onChangeCode);
  onChangeCodeRef.current = onChangeCode;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  // 外部 code 变更同步（文档撤销/重做、源码模式修改、外部重载）
  useEffect(() => {
    if (code === lastCommittedCodeRef.current) return;
    lastCommittedCodeRef.current = code;
    setRootNode(parseMindmapDocument(code));
    // 外部恢复/撤销应准确还原节点树原本的展开状态
    setAutoCollapse(false);
    const meta = parseMindmapDocumentMeta(code);
    setLayout(meta.layout);
    setThemeId(meta.theme);
    setEdgeStyle(meta.edgeStyle);
  }, [code]);

  // 文档级历史 / 嵌入式编辑器自身历史同步
  const docHistory = useDocumentHistory(docKey || '__md-mindmap-unused__');
  const [, setEditorTick] = useState(0);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const onTx = () => setEditorTick((t) => (t + 1) % 100000);
    editor.on('transaction', onTx);
    return () => {
      editor.off('transaction', onTx);
    };
  }, [editor]);

  const usesDocumentHistory = hasDocumentHistory(docKey);
  const canUndo = usesDocumentHistory
    ? docHistory.canUndo || hasPendingVisualSnapshot(docKey)
    : !editor.isDestroyed && editor.can().undo();
  const canRedo = usesDocumentHistory
    ? docHistory.canRedo
    : !editor.isDestroyed && editor.can().redo();

  const handleUndo = useCallback(() => {
    if (readOnlyRef.current) return;
    if (hasDocumentHistory(docKey)) {
      undoDocumentHistory(docKey);
      return;
    }
    if (!editor.isDestroyed) editor.commands.undo();
  }, [docKey, editor]);

  const handleRedo = useCallback(() => {
    if (readOnlyRef.current) return;
    if (hasDocumentHistory(docKey)) {
      redoDocumentHistory(docKey);
      return;
    }
    if (!editor.isDestroyed) editor.commands.redo();
  }, [docKey, editor]);

  // 将当前树与外观元信息序列化写回 mindmapBlock.attrs.code
  const persistCode = useCallback(
    (
      nextRoot: MindNode,
      nextLayout: MindmapLayout,
      nextTheme: string,
      nextEdgeStyle: MindmapEdgeStyle | undefined,
    ) => {
      if (readOnlyRef.current) return;
      const serialized = serializeMindmapDocument(nextRoot, {
        layout: nextLayout,
        theme: nextTheme,
        edgeStyle: nextEdgeStyle,
      });
      lastCommittedCodeRef.current = serialized;
      onChangeCodeRef.current(serialized);
    },
    [],
  );

  // 节点树变更：关闭首次自动折叠，提交最新树并序列化回写 Markdown 块
  const handleRootChange = useCallback(
    (newRoot: MindNode) => {
      if (readOnlyRef.current) return;
      setAutoCollapse(false);
      rootNodeRef.current = newRoot;
      displayedRootRef.current = newRoot;
      setRootNode(newRoot);
      persistCode(newRoot, layoutRef.current, themeIdRef.current, edgeStyleRef.current);
    },
    [persistCode],
  );

  // 切换布局 / 配色主题 / 连线样式并即时持久化
  const handleStyleChange = useCallback(
    (next: { layout?: MindmapLayout; theme?: string; edgeStyle?: MindmapEdgeStyle | null }) => {
      if (readOnlyRef.current) return;
      const nextLayout = next.layout ?? layoutRef.current;
      const nextTheme = next.theme ?? themeIdRef.current;
      const nextEdgeStyle =
        next.edgeStyle === undefined ? edgeStyleRef.current : next.edgeStyle ?? undefined;
      setLayout(nextLayout);
      setThemeId(nextTheme);
      setEdgeStyle(nextEdgeStyle);
      setAutoCollapse(false);
      setRootNode(displayedRootRef.current);
      rootNodeRef.current = displayedRootRef.current;
      persistCode(displayedRootRef.current, nextLayout, nextTheme, nextEdgeStyle);
    },
    [persistCode],
  );

  // 重置全部手动拉伸的节点宽度
  const hasCustomWidths = hasCustomNodeWidth(rootNode);
  const handleResetAllWidths = useCallback(() => {
    if (readOnlyRef.current || !hasCustomNodeWidth(rootNodeRef.current)) return;
    handleRootChange(clearNodeWidths(displayedRootRef.current));
    showToast('已重置全部节点宽度', 'success');
  }, [handleRootChange]);

  // 导出为 XMind / Markdown / 图片
  const handleExportXmind = () => exportMindmapAsXmind(rootNodeRef.current, exportBaseName);
  const handleExportMarkdown = () => exportMindmapAsMarkdown(rootNodeRef.current, exportBaseName);
  const handleExportImage = (format: MindmapImageFormat) => {
    const activeHost = fullscreen ? fullscreenElRef.current : rootElRef.current;
    const fontFamily =
      (activeHost && window.getComputedStyle(activeHost).fontFamily) || FALLBACK_FONT_FAMILY;
    return exportMindmapAsImage({
      root: rootNodeRef.current,
      displayedRoot: displayedRootRef.current,
      layout: layoutRef.current,
      theme: getMindmapTheme(themeIdRef.current),
      edgeStyle: edgeStyleRef.current ?? getMindmapTheme(themeIdRef.current).edgeStyle,
      maxNodeWidth,
      defaultTextAlign,
      defaultImageFit,
      fontFamily,
      format,
      baseName: exportBaseName,
    });
  };

  // 导入 .xmind 或 Markdown 大纲替换当前导图
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (readOnlyRef.current) return;
    const result = await readMindmapImportFile(file);
    if (!result) return;
    handleRootChange(result.root);
    setAutoCollapse(true);
    showToast(result.isXmind ? '成功导入 XMind 思维导图' : '成功导入 Markdown 大纲');
  };

  // 全屏模式下监听 Esc 退出与撤销/重做快捷键
  useEffect(() => {
    if (!fullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (isTextInputTarget(e.target)) return;
        const key = e.key.toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) handleRedo();
          else handleUndo();
          return;
        }
        if (key === 'y') {
          e.preventDefault();
          e.stopPropagation();
          handleRedo();
          return;
        }
      }
      if (e.key === 'Escape' && !e.defaultPrevented) {
        // 内部浮层（确认框、备注弹窗、下拉菜单等）打开时不直接退出全屏
        const hasOverlay = Boolean(
          document.querySelector('[data-mindmap-overlay], .nb-mindmap-confirm-overlay') ||
            fullscreenElRef.current?.querySelector('[role="menu"]'),
        );
        if (hasOverlay) return;
        e.preventDefault();
        e.stopPropagation();
        setFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fullscreen, handleUndo, handleRedo]);

  // 底部手柄拖拽调整内联画布高度
  const resizeHeightSessionRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const handleHeightPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    resizeHeightSessionRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startHeight: inlineHeight,
    };
    setIsResizingHeight(true);
  };

  const handleHeightPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const session = resizeHeightSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    e.stopPropagation();
    setInlineHeight(clampInlineHeight(session.startHeight + (e.clientY - session.startY)));
  };

  const handleHeightPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const session = resizeHeightSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    e.stopPropagation();
    resizeHeightSessionRef.current = null;
    setIsResizingHeight(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  // 内联画布内按 Ctrl+Z / Ctrl+Y 撤销重做（输入节点标题时放行原生文字撤销）
  const handleInlineKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (isTextInputTarget(e.target)) return;
    const key = e.key.toLowerCase();
    if (key === 'z') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) handleRedo();
      else handleUndo();
    } else if (key === 'y') {
      e.preventDefault();
      e.stopPropagation();
      handleRedo();
    }
  };

  // 全屏与内联共用的顶部标签及全屏切换按钮
  const badgeLeftSlot = (
    <div className="nb-md-mindmap-badge">
      <Network size={14} color="#f97316" />
      <span>思维导图</span>
    </div>
  );

  const fullscreenToggleBtn = (
    <Tooltip content={fullscreen ? '退出全屏' : '全屏编辑'} side="bottom" sideOffset={4}>
      <button
        type="button"
        className="nb-editor-icon-btn"
        onClick={() => setFullscreen((prev) => !prev)}
        aria-label={fullscreen ? '退出全屏' : '全屏编辑'}
      >
        {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
    </Tooltip>
  );

  const renderToolbar = () => (
    <MindmapCanvasToolbar
      className="nb-md-mindmap-topbar"
      leftSlot={badgeLeftSlot}
      readOnly={readOnly}
      zoom={zoom}
      onZoomChange={setZoom}
      onResetZoom={() => setZoom(1)}
      hasCustomWidths={hasCustomWidths}
      onResetAllWidths={handleResetAllWidths}
      selection={selection}
      onAddSummary={() => rendererRef.current?.addSummary()}
      onAddBoundary={() => rendererRef.current?.addBoundary()}
      onStartConnect={() => rendererRef.current?.startConnect()}
      layout={layout}
      themeId={themeId}
      edgeStyle={edgeStyle}
      onStyleChange={handleStyleChange}
      onImportFile={handleImportFile}
      onExportXmind={() => void handleExportXmind()}
      onExportMarkdown={() => void handleExportMarkdown()}
      onExportImage={(format) => void handleExportImage(format)}
      extraActions={fullscreenToggleBtn}
    />
  );

  const renderCanvasBody = (isEmbedded: boolean) => (
    <div
      data-md-mindmap-interactive="true"
      onContextMenu={handleCanvasContextMenu}
      style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}
    >
      <MindmapRenderer
        ref={rendererRef}
        onSelectionChange={setSelection}
        root={displayedRoot}
        onChange={handleRootChange}
        zoom={zoom}
        onZoomChange={setZoom}
        layout={layout}
        theme={theme}
        edgeStyle={resolvedEdgeStyle}
        maxNodeWidth={maxNodeWidth}
        defaultTextAlign={defaultTextAlign}
        defaultImageFit={defaultImageFit}
        docKey={docKey || undefined}
        embedded={isEmbedded}
        readOnly={readOnly}
      />

      {/* 左下角撤销 / 重做（只读态隐藏） */}
      {!readOnly && (
        <div className="nb-mindmap-history-bar">
          <Tooltip content="撤销" shortcut="Ctrl+Z" side="top" sideOffset={6}>
            <button
              type="button"
              className="nb-mindmap-history-btn"
              aria-label="撤销"
              disabled={!canUndo}
              onClick={handleUndo}
            >
              <Undo2 size={15} />
            </button>
          </Tooltip>
          <Tooltip content="重做" shortcut="Ctrl+Y" side="top" sideOffset={6}>
            <button
              type="button"
              className="nb-mindmap-history-btn"
              aria-label="重做"
              disabled={!canRedo}
              onClick={handleRedo}
            >
              <Redo2 size={15} />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div
        ref={rootElRef}
        className="nb-md-mindmap-container"
        onContextMenu={handleCanvasContextMenu}
      >
        {fullscreen ? (
          <div className="nb-md-mindmap-fullscreen-placeholder" data-md-mindmap-interactive="true">
            <div className="nb-md-mindmap-badge">
              <Network size={14} color="#f97316" />
              <span>正在全屏编辑思维导图</span>
            </div>
            <button
              type="button"
              className="nb-editor-toolbar-btn"
              onClick={() => setFullscreen(false)}
            >
              <Minimize2 size={13} />
              <span>返回内联视图</span>
            </button>
          </div>
        ) : (
          <>
            {renderToolbar()}
            <div
              className="nb-md-mindmap-viewport"
              data-md-mindmap-interactive="true"
              onKeyDown={handleInlineKeyDown}
              style={{ height: inlineHeight }}
            >
              {renderCanvasBody(true)}
            </div>
            {!IS_MOBILE_UI && !readOnly && (
              <Tooltip content="拖动调整导图高度，双击恢复默认" side="bottom" sideOffset={4}>
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="调整导图高度"
                  data-md-mindmap-interactive="true"
                  data-dragging={isResizingHeight}
                  className="nb-md-mindmap-resize-handle"
                  onPointerDown={handleHeightPointerDown}
                  onPointerMove={handleHeightPointerMove}
                  onPointerUp={handleHeightPointerUp}
                  onPointerCancel={handleHeightPointerUp}
                  onDoubleClick={() => setInlineHeight(DEFAULT_INLINE_HEIGHT)}
                />
              </Tooltip>
            )}
          </>
        )}
      </div>

      {/* 全屏编辑弹层（仅挂载唯一一份活跃导图渲染器，恢复完整滚轮平移体验） */}
      {fullscreen &&
        createPortal(
          <div
            ref={fullscreenElRef}
            className="nb-md-mindmap-fullscreen"
            data-md-mindmap-interactive="true"
            onContextMenu={handleCanvasContextMenu}
          >
            {renderToolbar()}
            {renderCanvasBody(false)}
          </div>,
          document.body,
        )}
    </>
  );
}
