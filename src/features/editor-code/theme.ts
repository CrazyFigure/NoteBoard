// NoteBoard CodeMirror 6 界面主题
// 消费 --cm-* CSS 变量，与 globals.css 三套主题同步
// 详见 docs/06-主题与设计规范.md §6.5

import { EditorView } from '@codemirror/view';
import { Extension } from '@codemirror/state';

// ── 编辑器主题（界面色）──

export const nbEditorTheme: Extension = EditorView.theme(
  {
    // 编辑器根
    '&': {
      backgroundColor: 'var(--editor-bg)',
      color: 'var(--editor-text)',
      height: '100%',
      fontFamily: 'var(--mono-font-family)',
      fontSize: 'var(--mono-font-size)',
    },
    '.cm-scroller': {
      overflow: 'auto',
      lineHeight: 'var(--content-line-height)',
    },
    // 行号槽
    '.cm-gutters': {
      backgroundColor: 'var(--cm-gutter-bg)',
      color: 'var(--cm-gutter-text)',
      border: 'none',
      borderRight: '1px solid var(--editor-border)',
    },
    '.cm-gutter.cm-activeGutter': {
      backgroundColor: 'var(--cm-gutter-bg)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--cm-gutter-active-text)',
    },
    // 活动行
    '.cm-activeLine': {
      backgroundColor: 'var(--cm-active-line-bg)',
    },
    // 选区
    '.cm-selectionBackground, .cm-content ::selection, .cm-line ::selection':
      {
        backgroundColor: 'var(--cm-selection-bg)',
      },
    '.cm-selectionMatch': {
      backgroundColor: 'var(--cm-search-match-bg)',
    },
    // 光标
    '&.cm-focused .cm-cursor, .cm-cursor': {
      borderLeftColor: 'var(--cm-cursor)',
      borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      {
        backgroundColor: 'var(--cm-selection-bg)',
      },
    // 括号匹配
    '.cm-bracketMatch': {
      backgroundColor: 'var(--cm-bracket-bg)',
      outline: '1px solid var(--cm-bracket-outline)',
    },
    // 缩进导线
    '.cm-indent-mark': {
      color: 'var(--cm-indent-guide)',
    },
    // 折叠占位符
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--cm-fold-placeholder-bg)',
      border: '1px solid var(--editor-border)',
      borderRadius: '3px',
      padding: '0 4px',
      margin: '0 2px',
      color: 'var(--editor-text-muted)',
      fontSize: '11px',
    },
    // 搜索高亮
    '.cm-searchMatch': {
      backgroundColor: 'var(--cm-search-match-bg)',
      outline: '1px solid var(--cm-search-active-bg)',
    },
    '.cm-searchMatch-selected': {
      backgroundColor: 'var(--cm-search-active-bg)',
    },
    // lint 标记
    '.cm-diagnosticText-error': {
      color: 'var(--cm-lint-error)',
    },
    '.cm-diagnosticText-warning': {
      color: 'var(--cm-lint-warning)',
    },
    '.cm-lintRange-error': {
      textDecoration: 'underline wavy var(--cm-lint-error)',
    },
    '.cm-lintRange-warning': {
      textDecoration: 'underline wavy var(--cm-lint-warning)',
    },
    // 通知面板
    '.cm-panels': {
      backgroundColor: 'var(--editor-surface)',
      color: 'var(--editor-text)',
      borderTop: '1px solid var(--editor-border)',
    },
    // 焦点边框
    '&.cm-focused': {
      outline: 'none',
    },
  },
  { dark: false },
);

// ── 暗色主题变体 ──
// CM6 的 theme() 不支持 CSS 变量自动切换，但因为我们用 CSS 变量，
// 上面所有值都已经是 var(--*) 形式，会跟随 [data-theme] 自动切换。
// 所以只需要一个 theme 实例即可。
