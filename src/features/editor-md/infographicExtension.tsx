// NoteBoard Infographic TipTap 扩展
// 自研 infographicBlock 节点 + 视口门控 + 就地编辑 + 模板选择 + 全屏缩放预览与导出

import { useState, useEffect, useRef, useCallback } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import {
  Maximize2,
  Copy,
  Download,
  Check,
  Edit2,
  X,
  AlertCircle,
  Sparkles,
  ChevronDown,
} from 'lucide-react';
import { parseInfographicCode } from '../infographic/infographicParser';
import { InfographicRenderer } from '../infographic/infographicRenderer';
import { INFOGRAPHIC_TEMPLATES } from '../infographic/infographicTemplates';
import { observe } from './viewportActivation';
import { schedule } from './viewportWorkScheduler';

function InfographicComponent({ node, updateAttributes, selected }: NodeViewProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [showTemplateDropdown, setShowTemplateDropdown] = useState(false);
  const [inViewport, setInViewport] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [zoom, setZoom] = useState(1);

  const containerRef = useRef<HTMLDivElement>(null);
  const code = node.attrs.code || '';

  // 解析当前代码
  const { data, error } = parseInfographicCode(code);

  // 视口门控优化
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

  // 复制源码
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // 导出为 HTML / 文本文件
  const handleExport = (e: React.MouseEvent) => {
    e.stopPropagation();
    const blob = new Blob([code], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `infographic-${Date.now()}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (editing) {
    return (
      <NodeViewWrapper as="div" style={{ display: 'block', margin: '14px 0' }}>
        <div
          style={{
            border: '1px solid var(--editor-accent, #3b82f6)',
            borderRadius: 'var(--radius-md, 8px)',
            background: 'var(--editor-surface, #ffffff)',
            overflow: 'visible',
            boxShadow: '0 6px 16px rgba(0, 0, 0, 0.08)',
            position: 'relative',
          }}
        >
          {/* 编辑态顶部工具栏 */}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>
                编辑 Infographic 信息图源码 (YAML / JSON)
              </span>

              {/* 预设模板快速填充下拉 */}
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setShowTemplateDropdown(!showTemplateDropdown)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    borderRadius: 4,
                    border: '1px solid var(--editor-border, #cbd5e1)',
                    background: 'var(--editor-surface, #ffffff)',
                    color: 'var(--editor-accent, #3b82f6)',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  <Sparkles size={12} />
                  <span>载入预设模板</span>
                  <ChevronDown size={11} />
                </button>

                {showTemplateDropdown && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      marginTop: 4,
                      background: 'var(--editor-surface, #ffffff)',
                      border: '1px solid var(--editor-border, #e2e8f0)',
                      borderRadius: 6,
                      boxShadow: '0 8px 20px rgba(0,0,0,0.12)',
                      zIndex: 10000,
                      width: 220,
                      overflow: 'hidden',
                    }}
                  >
                    {INFOGRAPHIC_TEMPLATES.map((tmpl) => (
                      <button
                        key={tmpl.id}
                        type="button"
                        onClick={() => {
                          setEditValue(tmpl.code);
                          setShowTemplateDropdown(false);
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '6px 10px',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          fontSize: 11,
                          color: 'var(--editor-text, #1e293b)',
                          borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>{tmpl.label}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

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
            placeholder="输入 Infographic 结构化配置 (YAML 或 JSON)..."
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
              minHeight: 180,
              padding: '12px 14px',
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
    <NodeViewWrapper as="div" style={{ display: 'block', margin: '14px 0' }} selected={selected}>
      <div
        ref={containerRef}
        className="nb-infographic-container"
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
        {/* 顶部操作条 */}
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
            <span style={{ fontWeight: 600, color: 'var(--editor-accent, #3b82f6)' }}>
              Infographic 信息图
            </span>
            {data?.type && (
              <span
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'rgba(59, 130, 246, 0.1)',
                  color: '#2563eb',
                }}
              >
                {data.type}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              onClick={() => {
                setEditValue(code);
                setEditing(true);
              }}
              title="编辑信息图源码"
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
            <button
              type="button"
              onClick={handleCopy}
              title="复制配置源码"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '3px 6px',
                borderRadius: 4,
                color: copied ? '#16a34a' : 'var(--editor-text-muted, #64748b)',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
              }}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
            <button
              type="button"
              onClick={handleExport}
              title="导出信息图配置"
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
              <Download size={12} />
              <span>导出</span>
            </button>
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
          </div>
        </div>

        {/* 内容展示区 */}
        <div
          onDoubleClick={() => {
            setEditValue(code);
            setEditing(true);
          }}
          style={{
            padding: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'auto',
            minHeight: 80,
          }}
        >
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

          {!error && data && <InfographicRenderer data={data} />}

          {!code && (
            <span style={{ color: 'var(--editor-text-muted, #64748b)', fontStyle: 'italic', fontSize: 13 }}>
              空信息图（双击或点击编辑输入结构化内容）
            </span>
          )}
        </div>
      </div>

      {/* 全屏放大模态框 */}
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
            <span style={{ fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>
              Infographic 信息图预览
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
            {data && (
              <div
                style={{
                  maxWidth: 900,
                  width: '100%',
                  background: 'var(--editor-surface, #ffffff)',
                  borderRadius: 12,
                  padding: 24,
                  boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
                }}
              >
                <InfographicRenderer data={data} />
              </div>
            )}
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

/** Infographic 块节点定义 */
export const InfographicBlock = Node.create({
  name: 'infographicBlock',
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
      { tag: 'div[data-infographic]' },
      { tag: 'pre[data-language="infographic"]' },
      { tag: 'pre[data-language="info"]' },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-infographic': '' })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(InfographicComponent);
  },
  addCommands() {
    return {
      insertInfographic:
        (code: string) =>
        ({ commands }: { commands: { insertContent: (content: unknown) => boolean } }) => {
          return commands.insertContent({
            type: 'infographicBlock',
            attrs: { code },
          });
        },
    } as never;
  },
});
