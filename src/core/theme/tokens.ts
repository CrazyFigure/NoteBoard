// NoteBoard 主题 Token 名常量
// 防拼错 + 必需 Token 清单（用于结构完整性测试）
// 色值来源：docs/06-主题与设计规范.md §3/4/5

import type { ThemeId } from '../ipc/types';

// ── 三套主题 ID ──

export const THEME_IDS: readonly ThemeId[] = ['chen-guang', 'hu-po', 'mo-ye'] as const;

// ── 必需 Token 清单 ──
// 三套主题的 Token 键集合必须完全一致，缺一个即 CI 失败

export const REQUIRED_TOKENS: readonly string[] = [
  // 色板层（primary）
  '--primary-50', '--primary-100', '--primary-200', '--primary-300', '--primary-400',
  '--primary-500', '--primary-600', '--primary-700', '--primary-800', '--primary-900',
  // 色板层（accent）
  '--accent-50', '--accent-100', '--accent-200', '--accent-300', '--accent-400',
  '--accent-500', '--accent-600', '--accent-700', '--accent-800',
  // 功能色
  '--success-500', '--success-600',
  '--warning-500', '--warning-600',
  '--error-500', '--error-600',

  // 语义层
  '--editor-bg', '--editor-surface', '--editor-text', '--editor-text-secondary', '--editor-text-muted',
  '--editor-border', '--editor-border-focus', '--editor-heading', '--editor-accent',
  '--accent-strong', '--editor-link',
  '--editor-quote-bg', '--editor-selection', '--editor-code-bg',
  '--code-inline-bg', '--code-inline-text',
  '--code-block-bg', '--code-block-container-bg', '--code-block-text',

  // 语法高亮（17 个）
  '--hljs-comment', '--hljs-keyword', '--hljs-string', '--hljs-number',
  '--hljs-title', '--hljs-function', '--hljs-params', '--hljs-variable',
  '--hljs-class', '--hljs-meta', '--hljs-addition', '--hljs-deletion',
  '--hljs-regexp', '--hljs-selector-class', '--hljs-selector-id',
  '--hljs-link', '--hljs-attr',

  // 组件层
  '--titlebar-bg', '--toolbar-hover', '--toolbar-active',
  '--tab-bg', '--tab-active-bg', '--tab-inactive-bg', '--tab-hover-bg',
  '--tab-border', '--tab-active-indicator', '--tab-dirty-dot',
  '--explorer-bg', '--explorer-surface', '--explorer-text', '--explorer-text-muted',
  '--explorer-hover', '--explorer-active', '--explorer-border', '--explorer-indent-guide',
  '--outline-bg', '--outline-item-active-bg', '--outline-item-hover-bg', '--outline-item-active-text',
  '--rail-bg', '--rail-fg', '--rail-hover-bg',
  '--statusbar-bg', '--statusbar-text',
  '--scrollbar-track', '--scrollbar-thumb',

  // CodeMirror
  '--cm-gutter-bg', '--cm-gutter-text', '--cm-gutter-active-text',
  '--cm-active-line-bg', '--cm-selection-bg', '--cm-cursor',
  '--cm-bracket-bg', '--cm-bracket-outline',
  '--cm-search-match-bg', '--cm-search-active-bg',
  '--cm-indent-guide', '--cm-fold-placeholder-bg',
  '--cm-lint-error', '--cm-lint-warning',

  // GitHub Alerts
  '--alert-note-border', '--alert-note-bg',
  '--alert-tip-border', '--alert-tip-bg',
  '--alert-important-border', '--alert-important-bg',
  '--alert-warning-border', '--alert-warning-bg',
  '--alert-caution-border', '--alert-caution-bg',

  // 画板
  '--board-canvas-bg', '--board-panel-bg', '--board-panel-border',
  '--board-icon-fg', '--board-button-hover-bg', '--board-button-active-bg',
  '--board-selection-outline',
] as const;

// ── 对比度测试用的 Token 对 ──

// 正文类 Token（≥ 4.5:1）—— [text, bg]
export const TEXT_PAIRS: readonly [string, string][] = [
  ['--editor-text', '--editor-bg'],
  ['--editor-text-secondary', '--editor-bg'],
  ['--editor-link', '--editor-bg'],
  ['--code-inline-text', '--code-inline-bg'],
  ['--code-block-text', '--code-block-bg'],
  // 17 个 hljs token on code-block-bg
  ['--hljs-comment', '--code-block-bg'],
  ['--hljs-keyword', '--code-block-bg'],
  ['--hljs-string', '--code-block-bg'],
  ['--hljs-number', '--code-block-bg'],
  ['--hljs-title', '--code-block-bg'],
  ['--hljs-function', '--code-block-bg'],
  ['--hljs-params', '--code-block-bg'],
  ['--hljs-variable', '--code-block-bg'],
  ['--hljs-class', '--code-block-bg'],
  ['--hljs-meta', '--code-block-bg'],
  ['--hljs-addition', '--code-block-bg'],
  ['--hljs-deletion', '--code-block-bg'],
  ['--hljs-regexp', '--code-block-bg'],
  ['--hljs-selector-class', '--code-block-bg'],
  ['--hljs-selector-id', '--code-block-bg'],
  ['--hljs-link', '--code-block-bg'],
  ['--hljs-attr', '--code-block-bg'],
  // 代码文件场景（on editor-bg，不是 code-block-bg）
  ['--hljs-comment', '--editor-bg'],
  ['--hljs-keyword', '--editor-bg'],
  ['--hljs-string', '--editor-bg'],
  ['--hljs-number', '--editor-bg'],
  ['--hljs-title', '--editor-bg'],
  ['--hljs-variable', '--editor-bg'],
  ['--hljs-function', '--editor-bg'],
  ['--hljs-meta', '--editor-bg'],
] as const;

// 指示器类 Token（≥ 3:1）—— [indicator, bg]
export const UI_PAIRS: readonly [string, string][] = [
  ['--accent-strong', '--editor-bg'],
  ['--tab-dirty-dot', '--tab-inactive-bg'],
  ['--tab-active-indicator', '--tab-bg'],
  ['--cm-gutter-text', '--cm-gutter-bg'],
  ['--cm-lint-error', '--editor-bg'],
  ['--cm-lint-warning', '--editor-bg'],
  ['--editor-border-focus', '--editor-bg'],
] as const;
