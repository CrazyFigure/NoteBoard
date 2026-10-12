// NoteBoard 可视化代码块语法高亮插件
// 基于 ProseMirror Decoration 着色，不改写代码块 DOM，编辑/光标/撤销均不受影响。
// lowlight（highlight.js 语言包）按需动态加载：文档里出现需要高亮的代码块时才 import()，
// 普通 Markdown 首开不执行高亮运行时，保持启动预算（scripts/check-budget.mjs）。

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { normalizeLanguage, SINGLE_BLOCK_LIMIT } from './codeLanguages';

type Lowlight = ReturnType<typeof import('./lowlight').getLowlight>;

/** lowlight 返回的 hast 节点（仅声明用到的字段，避免额外依赖 @types/hast） */
interface HastNode {
  type: string;
  value?: string;
  children?: HastNode[];
  properties?: { className?: unknown };
}

/** 相对代码块内容起点的着色区间 */
interface Token {
  from: number;
  to: number;
  className: string;
}

const codeHighlightKey = new PluginKey<DecorationSet>('nb-code-highlight');

/** 着色结果缓存上限：按「语言 + 文本」缓存，未改动的代码块在每次输入时直接复用 */
const TOKEN_CACHE_LIMIT = 200;
const tokenCache = new Map<string, Token[]>();

let lowlightInstance: Lowlight | null = null;
let lowlightLoading: Promise<Lowlight> | null = null;

/** 动态加载共享 lowlight 实例（全局只加载一次） */
function loadLowlight(): Promise<Lowlight> {
  if (!lowlightLoading) {
    lowlightLoading = import('./lowlight').then((m) => {
      lowlightInstance = m.getLowlight();
      return lowlightInstance;
    });
  }
  return lowlightLoading;
}

/** 代码块是否需要高亮：显式选择了非纯文本语言、有内容且未超过单块上限 */
function getHighlightLanguage(node: PMNode): string | null {
  const language = normalizeLanguage((node.attrs.language as string | null) ?? null);
  if (language === 'plaintext') return null;
  const size = node.content.size;
  if (size === 0 || size > SINGLE_BLOCK_LIMIT) return null;
  return language;
}

/** 文档中是否存在需要高亮的代码块（找到即停止遍历） */
function hasHighlightableBlock(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === 'codeBlock') {
      if (getHighlightLanguage(node)) found = true;
      return false;
    }
    // 普通文本块内不可能嵌套代码块，无需继续下钻
    return !node.isTextblock && !node.isAtom;
  });
  return found;
}

/** 把 hast 树拍平成带 class 的文本区间 */
function flattenHast(nodes: HastNode[], classes: string[], cursor: { pos: number }, out: Token[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      const len = node.value?.length ?? 0;
      if (len > 0 && classes.length > 0) {
        out.push({ from: cursor.pos, to: cursor.pos + len, className: classes.join(' ') });
      }
      cursor.pos += len;
    } else if (node.children) {
      const own = node.properties?.className;
      const next = Array.isArray(own) ? [...classes, ...own.map(String)] : classes;
      flattenHast(node.children, next, cursor, out);
    }
  }
}

/** 计算单个代码块的着色区间（带缓存） */
function tokenize(lowlight: Lowlight, language: string, text: string): Token[] {
  const cacheKey = `${language}\u0000${text}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;

  let tokens: Token[] = [];
  // 未注册的语言（如 scss）不高亮，保持原样显示
  if (lowlight.registered(language)) {
    try {
      const tree = lowlight.highlight(language, text) as unknown as HastNode;
      flattenHast(tree.children ?? [], [], { pos: 0 }, tokens);
    } catch {
      tokens = [];
    }
  }

  // 超出上限时淘汰最早写入的一条
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
  tokenCache.set(cacheKey, tokens);
  return tokens;
}

/** 为整篇文档的代码块生成高亮装饰 */
function buildDecorations(doc: PMNode, lowlight: Lowlight): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') {
      const language = getHighlightLanguage(node);
      if (language) {
        // 代码块内容从 pos + 1 开始，且只含纯文本，textContent 偏移与文档位置一一对应
        const start = pos + 1;
        for (const token of tokenize(lowlight, language, node.textContent)) {
          decorations.push(Decoration.inline(start + token.from, start + token.to, { class: token.className }));
        }
      }
      return false;
    }
    return !node.isTextblock && !node.isAtom;
  });
  return DecorationSet.create(doc, decorations);
}

/** 代码块语法高亮插件 */
export function codeHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: codeHighlightKey,
    state: {
      init: (_config, state) => (lowlightInstance ? buildDecorations(state.doc, lowlightInstance) : DecorationSet.empty),
      apply(tr, decorations, _oldState, newState) {
        // lowlight 刚加载完成，或文档内容/语言变化时重新着色（未改动的代码块命中缓存）
        if (lowlightInstance && (tr.docChanged || tr.getMeta(codeHighlightKey) === 'ready')) {
          return buildDecorations(newState.doc, lowlightInstance);
        }
        return tr.docChanged ? decorations.map(tr.mapping, tr.doc) : decorations;
      },
    },
    props: {
      decorations(state) {
        return codeHighlightKey.getState(state);
      },
    },
    view(editorView) {
      let destroyed = false;

      // 首次遇到需要高亮的代码块时才加载 lowlight，加载完成后通知插件重新着色
      const ensureLoaded = (doc: PMNode) => {
        if (lowlightInstance || !hasHighlightableBlock(doc)) return;
        void loadLowlight().then(() => {
          if (destroyed) return;
          editorView.dispatch(editorView.state.tr.setMeta(codeHighlightKey, 'ready').setMeta('addToHistory', false));
        });
      };

      ensureLoaded(editorView.state.doc);

      return {
        update(view, prevState) {
          if (view.state.doc !== prevState.doc) ensureLoaded(view.state.doc);
        },
        destroy() {
          destroyed = true;
        },
      };
    },
  });
}
