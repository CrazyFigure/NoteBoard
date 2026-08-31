// NoteBoard 信息图独立文件编辑器（.infographic / .ig）
// 左侧声明式源码（YAML / JSON）+ 右侧实时渲染预览 + 模板填充 + 缩放平移 + SVG/PNG 复制导出
// 与 Markdown 内嵌 ```infographic 块共用同一套解析器与渲染器，源码可双向复用
// 信息图只对外产出图片（SVG / PNG），不再提供源码复制与源码导出
// 详见 docs/09-开发路线图.md

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import { defaultKeymap, historyKeymap, history } from '@codemirror/commands';
import {
  Columns,
  Code2,
  Eye,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  AlertCircle,
  Sparkles,
  ChevronDown,
} from 'lucide-react';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { parseInfographicCode } from './infographicParser';
import { InfographicRenderer } from './infographicRenderer';
import { INFOGRAPHIC_TEMPLATES } from './infographicTemplates';
import { InfographicTemplateIcon } from './infographicTemplateIcon';
import { loadLanguageExtension } from '../editor-code/languages';
import { ChartExportMenu } from '../export/ChartExportMenu';
import { Tooltip } from '../../components/Tooltip';
import { buildExportFileName, type ChartImageSource } from '../export/chartExport';

interface InfographicSplitEditorProps {
  docKey: string;
}

type LayoutMode = 'split' | 'code' | 'preview';

/** 预览画布基准宽度：信息图为流式布局，固定基准宽再整体缩放，避免随分栏宽度抖动重排 */
const CANVAS_BASE_WIDTH = 760;

export function InfographicSplitEditor({ docKey }: InfographicSplitEditorProps) {
  const doc = useDocumentStore((s) => s.documents.get(docKey));
  const setContent = useDocumentStore((s) => s.setContent);
  const setDirty = useDocumentStore((s) => s.setDirty);
  const setTabDirty = useWindowStore((s) => s.setTabDirty);

  const [layoutMode, setLayoutMode] = useState<LayoutMode>('split');
  const [splitRatio, setSplitRatio] = useState<number>(0.5);
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const [source, setSource] = useState<string>(doc?.content ?? '');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const templateMenuRef = useRef<HTMLDivElement>(null);

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const languageCompartmentRef = useRef<Compartment>(new Compartment());

  // 预览画布根节点：信息图是纯 DOM 渲染，复制/导出时抓取这里的实时快照。
  // 用 state 而非 ref 保存，节点挂载/卸载能触发重渲染，按钮禁用态才跟得上。
  const [previewEl, setPreviewEl] = useState<HTMLDivElement | null>(null);

  // 解析结果随源码同步推导：解析器为纯内存轻量计算，无需防抖
  const { data, error } = useMemo(() => parseInfographicCode(source), [source]);

  // 只在预览可见且渲染成功时才允许复制/导出
  const exportReady = layoutMode !== 'code' && !error && !!data && !!previewEl;
  const exportSource: ChartImageSource | null = exportReady
    ? { kind: 'element', element: previewEl }
    : null;
  const exportFileName = buildExportFileName(doc?.displayName, 'infographic');

  // 处理分隔条鼠标拖拽调整左右分栏比例
  const handleResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const newRatio = (moveEvent.clientX - rect.left) / rect.width;
      setSplitRatio(Math.max(0.18, Math.min(0.82, newRatio)));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // 初始化 CodeMirror 6 源码编辑器（仅在切换文档时重建）
  useEffect(() => {
    if (!editorContainerRef.current) return;
    if (editorViewRef.current) {
      editorViewRef.current.destroy();
    }

    const initialContent = doc?.content ?? '';
    setSource(initialContent);

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        languageCompartmentRef.current.of([]),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) {
            const newText = update.state.doc.toString();
            setSource(newText);
            setContent(docKey, newText);
            setDirty(docKey, true);
            setTabDirty(docKey, true);
          }
        }),
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: 'var(--mono-font-size, 13px)',
            fontFamily: 'var(--mono-font-family, monospace)',
            background: 'var(--cm-background, var(--editor-bg, #ffffff))',
            color: 'var(--cm-text, var(--editor-text, #1e293b))',
          },
          '.cm-content': {
            padding: '12px 0',
            caretColor: 'var(--cm-cursor, var(--editor-accent, #3b82f6))',
          },
          '.cm-gutters': {
            background: 'var(--cm-gutter-background, var(--editor-surface, #f8fafc))',
            color: 'var(--cm-gutter-text, var(--editor-text-muted, #94a3b8))',
            borderRight: '1px solid var(--editor-border, #e2e8f0)',
          },
          '&.cm-focused': {
            outline: 'none',
          },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorContainerRef.current,
    });

    editorViewRef.current = view;

    // 语法高亮为动态包，加载完成后再注入，避免阻塞首屏
    void loadLanguageExtension('infographic').then((ext) => {
      if (!editorViewRef.current) return;
      editorViewRef.current.dispatch({
        effects: languageCompartmentRef.current.reconfigure(ext),
      });
    });

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
    // 编辑器内容由自身驱动写回 store，此处仅依赖 docKey，避免输入时被外部重建导致失焦
  }, [docKey]);

  // 切换布局或分栏比例后通知 CodeMirror 重新测量尺寸
  useEffect(() => {
    if (layoutMode !== 'preview' && editorViewRef.current) {
      editorViewRef.current.requestMeasure();
    }
  }, [layoutMode, splitRatio]);

  // 点击外部关闭模板下拉
  useEffect(() => {
    if (!showTemplateMenu) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (templateMenuRef.current && !templateMenuRef.current.contains(e.target as unknown as globalThis.Node)) {
        setShowTemplateMenu(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [showTemplateMenu]);

  /** 用模板内容整体替换编辑器源码 */
  const applyTemplate = useCallback(
    (code: string) => {
      const view = editorViewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
        selection: { anchor: code.length },
      });
      setSource(code);
      setContent(docKey, code);
      setDirty(docKey, true);
      setTabDirty(docKey, true);
      setShowTemplateMenu(false);
      view.focus();
    },
    [docKey, setContent, setDirty, setTabDirty],
  );

  // 画布拖拽平移
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({ x: e.clientX - dragStartRef.current.x, y: e.clientY - dragStartRef.current.y });
  };

  const handleMouseUp = () => setIsDragging(false);

  // 画布滚轮缩放（需按住 Ctrl / Cmd，避免与滚动冲突）
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      setZoom((z) => Math.max(0.2, Math.min(4, z + delta)));
    }
  };

  // 布局切换按钮统一样式
  const layoutButton = (mode: LayoutMode, icon: React.ReactNode, label: string, title: string) => (
    <Tooltip content={title} side="bottom" sideOffset={4}>
      <button
        type="button"
        onClick={() => setLayoutMode(mode)}
        aria-label={title}
        className="nb-ig-layout-btn"
        data-active={layoutMode === mode ? 'true' : 'false'}
      >
        {icon}
        <span>{label}</span>
      </button>
    </Tooltip>
  );

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--editor-bg, #ffffff)',
        overflow: 'hidden',
      }}
    >
      <style>{`
        .nb-ig-layout-btn {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 3px 8px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 400;
          background: transparent;
          color: var(--editor-text-muted, #64748b);
          transition: background 120ms ease, color 120ms ease;
        }
        .nb-ig-layout-btn:hover { background: var(--toolbar-hover, rgba(59,130,246,0.12)); }
        .nb-ig-layout-btn[data-active='true'] {
          background: var(--toolbar-active, rgba(59, 130, 246, 0.12));
          color: var(--editor-accent, #3b82f6);
          font-weight: 600;
        }
        .nb-ig-icon-btn {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          border: 1px solid var(--editor-border, #e2e8f0);
          border-radius: 5px;
          background: var(--editor-bg, #ffffff);
          color: var(--editor-text, #1e293b);
          cursor: pointer;
          font-size: 12px;
          transition: background 120ms ease, border-color 120ms ease;
        }
        .nb-ig-icon-btn:hover { background: var(--toolbar-hover, rgba(59,130,246,0.12)); border-color: var(--editor-border-focus, #93c5fd); }
        .nb-ig-primary-btn {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 4px 10px;
          border: none;
          border-radius: 5px;
          background: var(--editor-accent, #3b82f6);
          color: #ffffff;
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
          transition: opacity 120ms ease;
        }
        .nb-ig-primary-btn:hover { opacity: 0.88; }
        .nb-ig-tmpl-item {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 6px 10px;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: var(--editor-text, #1e293b);
          cursor: pointer;
          font-size: 12px;
          text-align: left;
          transition: background 120ms ease;
        }
        .nb-ig-tmpl-item:hover { background: var(--toolbar-hover, rgba(59,130,246,0.12)); }
      `}</style>

      {/* 顶部工具栏 */}
      <div
        style={{
          height: 38,
          minHeight: 38,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid var(--editor-border, #e2e8f0)',
          background: 'var(--editor-surface, #f8fafc)',
          userSelect: 'none',
          fontSize: 12,
          color: 'var(--editor-text, #1e293b)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <Sparkles size={16} color="#14b8a6" />
            <span>信息图 (.infographic)</span>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: 'var(--editor-bg, #ffffff)',
              borderRadius: 6,
              padding: 2,
              border: '1px solid var(--editor-border, #e2e8f0)',
            }}
          >
            {layoutButton('split', <Columns size={13} />, '分屏', '双栏分屏')}
            {layoutButton('code', <Code2 size={13} />, '源码', '仅源码')}
            {layoutButton('preview', <Eye size={13} />, '预览', '仅预览')}
          </div>

          {/* 预设模板填充 */}
          <div ref={templateMenuRef} style={{ position: 'relative' }}>
            <Tooltip content="从预设模板填充源码" side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-ig-icon-btn"
                onClick={() => setShowTemplateMenu((prev) => !prev)}
                aria-label="从预设模板填充源码"
              >
                <Sparkles size={13} />
                <span>模板</span>
                <ChevronDown size={12} />
              </button>
            </Tooltip>

            {showTemplateMenu && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  left: 0,
                  zIndex: 10000,
                  minWidth: 220,
                  padding: 4,
                  background: 'var(--editor-surface, #ffffff)',
                  border: '1px solid var(--editor-border, #e2e8f0)',
                  borderRadius: 6,
                  boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))',
                }}
              >
                {INFOGRAPHIC_TEMPLATES.map((tmpl) => (
                  <Tooltip key={tmpl.id} content={tmpl.description} side="right" sideOffset={6}>
                    <button
                      type="button"
                      className="nb-ig-tmpl-item"
                      onClick={() => applyTemplate(tmpl.code)}
                      aria-label={tmpl.label}
                    >
                      {/* 彩色形象图标容器：与 Markdown 内嵌块模板下拉保持统一视觉 */}
                      <div
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 5,
                          background: tmpl.iconBg,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <InfographicTemplateIcon iconName={tmpl.iconName} color={tmpl.iconColor} size={14} />
                      </div>
                      {/* 纯中文模板名称（无多余英文后缀） */}
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontWeight: 600,
                          fontSize: 12,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {tmpl.label}
                      </span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {layoutMode !== 'code' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 8 }}>
              <Tooltip content="缩小" side="bottom" sideOffset={4}>
                <button
                  type="button"
                  className="nb-ig-icon-btn"
                  style={{ padding: '2px 6px' }}
                  onClick={() => setZoom((z) => Math.max(0.2, z - 0.15))}
                  aria-label="缩小"
                >
                  <ZoomOut size={13} />
                </button>
              </Tooltip>
              <span style={{ fontSize: 11, minWidth: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
              <Tooltip content="放大" side="bottom" sideOffset={4}>
                <button
                  type="button"
                  className="nb-ig-icon-btn"
                  style={{ padding: '2px 6px' }}
                  onClick={() => setZoom((z) => Math.min(4, z + 0.15))}
                  aria-label="放大"
                >
                  <ZoomIn size={13} />
                </button>
              </Tooltip>
              <Tooltip content="复位视图" side="bottom" sideOffset={4}>
                <button
                  type="button"
                  className="nb-ig-icon-btn"
                  style={{ padding: '2px 6px' }}
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                  aria-label="复位视图"
                >
                  <RotateCcw size={13} />
                </button>
              </Tooltip>
            </div>
          )}

          <ChartExportMenu
            action="copy"
            variant="outline"
            label="复制图片"
            source={exportSource}
            fileName={exportFileName}
          />

          <ChartExportMenu
            action="download"
            variant="primary"
            label="导出图片"
            source={exportSource}
            fileName={exportFileName}
          />
        </div>
      </div>

      {/* 主编辑与预览区域 */}
      <div
        ref={splitContainerRef}
        style={{
          flex: 1,
          display: 'flex',
          overflow: 'hidden',
          position: 'relative',
          userSelect: isResizing ? 'none' : 'auto',
        }}
      >
        {/* 左侧源码编辑区 */}
        <div
          ref={editorContainerRef}
          style={{
            display: layoutMode === 'preview' ? 'none' : 'block',
            width: layoutMode === 'split' ? `calc(${splitRatio * 100}% - 4px)` : '100%',
            height: '100%',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        />

        {/* 分栏可拖拽分隔条 */}
        {layoutMode === 'split' && (
          <Tooltip content="拖拽调节分栏比例，双击居中复位 (50%)" side="top" sideOffset={6}>
            <div
              onMouseDown={handleResizerMouseDown}
              onDoubleClick={() => setSplitRatio(0.5)}
              aria-label="拖拽调节分栏比例，双击居中复位 (50%)"
              style={{
                width: 8,
                height: '100%',
                cursor: 'col-resize',
                background: isResizing ? 'var(--editor-accent, #3b82f6)' : 'transparent',
                position: 'relative',
                flexShrink: 0,
                zIndex: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={(e) => {
                if (!isResizing) e.currentTarget.style.background = 'var(--toolbar-hover, rgba(59, 130, 246, 0.2))';
              }}
              onMouseLeave={(e) => {
                if (!isResizing) e.currentTarget.style.background = 'transparent';
              }}
            >
              <div
                style={{
                  width: 1,
                  height: '100%',
                  background: 'var(--editor-border, #e2e8f0)',
                }}
              />
            </div>
          </Tooltip>
        )}

        {/* 右侧实时渲染预览区 */}
        <div
          style={{
            display: layoutMode === 'code' ? 'none' : 'flex',
            width: layoutMode === 'split' ? `calc(${(1 - splitRatio) * 100}% - 4px)` : '100%',
            height: '100%',
            overflow: 'hidden',
            position: 'relative',
            background: 'var(--editor-bg, #ffffff)',
            flexDirection: 'column',
            cursor: isDragging ? 'grabbing' : 'grab',
            flexShrink: 0,
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
        >
          {error && (
            <div
              style={{
                position: 'absolute',
                top: 12,
                left: 12,
                right: 12,
                zIndex: 20,
                padding: '8px 14px',
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid #ef4444',
                borderRadius: 6,
                color: '#dc2626',
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{error}</span>
            </div>
          )}

          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
              transition: isDragging ? 'none' : 'transform 0.08s ease-out',
              userSelect: 'none',
              overflow: 'hidden',
            }}
          >
            {data ? (
              <div ref={setPreviewEl} style={{ width: CANVAS_BASE_WIDTH, maxWidth: '100%', padding: 16 }}>
                <InfographicRenderer data={data} />
              </div>
            ) : (
              <div style={{ color: 'var(--editor-text-muted, #94a3b8)', fontSize: 13, textAlign: 'center' }}>
                {error ? '信息图源码有误，请修正后查看' : '在左侧编写信息图源码即可实时预览'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
