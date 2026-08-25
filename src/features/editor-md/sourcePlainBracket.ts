// Markdown 源码模式普通方括号显示修正
// CodeMirror 会把没有地址或引用标签的 `[文本]` 也标记为链接，本扩展仅撤销这类误导性装饰。

import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

const PLAIN_BRACKET_CLASS = 'nb-md-plain-bracket';
const plainBracketDecoration = Decoration.mark({ class: PLAIN_BRACKET_CLASS });

interface PlainBracketRange {
  from: number;
  to: number;
}

/**
 * 收集可视区域内没有 URL、引用标签等目标信息的裸方括号范围。
 * 正常行内链接 `[标题](地址)`、引用链接 `[标题][引用]` 与图片不会进入结果。
 */
function findPlainBracketRanges(view: EditorView): PlainBracketRange[] {
  const tree = syntaxTree(view.state);
  const ranges: PlainBracketRange[] = [];
  const seen = new Set<string>();

  for (const visibleRange of view.visibleRanges) {
    tree.iterate({
      from: visibleRange.from,
      to: visibleRange.to,
      enter(node) {
        if (node.name !== 'Link') return;

        let linkMarkCount = 0;
        let hasLinkTarget = false;
        for (let child = node.node.firstChild; child; child = child.nextSibling) {
          if (child.name === 'LinkMark') linkMarkCount += 1;
          if (child.name === 'URL' || child.name === 'LinkLabel') hasLinkTarget = true;
        }

        // 裸 `[文本]` 只有首尾两个 LinkMark；带地址或引用标签的真实链接继续使用原高亮。
        if (linkMarkCount !== 2 || hasLinkTarget) return;
        const key = `${node.from}:${node.to}`;
        if (seen.has(key)) return;
        seen.add(key);
        ranges.push({ from: node.from, to: node.to });
      },
    });
  }

  return ranges.sort((left, right) => left.from - right.from || left.to - right.to);
}

/** 为裸方括号生成 CodeMirror 装饰集。 */
function buildPlainBracketDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of findPlainBracketRanges(view)) {
    builder.add(range.from, range.to, plainBracketDecoration);
  }
  return builder.finish();
}

const plainBracketPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildPlainBracketDecorations(view);
    }

    /** 文档或可视区域变化后同步刷新，避免滚动后遗漏或保留过期装饰。 */
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildPlainBracketDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

const plainBracketTheme = EditorView.theme({
  // 覆盖 Markdown Link 高亮；裸方括号是普通正文，不应显示成可点击链接。
  [`.${PLAIN_BRACKET_CLASS}, .${PLAIN_BRACKET_CLASS} *`]: {
    color: 'inherit !important',
    textDecoration: 'none !important',
  },
  // 光标停在裸方括号旁时也不显示链接式方框；真实链接仍保留全局括号匹配反馈。
  [`.${PLAIN_BRACKET_CLASS}.cm-matchingBracket, .${PLAIN_BRACKET_CLASS} .cm-matchingBracket`]: {
    backgroundColor: 'transparent !important',
    outline: 'none !important',
    textDecoration: 'none !important',
  },
});

/** Markdown 源码模式专用的普通方括号显示修正扩展。 */
export const markdownPlainBracketExtension: Extension = [plainBracketPlugin, plainBracketTheme];
