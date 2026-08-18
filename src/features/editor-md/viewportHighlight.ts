// NoteBoard lowlight ProseMirror 插件
// ±2000 position 裁剪、rAF 批处理、addToHistory: false、记忆化、单块 >20k 跳过、highlightAuto ≤5k
// 详见 docs/09-开发路线图.md 7.9/7.10
//
// 移植自 note-gen 的 viewport highlight 逻辑，但精简实现：
// 1. 只高亮视口内可见的代码块（±2000 position 裁剪）
// 2. 用 rAF 批处理，避免每次 update 都跑
// 3. lowlight 延迟加载（首帧 double-rAF 后）

import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node } from '@tiptap/pm/model';
import { toHtml } from 'hast-util-to-html';
import { getLowlight, normalizeLanguage, HIGHLIGHT_AUTO_LIMIT, SINGLE_BLOCK_LIMIT } from './lowlight';
import { shouldSkipCodeBlockHighlight, shouldUseHighlightAuto } from './largeDoc';

const highlightKey = new PluginKey('nb-lowlight-viewport');

/** 视口裁剪范围（±2000 position） */
const VIEWPORT_MARGIN = 2000;

/** 记忆化缓存：nodeKey → 已高亮的 HTML */
const highlightCache = new Map<string, { language: string; html: string }>();

/** 节点签名（用于记忆化 key） */
function nodeSignature(node: Node, pos: number): string {
  return `${pos}:${node.type.name}:${node.textContent.length}:${node.attrs.language ?? ''}`;
}

/** 对单个代码块执行高亮 */
function highlightCodeBlock(node: Node, _pos: number): { language: string; html: string } | null {
  const language = normalizeLanguage(node.attrs.language || 'plaintext');
  const text = node.textContent;

  if (text.length === 0) return null;
  if (shouldSkipCodeBlockHighlight(text)) return null; // 单块 >20k 跳过

  const lowlight = getLowlight();

    try {
      let result;
      if (shouldUseHighlightAuto(text) && language === 'plaintext') {
        // ≤5k 且 plaintext → highlightAuto
        result = lowlight.highlightAuto(text);
      } else {
        result = lowlight.highlight(language, text);
      }
      return { language, html: toHtml(result) };
    } catch {
      // 高亮失败返回 null
      return null;
    }
}

/** 扫描视口内代码块并应用高亮 */
function highlightInView(view: EditorView): void {
  const { state } = view;
  const viewport = view.dom.getBoundingClientRect();

  // 视口对应的 position 范围（±2000 裁剪）
  const startPos = view.posAtHeight(viewport.top, 0) - VIEWPORT_MARGIN;
  const endPos = view.posAtHeight(viewport.bottom, 0) + VIEWPORT_MARGIN;
  const safeStart = Math.max(0, startPos);
  const safeEnd = Math.min(state.doc.content.size, endPos);

  // 遍历范围内的节点
  state.doc.nodesBetween(safeStart, safeEnd, (node, pos) => {
    if (node.type.name !== 'codeBlock') return;

    const sig = nodeSignature(node, pos);

    // 检查缓存
    const cached = highlightCache.get(sig);
    if (cached && cached.language === normalizeLanguage(node.attrs.language || 'plaintext')) {
      applyHighlight(view, pos, node, cached.html);
      return;
    }

    // 执行高亮
    const result = highlightCodeBlock(node, pos);
    if (result) {
      highlightCache.set(sig, result);
      applyHighlight(view, pos, node, result.html);
    }
  });

  // 清理过期缓存（超过 100 条时清理最早的）
  if (highlightCache.size > 100) {
    const firstKey = highlightCache.keys().next().value;
    if (firstKey) highlightCache.delete(firstKey);
  }
}

/** 将高亮 HTML 应用到 DOM */
function applyHighlight(_view: EditorView, _pos: number, node: Node, html: string): void {
  // 找到对应的 <code> DOM 元素
  const codeEl = findCodeElement(_view, _pos, node);
  if (!codeEl) return;

  // 只有当内容不同时才更新（避免不必要的 DOM 操作）
  if (codeEl.innerHTML !== html) {
    codeEl.innerHTML = html;
  }
}

/** 查找代码块对应的 <code> 元素 */
function findCodeElement(view: EditorView, pos: number, _node: Node): HTMLElement | null {
  try {
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      const code = dom.querySelector('code');
      if (code) return code;
    }
  } catch {
    // pos 可能无效
  }
  return null;
}

/** rAF 批处理调度器 */
let rafScheduled = false;
function scheduleHighlight(view: EditorView): void {
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    highlightInView(view);
  });
}

/**
 * lowlight 视口高亮 ProseMirror 插件
 * 注册到 TipTap 扩展中
 */
export function viewportHighlightPlugin() {
  return new Plugin({
    key: highlightKey,
    state: {
      init() {
        return { lastScroll: 0 };
      },
      apply(tr, value) {
        return value;
      },
    },
    props: {
      handleDOMEvents: {
        scroll(view: EditorView) {
          scheduleHighlight(view);
          return false;
        },
      },
    },
    view(editorView: EditorView) {
      // 延迟加载：首帧 double-rAF 后
      let initialized = false;

      function init() {
        if (initialized) return;
        initialized = true;
        highlightInView(editorView);
      }

      // double-rAF
      requestAnimationFrame(() => {
        requestAnimationFrame(init);
      });

      return {
        update(view: EditorView) {
          if (!initialized) return;
          scheduleHighlight(view);
        },
        destroy() {
          highlightCache.clear();
        },
      };
    },
  });
}

/** 清除高亮缓存（文档关闭时调用） */
export function clearHighlightCache(): void {
  highlightCache.clear();
}

// 为 posAtHeight 提供的类型补丁（ProseMirror 内部 API）
declare module '@tiptap/pm/view' {
  interface EditorView {
    posAtHeight(top: number, bias: number): number;
  }
}
