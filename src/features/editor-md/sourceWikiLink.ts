// NoteBoard 双链（Markdown 源码模式）
// 1. 可视区域内的 `[[...]]` 显示为链接色，目标不存在时弱化为虚线；
// 2. Ctrl / Cmd + 单击跳转、双击打开编辑弹窗（与可视化模式一致）；
// 3. 输入 `[[` 后弹出仓库笔记补全（含已打开的仓库外文档），选中后补齐 `]]`（自动闭合括号已插入时不重复）。

import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import {
  createExternalEntry,
  linkTargetFor,
  peekNoteIndex,
  resolveVaultRoot,
  searchNotes,
  subscribeNoteIndex,
  type NoteEntry,
} from '../wikilink/noteIndex';
import { docPathOf, loadNoteHeadings, openDocumentEntries, openWikiLink, resolveWikiLinkNow } from '../wikilink/wikiLinkNavigation';
import { insertWikiLinkInSource } from '../wikilink/wikiLinkActions';
import { openWikiLinkDialog } from '../wikilink/wikiLinkDialogStore';
import { WIKI_LINK_MAX_LENGTH } from '../wikilink/wikiLinkSyntax';

const WIKI_LINK_CLASS = 'nb-md-wikilink';
const resolvedDecoration = Decoration.mark({ class: WIKI_LINK_CLASS });
const unresolvedDecoration = Decoration.mark({ class: `${WIKI_LINK_CLASS} is-unresolved` });

const WIKI_LINK_PATTERN = new RegExp(`\\[\\[([^\\[\\]\\r\\n]{1,${WIKI_LINK_MAX_LENGTH}}?)\\]\\]`, 'g');

/** 代码相关语法节点：其中的 `[[...]]` 是普通文字 */
const CODE_NODE_NAMES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'CodeMark', 'HTMLBlock', 'Comment']);

/** 语法树节点中用到的最小字段 */
interface SyntaxNodeLike {
  name: string;
  parent: SyntaxNodeLike | null;
}

interface WikiRange {
  from: number;
  to: number;
  inner: string;
}

/** 位置是否位于代码语法节点内 */
function isInCode(view: EditorView, pos: number): boolean {
  for (let node: SyntaxNodeLike | null = syntaxTree(view.state).resolveInner(pos, 1); node; node = node.parent) {
    if (CODE_NODE_NAMES.has(node.name)) return true;
  }
  return false;
}

/** 收集可视区域内的双链范围 */
function findWikiRanges(view: EditorView): WikiRange[] {
  const ranges: WikiRange[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    if (!text.includes('[[')) continue;
    WIKI_LINK_PATTERN.lastIndex = 0;
    for (let match = WIKI_LINK_PATTERN.exec(text); match; match = WIKI_LINK_PATTERN.exec(text)) {
      if (!match[1].trim()) continue;
      const start = from + match.index;
      // 反斜杠转义与代码中的方括号不是链接
      if (start > 0 && view.state.doc.sliceString(start - 1, start) === '\\') continue;
      if (isInCode(view, start)) continue;
      ranges.push({ from: start, to: start + match[0].length, inner: match[1] });
    }
  }
  return ranges;
}

/** 源码模式双链扩展（docKey 用于解析相对目标与跳转来源） */
export function markdownWikiLinkExtension(docKey: string): Extension {
  const decorations = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      ranges: WikiRange[] = [];
      private readonly unsubscribe: () => void;

      constructor(readonly view: EditorView) {
        this.decorations = this.build();
        // 索引重建后刷新「是否存在」样式；只需重新派发一次空事务触发 update
        this.unsubscribe = subscribeNoteIndex(() => {
          this.decorations = this.build();
          view.dispatch({});
        });
      }

      build(): DecorationSet {
        this.ranges = findWikiRanges(this.view);
        const builder = new RangeSetBuilder<Decoration>();
        for (const range of this.ranges) {
          const missing = resolveWikiLinkNow(range.inner, docKey).status === 'missing';
          builder.add(range.from, range.to, missing ? unresolvedDecoration : resolvedDecoration);
        }
        return builder.finish();
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) this.decorations = this.build();
      }

      destroy(): void {
        this.unsubscribe();
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(event, view) {
          if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return false;
          const range = this.ranges.find((item) => pos >= item.from && pos <= item.to);
          if (!range) return false;
          event.preventDefault();
          void openWikiLink(range.inner, docKey);
          return true;
        },
        // 双击双链：打开编辑弹窗（与可视化模式一致），保存后改写原文
        dblclick(event, view) {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return false;
          const range = this.ranges.find((item) => pos >= item.from && pos <= item.to);
          if (!range) return false;
          event.preventDefault();
          const embed = range.from > 0 && view.state.doc.sliceString(range.from - 1, range.from) === '!';
          const from = embed ? range.from - 1 : range.from;
          void openWikiLinkDialog({ mode: 'edit', docKey, inner: range.inner, embed }).then((result) => {
            if (!result) return;
            if (result.action === 'open') {
              void openWikiLink(result.inner, docKey);
              return;
            }
            // 弹窗期间原文可能被改动：确认该位置仍是同一个链接再写回
            const current = view.state.doc.sliceString(from, range.to);
            if (current !== `${embed ? '!' : ''}[[${range.inner}]]`) return;
            const insert = result.action === 'remove' ? '' : `${result.embed ? '!' : ''}[[${result.inner}]]`;
            view.dispatch({ changes: { from, to: range.to, insert }, selection: { anchor: from + insert.length } });
            view.focus();
          });
          return true;
        },
      },
    },
  );

  /** 写入补全结果并补齐 `]]`：自动闭合括号已在光标后插入 `]]` 时不重复 */
  const applyText = (text: string) => (view: EditorView, _completion: Completion, from: number, to: number) => {
    const after = view.state.doc.sliceString(to, to + 2);
    const closing = after === ']]' ? '' : ']]';
    const insert = `${text}${closing}`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length + (closing ? 0 : 2) },
    });
  };

  /** 「更多选项」：删掉已输入的 `[[查询`，带着查询打开完整弹窗 */
  const moreOptions = (start: number, query: string, embed: boolean): Completion => ({
    label: '更多选项…',
    detail: '标题、显示名、嵌入',
    type: 'keyword',
    boost: -99,
    apply: (view, _completion, _from, to) => {
      const end = view.state.doc.sliceString(to, to + 2) === ']]' ? to + 2 : to;
      view.dispatch({ changes: { from: start, to: end, insert: '' }, selection: { anchor: start } });
      void insertWikiLinkInSource(view, docKey, { inner: query, embed });
    },
  });

  /** `[[` 补全源：笔记名；写到 `笔记#` 后补全该笔记的标题 */
  const completionSource = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const before = context.matchBefore(/!?\[\[[^[\]\r\n]*$/);
    if (!before) return null;
    if (isInCode(context.view!, before.from)) return null;
    const embed = before.text.startsWith('!');
    const queryStart = before.from + (embed ? 3 : 2);
    const query = before.text.slice(embed ? 3 : 2);
    // 已写到显示名部分时不再补全
    if (query.includes('|')) return null;
    const fromPath = docPathOf(docKey);

    const hashIndex = query.indexOf('#');
    if (hashIndex >= 0) {
      const target = query.slice(0, hashIndex);
      const headingQuery = query.slice(hashIndex + 1).trim().toLowerCase();
      let source: NoteEntry | null = null;
      if (!target.trim()) source = fromPath ? createExternalEntry(fromPath) : null;
      else {
        const resolution = resolveWikiLinkNow(target, docKey);
        source = resolution.status === 'resolved' ? resolution.entry : null;
      }
      const headings = source ? await loadNoteHeadings(source) : [];
      const options: Completion[] = headings
        .filter((heading) => heading.text.toLowerCase().includes(headingQuery))
        .map((heading) => ({
          label: heading.text,
          detail: `H${heading.level}`,
          type: 'property',
          apply: applyText(heading.text),
        }));
      return { from: queryStart + hashIndex + 1, options, filter: false };
    }

    const root = resolveVaultRoot(fromPath);
    const snapshot = root ? peekNoteIndex(root) : null;
    const options: Completion[] = searchNotes(snapshot, query, fromPath, 50, openDocumentEntries()).map((entry) => ({
      label: entry.isMarkdown ? entry.stem : entry.name,
      detail: entry.external
        ? `仓库外 · ${entry.dir}`
        : entry.relPath.includes('/') ? entry.relPath.replace(/\/[^/]*$/, '') : undefined,
      info: entry.isMarkdown ? '输入 # 可继续选择其中的标题' : undefined,
      type: 'text',
      apply: applyText(linkTargetFor(snapshot, entry, fromPath)),
    }));
    options.push(moreOptions(before.from, query, embed));
    return {
      from: queryStart,
      options,
      // 候选由本地索引排序过滤；不设 validFor，每次输入都重新查询
      filter: false,
    };
  };

  return [
    decorations,
    autocompletion({
      override: [completionSource],
      icons: false,
      // 只在 `[[` 语境出现，不打扰普通 Markdown 输入
      activateOnTyping: true,
    }),
    wikiLinkSourceTheme,
  ];
}

// 选择器带 .cm-line 前缀以高于裸方括号修正（sourcePlainBracket）的样式，二者装饰会互相嵌套
const wikiLinkSourceTheme = EditorView.theme({
  [`.cm-line .${WIKI_LINK_CLASS}, .cm-line .${WIKI_LINK_CLASS} *`]: {
    color: 'var(--editor-link) !important',
    textDecoration: 'none !important',
  },
  [`.cm-line .${WIKI_LINK_CLASS}.is-unresolved, .cm-line .${WIKI_LINK_CLASS}.is-unresolved *`]: {
    color: 'var(--editor-text-muted) !important',
  },
  // 补全面板跟随主题
  '.cm-tooltip.cm-tooltip-autocomplete': {
    background: 'var(--editor-surface)',
    border: '1px solid var(--editor-border)',
    borderRadius: '8px',
    boxShadow: '0 10px 30px -4px rgba(0, 0, 0, 0.18)',
    overflow: 'hidden',
    padding: '4px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'inherit',
    maxHeight: '280px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '4px 8px',
    borderRadius: '6px',
    color: 'var(--editor-text)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--editor-selection-background, var(--editor-selection))',
    color: 'var(--editor-text)',
  },
  '.cm-completionDetail': {
    marginLeft: '8px',
    fontStyle: 'normal',
    color: 'var(--editor-text-muted)',
    fontSize: '12px',
  },
});
