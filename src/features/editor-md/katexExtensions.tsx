// NoteBoard KaTeX 数学公式扩展
// 自研 mathInline / mathBlock 节点 + ReactNodeViewRenderer + 懒加载 + LRU 200 + 视口门控
// 详见 docs/09-开发路线图.md 8.3/8.4
//
// 设计：
// 1. mathInline: atom: true, inline 行内公式 $E=mc^2$
// 2. mathBlock: block 级块公式 $$...$$
// 3. import('katex') 懒加载
// 4. throwOnError: false, trust: false
// 5. LRU 缓存 200 条
// 6. 渲染失败显示原文 + 错误

import { useState, useEffect, useRef, useCallback } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

// ── LRU 缓存 ──

class LRUCache<K, V> {
  private capacity: number;
  private map: Map<K, V>;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // 移到最后（最近使用）
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // 淘汰最老的
    const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }
}

/** KaTeX 渲染结果缓存（LRU 200） */
const renderCache = new LRUCache<string, { html: string; error?: string }>(200);

/** KaTeX 模块延迟加载 */
let katexModule: typeof import('katex') | null = null;
let katexLoading: Promise<typeof import('katex')> | null = null;

async function loadKatex(): Promise<typeof import('katex')> {
  if (katexModule) return katexModule;
  if (katexLoading) return katexLoading;

  katexLoading = import('katex').then((mod) => {
    katexModule = mod;
    return mod;
  });
  return katexLoading;
}

/** 渲染 LaTeX 为 HTML */
async function renderLatex(latex: string, displayMode: boolean): Promise<{ html: string; error?: string }> {
  // 检查缓存
  const cacheKey = `${displayMode ? 'block' : 'inline'}:${latex}`;
  const cached = renderCache.get(cacheKey);
  if (cached) return cached;

  try {
    const katex = await loadKatex();
    const html = katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      trust: false,
      strict: false,
    });

    // 检查是否有错误（Katex 在 throwOnError=false 时会输出错误 HTML）
    const hasError = html.includes('katex-error') || html.includes('ParseError');
    const result = { html, error: hasError ? '公式语法错误' : undefined };
    renderCache.set(cacheKey, result);
    return result;
  } catch (e) {
    const result = { html: escapeHtml(latex), error: String(e) };
    renderCache.set(cacheKey, result);
    return result;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── React NodeView ──

function MathComponent({ node, updateAttributes, selected }: NodeViewProps) {
  const [rendered, setRendered] = useState<{ html: string; error?: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isBlock = node.type.name === 'mathBlock';
  const latex = node.attrs.latex || '';

  const doRender = useCallback(async () => {
    if (!latex) {
      setRendered(null);
      return;
    }
    const result = await renderLatex(latex, isBlock);
    setRendered(result);
  }, [latex, isBlock]);

  useEffect(() => {
    doRender();
  }, [doRender]);

  // 编辑模式
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  if (editing) {
    return (
      <NodeViewWrapper as={isBlock ? 'div' : 'span'} style={{ display: isBlock ? 'block' : 'inline-block' }}>
        <textarea
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={() => {
            updateAttributes({ latex: editValue });
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
            if (e.key === 'Enter' && !isBlock && !e.shiftKey) {
              e.preventDefault();
              updateAttributes({ latex: editValue });
              setEditing(false);
            }
          }}
          style={{
            width: '100%',
            minHeight: isBlock ? 80 : 32,
            padding: '4px 8px',
            fontFamily: 'var(--mono-font-family)',
            fontSize: 'var(--mono-font-size)',
            border: '1px solid var(--editor-accent)',
            borderRadius: 'var(--radius-sm)',
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
    <NodeViewWrapper
      as={isBlock ? 'div' : 'span'}
      selected={selected}
      style={{
        display: isBlock ? 'block' : 'inline-block',
        cursor: 'pointer',
        borderRadius: 'var(--radius-sm)',
        padding: isBlock ? '8px 0' : '0 2px',
        minHeight: isBlock ? 40 : 'auto',
        background: selected ? 'var(--editor-selection-background)' : 'transparent',
      }}
      contentEditable={false}
      onDoubleClick={() => {
        setEditValue(latex);
        setEditing(true);
      }}
    >
      {rendered ? (
        <>
          {rendered.error && (
            <span
              style={{
                fontSize: 12,
                color: 'var(--error-500)',
                marginRight: 4,
              }}
            >
              ⚠ {rendered.error}:
            </span>
          )}
          <span dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </>
      ) : (
        <span style={{ color: 'var(--editor-text-muted)', fontStyle: 'italic' }}>
          {latex || '空公式（双击编辑）'}
        </span>
      )}
    </NodeViewWrapper>
  );
}

// ── TipTap 节点定义 ──

/** 行内数学公式 $...$ */
export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      latex: {
        default: '',
      },
    };
  },
  parseHTML() {
    return [
      { tag: 'span[data-math-inline]' },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-math-inline': '' })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MathComponent);
  },
  addCommands() {
    return {
      insertMathInline:
        (latex: string) =>
        ({ commands }: { commands: { insertContent: (content: unknown) => boolean } }) => {
          return commands.insertContent({
            type: 'mathInline',
            attrs: { latex },
          });
        },
    } as never;
  },
});

/** 块级数学公式 $$...$$ */
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      latex: {
        default: '',
      },
    };
  },
  parseHTML() {
    return [
      { tag: 'div[data-math-block]' },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-math-block': '' })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MathComponent);
  },
  addCommands() {
    return {
      insertMathBlock:
        (latex: string) =>
        ({ commands }: { commands: { insertContent: (content: unknown) => boolean } }) => {
          return commands.insertContent({
            type: 'mathBlock',
            attrs: { latex },
          });
        },
    } as never;
  },
});

/** 清除 KaTeX 缓存 */
export function clearKatexCache(): void {
  renderCache.clear();
}
