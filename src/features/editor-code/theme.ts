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
      // 代码与纯文本行高由 --mono-line-height 驱动
      lineHeight: 'var(--mono-line-height, 1.5)',
      fontFamily: 'var(--mono-font-family)',
      fontSize: 'var(--mono-font-size)',
    },
    '.cm-content, .cm-line': {
      fontFamily: 'var(--mono-font-family)',
      fontSize: 'var(--mono-font-size)',
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
    // 选区（使用原生文本选区，精准贴合字形边界）
    '::selection, .cm-content ::selection, .cm-line ::selection, .cm-selectionBackground':
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
    '&.cm-focused ::selection, &.cm-focused .cm-content ::selection, &.cm-focused .cm-line ::selection, &.cm-focused .cm-selectionBackground':
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
    // 搜索高亮与当前选中匹配项高亮（当前匹配项呈深色高对比度选中态与边框）
    '.cm-searchMatch': {
      backgroundColor: 'var(--cm-search-match-bg)',
      borderRadius: '2px',
    },
    '.cm-searchMatch.cm-searchMatch-selected, .cm-searchMatch-selected': {
      backgroundColor: 'var(--editor-selection, rgba(59, 130, 246, 0.38)) !important',
      outline: '1.5px solid var(--accent-strong, #3b82f6)',
      borderRadius: '2px',
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
    // 换行符号标记
    '.cm-newline-marker': {
      color: 'var(--editor-text-muted)',
      opacity: '0.45',
      userSelect: 'none',
      pointerEvents: 'none',
      fontFamily: 'inherit',
      marginLeft: '2px',
    },
    // 空白字符与制表符标记
    '.cm-highlightSpace': {
      color: 'var(--editor-text-muted)',
      opacity: '0.45',
    },
    '.cm-highlightTab': {
      color: 'var(--editor-text-muted)',
      opacity: '0.45',
    },
    // 隐藏 CM 默认搜索替换面板（统一由自研悬浮组件提供）
    '.cm-panel.cm-search': {
      display: 'none !important',
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
