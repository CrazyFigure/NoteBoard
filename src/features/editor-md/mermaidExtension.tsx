// NoteBoard Mermaid 图表扩展
// 自研节点 + 懒加载 + securityLevel: strict + 全局串行渲染队列 + 陈旧守卫 + 视口门控
// 详见 docs/09-开发路线图.md 8.5
//
// 设计：
// 1. 自研 mermaidBlock 节点
// 2. import('mermaid') 懒加载
// 3. securityLevel: 'strict', startOnLoad: false
// 4. 全局串行渲染队列（避免并发污染）
// 5. 陈旧守卫：渲染完成后检查内容是否已变
// 6. Skeleton 占位
// 7. 主题切换时重渲染

import { useState, useEffect, useRef, useCallback } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { observe } from './viewportActivation';
import { schedule } from './viewportWorkScheduler';

// ── 全局串行渲染队列 ──

type RenderTask = {
  id: number;
  code: string;
  theme: 'default' | 'dark' | 'forest';
  resolve: (svg: string) => void;
  reject: (error: Error) => void;
};

const renderQueue: RenderTask[] = [];
let isProcessing = false;
let nextId = 0;

/** Mermaid 模块延迟加载 */
let mermaidModule: typeof import('mermaid') | null = null;
let mermaidLoading: Promise<typeof import('mermaid')> | null = null;

async function loadMermaid(): Promise<typeof import('mermaid')> {
  if (mermaidModule) return mermaidModule;
  if (mermaidLoading) return mermaidLoading;

  mermaidLoading = import('mermaid').then((mod) => {
    mermaidModule = mod;
    // 初始化
    mod.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
    });
    return mod;
  });
  return mermaidLoading;
}

/** 处理队列中的下一个任务 */
async function processQueue(): Promise<void> {
  if (isProcessing) return;
  const task = renderQueue.shift();
  if (!task) return;

  isProcessing = true;

  try {
    const mermaid = await loadMermaid();

    // 设置主题
    if (task.theme === 'dark') {
      mermaid.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
    } else if (task.theme === 'forest') {
      mermaid.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'forest' });
    } else {
      mermaid.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
    }

    // 渲染
    const renderId = `mermaid-${task.id}`;
    const { svg } = await mermaid.default.render(renderId, task.code);
    task.resolve(svg);
  } catch (e) {
    task.reject(e instanceof Error ? e : new Error(String(e)));
  } finally {
    isProcessing = false;
    // 继续处理下一个
    if (renderQueue.length > 0) {
      processQueue();
    }
  }
}

/**
 * 提交 Mermaid 渲染任务到串行队列
 */
function enqueueRender(code: string, theme: 'default' | 'dark' | 'forest'): Promise<string> {
  return new Promise((resolve, reject) => {
    const task: RenderTask = {
      id: nextId++,
      code,
      theme,
      resolve,
      reject,
    };
    renderQueue.push(task);
    processQueue();
  });
}

// ── 获取当前主题 ──

function getCurrentMermaidTheme(): 'default' | 'dark' | 'forest' {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return isDark ? 'dark' : 'default';
}

import { Maximize2, Edit2, X, AlertCircle } from 'lucide-react';
import { ChartExportMenu } from '../export/ChartExportMenu';
import { buildExportFileName, type ChartImageSource } from '../export/chartExport';

// ── React NodeView ──

function MermaidComponent({ node, updateAttributes, selected }: NodeViewProps) {
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
      const result = await enqueueRender(currentCode, getCurrentMermaidTheme());
      // 陈旧守卫：检查内容是否已变
      if (token !== renderTokenRef.current) return;
      setSvg(result);
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

    const unobserve = observe(el, () => {
      setInViewport(true);
    }, { once: true });

    return unobserve;
  }, []);

  // 只在视口内时渲染
  useEffect(() => {
    if (!inViewport || !code) return;
    schedule(() => doRender(code));
  }, [inViewport, code, doRender]);

  // 主题切换时重渲染
  useEffect(() => {
    if (!inViewport || !code) return;
    const observer = new MutationObserver(() => {
      schedule(() => doRender(code));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [inViewport, code, doRender]);

  // 导出来源：渲染出 SVG 后复制/导出才可用
  const exportSource: ChartImageSource | null = svg ? { kind: 'svg', svg } : null;
  const exportFileName = buildExportFileName('', 'mermaid');

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
            <span>编辑 Mermaid 图表源码</span>
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
            placeholder="输入 Mermaid 语法，例如:&#10;graph TD&#10;    A[开始] --> B[结束]"
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
            <span style={{ fontWeight: 600, color: 'var(--editor-accent, #3b82f6)' }}>Mermaid</span>
            {loading && <span>渲染中…</span>}
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
              <span>📊 Mermaid 图表（滚动到视口时渲染）</span>
            </div>
          )}

          {inViewport && loading && !svg && (
            <div style={{ color: 'var(--editor-text-muted, #64748b)', fontSize: 13 }}>
              <span>渲染中…</span>
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
              空 Mermaid 图表（双击或点击编辑输入内容）
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
            <span style={{ fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>Mermaid 图表预览</span>
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

// ── TipTap 节点定义 ──

/** Mermaid 块节点 */
export const MermaidBlock = Node.create({
  name: 'mermaidBlock',
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
      { tag: 'div[data-mermaid]' },
      { tag: 'pre[data-language="mermaid"]' },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-mermaid': '' })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MermaidComponent);
  },
  addCommands() {
    return {
      insertMermaid:
        (code: string) =>
        ({ commands }: { commands: { insertContent: (content: unknown) => boolean } }) => {
          return commands.insertContent({
            type: 'mermaidBlock',
            attrs: { code },
          });
        },
    } as never;
  },
});

/** 清除 Mermaid 模块（主题切换时重置初始化） */
export function resetMermaid(): void {
  mermaidModule = null;
  mermaidLoading = null;
  renderQueue.length = 0;
  isProcessing = false;
}
