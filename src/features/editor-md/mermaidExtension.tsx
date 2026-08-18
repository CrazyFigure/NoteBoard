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

// ── React NodeView ──

function MermaidComponent({ node, updateAttributes, selected }: NodeViewProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [inViewport, setInViewport] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderTokenRef = useRef<number>(0);

  const code = node.attrs.code || '';

  const doRender = useCallback(async (currentCode: string) => {
    if (!currentCode) {
      setSvg(null);
      return;
    }

    const token = ++renderTokenRef.current;
    setError(null);

    try {
      const result = await enqueueRender(currentCode, getCurrentMermaidTheme());
      // 陈旧守卫：检查内容是否已变
      if (token !== renderTokenRef.current) return;
      setSvg(result);
    } catch (e) {
      if (token !== renderTokenRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
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

  if (editing) {
    return (
      <NodeViewWrapper as="div" style={{ display: 'block', margin: '8px 0' }}>
        <textarea
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={() => {
            updateAttributes({ code: editValue });
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
          style={{
            width: '100%',
            minHeight: 120,
            padding: '8px 12px',
            fontFamily: 'var(--mono-font-family)',
            fontSize: 'var(--mono-font-size)',
            border: '1px solid var(--editor-accent)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--editor-surface)',
            color: 'var(--editor-text)',
            resize: 'vertical',
            outline: 'none',
          }}
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="div" style={{ display: 'block', margin: '8px 0' }} selected={selected}>
      <div
        ref={containerRef}
        onDoubleClick={() => {
          setEditValue(code);
          setEditing(true);
        }}
        style={{
          minHeight: 60,
          padding: '12px',
          border: '1px solid var(--editor-border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--editor-surface)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'auto',
        }}
        contentEditable={false}
      >
        {!inViewport && code && (
          <div style={{ color: 'var(--editor-text-muted)', fontSize: 13 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>📊</span>
              <span>Mermaid 图表（滚动到视口时渲染）</span>
            </div>
          </div>
        )}
        {inViewport && !svg && !error && code && (
          <div style={{ color: 'var(--editor-text-muted)', fontSize: 13 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>渲染中…</span>
            </div>
          </div>
        )}
        {error && (
          <div style={{ fontSize: 12, color: 'var(--error-500)' }}>
            <div>⚠ 渲染失败: {error}</div>
            <pre style={{ marginTop: 8, padding: 8, background: 'var(--cm-gutter-background)', borderRadius: 4, overflow: 'auto', fontSize: 11, color: 'var(--editor-text-muted)' }}>{code}</pre>
          </div>
        )}
        {svg && (
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        )}
        {!code && (
          <span style={{ color: 'var(--editor-text-muted)', fontStyle: 'italic' }}>
            空图表（双击编辑）
          </span>
        )}
      </div>
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
