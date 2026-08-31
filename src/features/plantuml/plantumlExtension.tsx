// NoteBoard PlantUML / UML TipTap 扩展
// 自研 plantumlBlock 节点 + 视口门控 + LRU 缓存 + 全屏放大模态框与图片导出
// 详见 docs/09-开发路线图.md

import { useState, useEffect, useRef, useCallback } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Maximize2, Edit2, X, AlertCircle } from 'lucide-react';
import { renderPlantUmlToSvg } from './plantumlEncoder';
import { observe } from '../editor-md/viewportActivation';
import { schedule } from '../editor-md/viewportWorkScheduler';
import { ChartExportMenu } from '../export/ChartExportMenu';
import { buildExportFileName, type ChartImageSource } from '../export/chartExport';

function PlantUmlComponent({ node, updateAttributes, selected }: NodeViewProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [inViewport, setInViewport] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);

  const containerRef = useRef<HTMLDivElement>(null);
  const renderTokenRef = useRef<number>(0);

  const code = node.attrs.code || '';

  const doRender = useCallback(async (currentCode: string) => {
    if (!currentCode.trim()) {
      setSvg(null);
      setError(null);
      return;
    }

    const token = ++renderTokenRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await renderPlantUmlToSvg(currentCode);
      if (token !== renderTokenRef.current) return;

      if (result.error && !result.svg) {
        setError(result.error);
        setSvg(null);
      } else {
        setSvg(result.svg);
        if (result.error) {
          setError(result.error);
        }
      }
    } catch (e) {
      if (token !== renderTokenRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (token === renderTokenRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // 视口门控
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const unobserve = observe(
      el,
      () => {
        setInViewport(true);
      },
      { once: true },
    );

    return unobserve;
  }, []);

  // 视口可见且有代码时调度渲染
  useEffect(() => {
    if (!inViewport || !code) return;
    schedule(() => doRender(code));
  }, [inViewport, code, doRender]);

  // 导出来源：渲染出 SVG 后复制/导出才可用
  const exportSource: ChartImageSource | null = svg ? { kind: 'svg', svg } : null;
  const exportFileName = buildExportFileName('', 'plantuml');

  if (editing) {
    return (
      <NodeViewWrapper as="div" style={{ display: 'block', margin: '12px 0' }}>
        <div
          style={{
            border: '1px solid var(--editor-accent, #3b82f6)',
            borderRadius: 'var(--radius-md, 8px)',
            background: 'var(--editor-surface, #ffffff)',
            overflow: 'hidden',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 12px',
              background: 'var(--editor-bg, #f8fafc)',
              borderBottom: '1px solid var(--editor-border, #e2e8f0)',
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--editor-text-muted, #64748b)',
            }}
          >
            <span>编辑 PlantUML / UML 图表</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={() => {
                  updateAttributes({ code: editValue });
                  setEditing(false);
                }}
                style={{
                  padding: '3px 10px',
                  borderRadius: 4,
                  background: 'var(--editor-accent, #3b82f6)',
                  color: '#ffffff',
                  border: 'none',
                  fontSize: 12,
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                完成
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                style={{
                  padding: '3px 8px',
                  borderRadius: 4,
                  background: 'transparent',
                  color: 'var(--editor-text-muted, #64748b)',
                  border: '1px solid var(--editor-border, #e2e8f0)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                取消
              </button>
            </div>
          </div>
          <textarea
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            placeholder="输入 PlantUML 语法，例如:&#10;@startuml&#10;Alice -> Bob: Hello&#10;@enduml"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                updateAttributes({ code: editValue });
                setEditing(false);
              }
            }}
            style={{
              width: '100%',
              minHeight: 140,
              padding: '10px 14px',
              fontFamily: 'var(--mono-font-family, monospace)',
              fontSize: 'var(--mono-font-size, 13px)',
              border: 'none',
              background: 'transparent',
              color: 'var(--editor-text, #1e293b)',
              resize: 'vertical',
              outline: 'none',
              lineHeight: 1.5,
            }}
          />
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="div" style={{ display: 'block', margin: '12px 0' }} selected={selected}>
      <div
        ref={containerRef}
        className="nb-diagram-container"
        style={{
          position: 'relative',
          minHeight: 60,
          border: '1px solid var(--editor-border, #e2e8f0)',
          borderRadius: 'var(--radius-md, 8px)',
          background: 'var(--editor-surface, #ffffff)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        contentEditable={false}
      >
        {/* 顶部轻量浮动操作栏 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 10px',
            borderBottom: '1px solid var(--editor-border, #e2e8f0)',
            background: 'var(--editor-bg, #f8fafc)',
            fontSize: 11,
            color: 'var(--editor-text-muted, #64748b)',
            userSelect: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600, color: 'var(--editor-accent, #3b82f6)' }}>PlantUML</span>
            {loading && <span>渲染中</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              onClick={() => {
                setEditValue(code);
                setEditing(true);
              }}
              title="编辑图表源码"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '3px 6px',
                borderRadius: 4,
                color: 'var(--editor-text-muted, #64748b)',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
              }}
            >
              <Edit2 size={12} />
              <span>编辑</span>
            </button>
            <ChartExportMenu
              action="copy"
              variant="ghost"
              source={exportSource}
              fileName={exportFileName}
            />
            <ChartExportMenu
              action="download"
              variant="ghost"
              source={exportSource}
              fileName={exportFileName}
            />
            {svg && (
              <button
                type="button"
                onClick={() => setFullscreen(true)}
                title="全屏放大查看"
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '3px 6px',
                  borderRadius: 4,
                  color: 'var(--editor-text-muted, #64748b)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                }}
              >
                <Maximize2 size={12} />
              </button>
            )}
          </div>
        </div>

        {/* 内容展示区 */}
        <div
          onDoubleClick={() => {
            setEditValue(code);
            setEditing(true);
          }}
          style={{
            padding: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'auto',
            cursor: 'pointer',
            minHeight: 80,
          }}
        >
          {!inViewport && code && (
            <div style={{ color: 'var(--editor-text-muted, #64748b)', fontSize: 13 }}>
              <span>📐 PlantUML 图表（滚动到视口时渲染）</span>
            </div>
          )}

          {inViewport && loading && !svg && (
            <div style={{ color: 'var(--editor-text-muted, #64748b)', fontSize: 13 }}>
              <span>正在获取 PlantUML 矢量图</span>
            </div>
          )}

          {error && (
            <div style={{ fontSize: 12, color: '#ef4444', textAlign: 'center', width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 8 }}>
                <AlertCircle size={15} />
                <span>{error}</span>
              </div>
              <pre
                style={{
                  padding: 8,
                  background: 'var(--editor-bg, #f1f5f9)',
                  borderRadius: 4,
                  overflow: 'auto',
                  fontSize: 11,
                  color: 'var(--editor-text-muted, #64748b)',
                  textAlign: 'left',
                }}
              >
                {code}
              </pre>
            </div>
          )}

          {svg && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                maxWidth: '100%',
                overflowX: 'auto',
              }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}

          {!code && (
            <span style={{ color: 'var(--editor-text-muted, #64748b)', fontStyle: 'italic', fontSize: 13 }}>
              空 PlantUML 图表（双击或点击编辑输入内容）
            </span>
          )}
        </div>
      </div>

      {/* 全屏模态弹窗 */}
      {fullscreen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            flexDirection: 'column',
          }}
          onClick={() => setFullscreen(false)}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 20px',
              background: 'var(--editor-surface, #ffffff)',
              borderBottom: '1px solid var(--editor-border, #e2e8f0)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <span style={{ fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>PlantUML 图表预览</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.max(0.2, z - 0.2))}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 4,
                    border: '1px solid var(--editor-border, #e2e8f0)',
                    background: 'var(--editor-bg, #f8fafc)',
                    cursor: 'pointer',
                  }}
                >
                  -
                </button>
                <span style={{ fontSize: 12, minWidth: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.min(3, z + 0.2))}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 4,
                    border: '1px solid var(--editor-border, #e2e8f0)',
                    background: 'var(--editor-bg, #f8fafc)',
                    cursor: 'pointer',
                  }}
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => setZoom(1)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: 4,
                    border: '1px solid var(--editor-border, #e2e8f0)',
                    background: 'var(--editor-bg, #f8fafc)',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  重置
                </button>
              </div>
              <ChartExportMenu
                action="copy"
                variant="outline"
                source={exportSource}
                fileName={exportFileName}
              />
              <ChartExportMenu
                action="download"
                variant="primary"
                source={exportSource}
                fileName={exportFileName}
              />
              <button
                type="button"
                onClick={() => setFullscreen(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 4,
                  color: 'var(--editor-text-muted, #64748b)',
                }}
              >
                <X size={20} />
              </button>
            </div>
          </div>
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 40,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {svg && (
              <div
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: 'center center',
                  transition: 'transform 0.15s ease',
                  background: 'var(--editor-surface, #ffffff)',
                  padding: 24,
                  borderRadius: 8,
                  boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
                }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

/** PlantUML 块级节点 */
export const PlantUmlBlock = Node.create({
  name: 'plantumlBlock',
  group: 'block',
  atom: true,
  selectable: true,
  isolating: true,
  addAttributes() {
    return {
      code: {
        default: '',
      },
    };
  },
  parseHTML() {
    return [
      { tag: 'div[data-plantuml]' },
      { tag: 'pre[data-language="plantuml"]' },
      { tag: 'pre[data-language="uml"]' },
      { tag: 'pre[data-language="puml"]' },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-plantuml': '' })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(PlantUmlComponent);
  },
  addCommands() {
    return {
      insertPlantUml:
        (code: string) =>
        ({ commands }: { commands: { insertContent: (content: unknown) => boolean } }) => {
          return commands.insertContent({
            type: 'plantumlBlock',
            attrs: { code },
          });
        },
    } as never;
  },
});
