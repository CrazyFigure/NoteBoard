// NoteBoard 图表双栏编辑器 (Mermaid / PlantUML / UML)
// 左侧代码编辑 + 右侧实时渲染预览 + 缩放平移 + SVG/PNG 导出
// 详见 docs/09-开发路线图.md

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import { defaultKeymap, historyKeymap, history } from '@codemirror/commands';
import {
  Columns,
  Code2,
  Eye,
  Download,
  Copy,
  Check,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  AlertCircle,
  FileCode,
} from 'lucide-react';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { renderPlantUmlToSvg } from '../plantuml/plantumlEncoder';
import { extFromPath } from '../../core/docKind';

interface DiagramSplitEditorProps {
  docKey: string;
}

type LayoutMode = 'split' | 'code' | 'preview';

/** Mermaid 模块延迟加载 */
let mermaidModule: typeof import('mermaid') | null = null;
async function loadMermaid(): Promise<typeof import('mermaid')> {
  if (mermaidModule) return mermaidModule;
  const mod = await import('mermaid');
  mermaidModule = mod;
  mod.default.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default',
  });
  return mod;
}

export function DiagramSplitEditor({ docKey }: DiagramSplitEditorProps) {
  const doc = useDocumentStore((s) => s.documents.get(docKey));
  const setContent = useDocumentStore((s) => s.setContent);
  const setDirty = useDocumentStore((s) => s.setDirty);
  const setTabDirty = useWindowStore((s) => s.setTabDirty);

  const [layoutMode, setLayoutMode] = useState<LayoutMode>('split');
  const [splitRatio, setSplitRatio] = useState<number>(0.5);
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const [svgContent, setSvgContent] = useState<string>('');
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [copied, setCopied] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const renderTokenRef = useRef(0);

  // 判断图表类型（Mermaid 或 PlantUML，优先依据 language 和 displayName）
  const diagramType = useMemo<'mermaid' | 'plantuml'>(() => {
    if (doc?.language === 'mermaid') return 'mermaid';
    if (doc?.language === 'plantuml') return 'plantuml';
    const target = doc?.displayName || doc?.key || docKey;
    const ext = extFromPath(target);
    if (ext === 'mmd' || ext === 'mermaid') return 'mermaid';
    return 'plantuml';
  }, [doc?.language, doc?.displayName, doc?.key, docKey]);

  // 处理分隔条鼠标拖拽调整左右分栏比例
  const handleResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const newRatio = (moveEvent.clientX - rect.left) / rect.width;
      const clampedRatio = Math.max(0.18, Math.min(0.82, newRatio));
      setSplitRatio(clampedRatio);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // 渲染图表
  const renderDiagram = useCallback(
    async (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) {
        setSvgContent('');
        setRenderError(null);
        return;
      }

      const token = ++renderTokenRef.current;
      setIsRendering(true);
      setRenderError(null);

      try {
        if (diagramType === 'mermaid') {
          const mermaid = await loadMermaid();
          const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
          mermaid.default.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: isDark ? 'dark' : 'default',
          });
          const renderId = `diag-render-${Date.now()}`;
          const { svg } = await mermaid.default.render(renderId, trimmed);
          if (token === renderTokenRef.current) {
            setSvgContent(svg);
          }
        } else {
          // PlantUML
          const result = await renderPlantUmlToSvg(trimmed);
          if (token === renderTokenRef.current) {
            if (result.error && !result.svg) {
              setRenderError(result.error);
              setSvgContent('');
            } else {
              setSvgContent(result.svg);
              if (result.error) setRenderError(result.error);
            }
          }
        }
      } catch (err) {
        if (token === renderTokenRef.current) {
          setRenderError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (token === renderTokenRef.current) {
          setIsRendering(false);
        }
      }
    },
    [diagramType],
  );

  // 初始化 CodeMirror 6 编辑器
  useEffect(() => {
    if (!editorContainerRef.current) return;
    if (editorViewRef.current) {
      editorViewRef.current.destroy();
    }

    const initialContent = doc?.content ?? '';

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) {
            const newText = update.state.doc.toString();
            setContent(docKey, newText);
            setDirty(docKey, true);
            setTabDirty(docKey, true);
            renderDiagram(newText);
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
    renderDiagram(initialContent);

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
  }, [docKey]);

  // 当 layoutMode 或 splitRatio 改变时，通知 CodeMirror 立即重新测量布局尺寸
  useEffect(() => {
    if (layoutMode !== 'preview' && editorViewRef.current) {
      editorViewRef.current.requestMeasure();
    }
  }, [layoutMode, splitRatio]);

  // 复制 SVG 矢量
  const handleCopySvg = () => {
    if (!svgContent) return;
    navigator.clipboard.writeText(svgContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // 导出 SVG 文件
  const handleExportSvg = () => {
    if (!svgContent) return;
    const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${diagramType}-${Date.now()}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 画布鼠标拖拽平移
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // 画布鼠标滚轮缩放
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      setZoom((z) => Math.max(0.2, Math.min(4, z + delta)));
    }
  };

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
        {/* 左侧：格式标识与布局切换 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <FileCode size={16} color="var(--editor-accent, #3b82f6)" />
            <span>{diagramType === 'mermaid' ? 'Mermaid 图表' : 'PlantUML / UML'}</span>
            {isRendering && <span style={{ fontSize: 11, color: 'var(--editor-text-muted)', fontWeight: 400 }}>渲染中…</span>}
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
            <button
              type="button"
              onClick={() => setLayoutMode('split')}
              title="双栏分屏"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: layoutMode === 'split' ? 600 : 400,
                background: layoutMode === 'split' ? 'var(--toolbar-active, rgba(59, 130, 246, 0.12))' : 'transparent',
                color: layoutMode === 'split' ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-muted, #64748b)',
              }}
            >
              <Columns size={13} />
              <span>分屏</span>
            </button>
            <button
              type="button"
              onClick={() => setLayoutMode('code')}
              title="仅源码"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: layoutMode === 'code' ? 600 : 400,
                background: layoutMode === 'code' ? 'var(--toolbar-active, rgba(59, 130, 246, 0.12))' : 'transparent',
                color: layoutMode === 'code' ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-muted, #64748b)',
              }}
            >
              <Code2 size={13} />
              <span>源码</span>
            </button>
            <button
              type="button"
              onClick={() => setLayoutMode('preview')}
              title="仅预览"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: layoutMode === 'preview' ? 600 : 400,
                background: layoutMode === 'preview' ? 'var(--toolbar-active, rgba(59, 130, 246, 0.12))' : 'transparent',
                color: layoutMode === 'preview' ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-muted, #64748b)',
              }}
            >
              <Eye size={13} />
              <span>预览</span>
            </button>
          </div>
        </div>

        {/* 右侧：缩放控制与导出 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {layoutMode !== 'code' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 8 }}>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.2, z - 0.15))}
                title="缩小"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--editor-border)',
                  borderRadius: 4,
                  padding: '2px 6px',
                  cursor: 'pointer',
                }}
              >
                <ZoomOut size={13} />
              </button>
              <span style={{ fontSize: 11, minWidth: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(4, z + 0.15))}
                title="放大"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--editor-border)',
                  borderRadius: 4,
                  padding: '2px 6px',
                  cursor: 'pointer',
                }}
              >
                <ZoomIn size={13} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
                title="复位视图"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--editor-border)',
                  borderRadius: 4,
                  padding: '2px 6px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <RotateCcw size={13} />
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={handleCopySvg}
            title="复制 SVG 代码"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              border: '1px solid var(--editor-border, #e2e8f0)',
              borderRadius: 5,
              background: 'var(--editor-bg, #ffffff)',
              cursor: 'pointer',
              fontSize: 12,
              color: copied ? 'var(--success-600, #16a34a)' : 'var(--editor-text, #1e293b)',
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span>{copied ? '已复制' : '复制 SVG'}</span>
          </button>

          <button
            type="button"
            onClick={handleExportSvg}
            title="导出 SVG 文件"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 10px',
              border: 'none',
              borderRadius: 5,
              background: 'var(--editor-accent, #3b82f6)',
              color: '#ffffff',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <Download size={13} />
            <span>导出 SVG</span>
          </button>
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
        {/* 左侧代码编辑区（常驻 DOM，切换模式不销毁） */}
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

        {/* 分栏可拖拽分隔条 (Sash) */}
        {layoutMode === 'split' && (
          <div
            onMouseDown={handleResizerMouseDown}
            onDoubleClick={() => setSplitRatio(0.5)}
            title="拖拽调节分栏比例，双击居中复位 (50%)"
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
        )}

        {/* 右侧实时渲染预览区（常驻 DOM） */}
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
            {/* 错误提示条 */}
            {renderError && (
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
                <span>{renderError}</span>
              </div>
            )}

            {/* 图表画布 */}
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
              }}
            >
              {svgContent ? (
                <div
                  style={{
                    maxWidth: '90%',
                    maxHeight: '90%',
                    padding: 24,
                    background: 'var(--editor-surface, #ffffff)',
                    borderRadius: 8,
                    boxShadow: '0 4px 20px rgba(0,0,0,0.06)',
                  }}
                  dangerouslySetInnerHTML={{ __html: svgContent }}
                />
              ) : (
                <div style={{ color: 'var(--editor-text-muted, #94a3b8)', fontSize: 13, textAlign: 'center' }}>
                  {renderError ? '图表语法有误，请修正代码' : '输入图表代码即可在右侧实时预览'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
