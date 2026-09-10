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
import { Node, mergeAttributes, type MarkdownToken, type MarkdownTokenizer } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
// KaTeX 生成的 HTML 依赖官方字体与布局样式；随 Markdown 编辑器分包加载，避免首屏额外开销。
import 'katex/dist/katex.min.css';
import { observe } from './viewportActivation';
import { cancelTask, scheduleTask } from './viewportWorkScheduler';

// ── Markdown 公式语法 ──

/** 数学 tokenizer 附加在 marked token 上的 LaTeX 原文。 */
type MathMarkdownToken = MarkdownToken & { latex?: string };

/** 判断指定美元符号是否被奇数个反斜杠转义。 */
function isEscapedDollar(source: string, index: number): boolean {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

/**
 * 查找下一个合法的行内公式起点。
 * 单美元符号后不能是空白或另一个美元符号，避免与块公式和普通金额文本争抢。
 */
function findInlineMathStart(source: string): number {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '$' || isEscapedDollar(source, index)) continue;
    const next = source[index + 1];
    if (!next || next === '$' || source[index - 1] === '$' || /\s/.test(next)) continue;
    return index;
  }
  return -1;
}

/** 行内 `$...$` tokenizer：不跨行，并跳过转义或不满足边界约束的美元符号。 */
const inlineMathTokenizer: MarkdownTokenizer = {
  name: 'mathInline',
  level: 'inline',
  start: findInlineMathStart,
  tokenize(source) {
    if (findInlineMathStart(source) !== 0) return undefined;

    for (let index = 1; index < source.length; index += 1) {
      const character = source[index];
      if (character === '\n' || character === '\r') return undefined;
      // 不跨越行内代码边界寻找闭合符，否则金额后的代码 `$HOME` 会被拼成一条伪公式。
      if (character === '`' && source[index - 1] !== '\\') return undefined;
      if (character !== '$' || isEscapedDollar(source, index)) continue;
      // 双美元符号属于块公式；闭合符前不能是空白，后接数字时按金额文本处理。
      if (source[index - 1] === '$' || source[index + 1] === '$' || /\s/.test(source[index - 1])) continue;
      if (/\d/.test(source[index + 1] ?? '')) continue;

      const latex = source.slice(1, index);
      return {
        type: 'mathInline',
        raw: source.slice(0, index + 1),
        latex,
      };
    }
    return undefined;
  },
};

/** 查找独占一行或单行闭合的 `$$...$$` 块公式起点。 */
function findBlockMathStart(source: string): number {
  const match = /^ {0,3}\$\$(?=[ \t]*(?:\r?\n|[^\r\n]*\$\$[ \t]*(?:\r?\n|$)))/m.exec(source);
  return match?.index ?? -1;
}

/** 块级 `$$...$$` tokenizer：同时支持标准多行形式与单行形式。 */
const blockMathTokenizer: MarkdownTokenizer = {
  name: 'mathBlock',
  level: 'block',
  start: findBlockMathStart,
  tokenize(source) {
    const multiline = /^ {0,3}\$\$[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\$\$[ \t]*(?:\r?\n|$)/.exec(source);
    if (multiline) {
      return {
        type: 'mathBlock',
        raw: multiline[0],
        latex: multiline[1],
      };
    }

    const singleLine = /^ {0,3}\$\$[ \t]*([^\r\n]*?)[ \t]*\$\$[ \t]*(?:\r?\n|$)/.exec(source);
    if (!singleLine) return undefined;
    return {
      type: 'mathBlock',
      raw: singleLine[0],
      latex: singleLine[1],
    };
  },
};

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

/** 数学节点任务序号：为每个 NodeView 分配稳定身份，防止同帧任务互相覆盖。 */
let nextMathRenderTaskId = 0;

function MathComponent({ node, updateAttributes, selected }: NodeViewProps) {
  const [rendered, setRendered] = useState<{ html: string; error?: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [inViewport, setInViewport] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef<HTMLSpanElement>(null);
  const renderTokenRef = useRef(0);
  const taskIdentityRef = useRef<string | null>(null);
  if (taskIdentityRef.current === null) {
    taskIdentityRef.current = `math:${(nextMathRenderTaskId += 1)}`;
  }
  const isBlock = node.type.name === 'mathBlock';
  const latex = node.attrs.latex || '';

  const doRender = useCallback(async () => {
    const renderToken = ++renderTokenRef.current;
    if (!latex) {
      setRendered(null);
      return;
    }
    const result = await renderLatex(latex, isBlock);
    // 节点在异步加载期间被编辑或卸载时，旧结果不得覆盖新公式或触发卸载后更新。
    if (renderToken === renderTokenRef.current) setRendered(result);
  }, [latex, isBlock]);

  // 仅激活首屏及上下 800px 范围内的公式；屏外节点保留轻量原文占位。
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    return observe(element, () => setInViewport(true), { once: true });
  }, []);

  // 同一帧出现多个公式时按 8ms 时间片分批启动 KaTeX，避免集中阻塞输入与滚动。
  useEffect(() => {
    if (!inViewport) return;
    const identity = taskIdentityRef.current!;
    scheduleTask(identity, () => {
      void doRender();
    });
    return () => {
      cancelTask(identity);
      renderTokenRef.current += 1;
    };
  }, [inViewport, doRender]);

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
        <span ref={viewportRef} style={{ color: 'var(--editor-text-muted)', fontStyle: 'italic' }}>
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
  renderText({ node }) {
    // 剪贴板、搜索辅助文本等纯文本通道必须保留 Markdown 分隔符，不能丢失原子节点。
    return `$${String(node.attrs.latex ?? '')}$`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(MathComponent);
  },
  markdownTokenName: 'mathInline',
  markdownTokenizer: inlineMathTokenizer,
  parseMarkdown(token, helpers) {
    // tokenizer 已保存不含分隔符的原始 LaTeX，节点属性直接承载，禁止再次解释反斜杠。
    return helpers.createNode('mathInline', {
      latex: (token as MathMarkdownToken).latex ?? '',
    });
  },
  renderMarkdown(node) {
    return `$${String(node.attrs?.latex ?? '')}$`;
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
  renderText({ node }) {
    // 块公式复制为标准多行 Markdown，粘贴回源码或其他编辑器后仍可识别。
    return `$$\n${String(node.attrs.latex ?? '')}\n$$`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(MathComponent);
  },
  markdownTokenName: 'mathBlock',
  markdownTokenizer: blockMathTokenizer,
  parseMarkdown(token, helpers) {
    // 块公式同样保留 LaTeX 原文，确保 \frac、\sum 等命令在模式往返后不丢反斜杠。
    return helpers.createNode('mathBlock', {
      latex: (token as MathMarkdownToken).latex ?? '',
    });
  },
  renderMarkdown(node) {
    return `$$\n${String(node.attrs?.latex ?? '')}\n$$`;
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
