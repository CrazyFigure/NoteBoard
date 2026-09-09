// NoteBoard 文本对比差异高亮主题
// 覆盖 @codemirror/merge 默认配色：柔和红（左侧/原文）与绿（右侧/修改文）语义色，
// 采用低透明度底色方案（参照 VS Code diff 配色），明暗三主题下均可读
// merge 视图外层高度/滚动与中缝采用按钮层样式见 TextDiffView 的 TEXT_DIFF_CSS

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

export const nbMergeDiffTheme: Extension = EditorView.theme(
  {
    // 差异行底色（cm-merge-a=左侧原文，cm-merge-b=右侧修改文）
    '&.cm-merge-a .cm-changedLine': { backgroundColor: 'rgba(239, 68, 68, 0.10)' },
    '&.cm-merge-b .cm-changedLine': { backgroundColor: 'rgba(34, 197, 94, 0.10)' },
    // 行内词级差异高亮
    '&.cm-merge-a .cm-changedText': { background: 'rgba(239, 68, 68, 0.35)', borderRadius: '2px' },
    '&.cm-merge-b .cm-changedText': { background: 'rgba(34, 197, 94, 0.32)', borderRadius: '2px' },
    // 内联删除文本（deletedChunk 占位中的删除内容）
    '.cm-deletedText': { background: 'rgba(239, 68, 68, 0.35)', borderRadius: '2px' },
    // 差异行 gutter 色条
    '&.cm-merge-a .cm-changedLineGutter, & .cm-deletedLineGutter': {
      backgroundColor: 'rgba(239, 68, 68, 0.5)',
    },
    '&.cm-merge-b .cm-changedLineGutter': { backgroundColor: 'rgba(34, 197, 94, 0.5)' },
    // 折叠相同行提示（点击展开；⦚ 装饰符沿用 merge 内置样式）
    '.cm-collapsedLines': {
      color: 'var(--editor-text-muted, #64748b)',
      background: 'var(--editor-surface, #f1f5f9)',
      border: '1px solid var(--editor-border, #e2e8f0)',
      borderRadius: '4px',
    },
  },
  { dark: false },
);
