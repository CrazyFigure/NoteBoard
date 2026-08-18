// NoteBoard CodeMirror 6 基础配置
// history / defaultKeymap / searchKeymap / indentWithTab / bracketMatching 等
// 详见 docs/09-开发路线图.md 阶段4

import { Compartment, type Extension } from '@codemirror/state';
import {
  history,
  defaultKeymap,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
  highlightWhitespace,
} from '@codemirror/view';
import { nbSyntaxHighlighting } from './highlightStyle';
import { nbEditorTheme } from './theme';

// ── 5 个热重配 Compartment ──
// 详见 docs/09-开发路线图.md 4.3

/** 语言热重配 */
export const languageCompartment = new Compartment();

/** 主题（高亮样式）热重配 */
export const themeCompartment = new Compartment();

/** 软换行热重配 */
export const wrapCompartment = new Compartment();

/** 行号热重配 */
export const lineNumberCompartment = new Compartment();

/** 排版热重配 */
export const typographyCompartment = new Compartment();

// ── 基础扩展集 ──

export function createBaseExtensions(): Extension[] {
  return [
    // 历史
    history(),
    // 行号（初始开启，可通过 compartment 切换）
    lineNumberCompartment.of([lineNumbers(), highlightActiveLineGutter()]),
    // 活动行高亮
    highlightActiveLine(),
    // 特殊字符高亮
    highlightSpecialChars(),
    // 选区绘制
    drawSelection(),
    // 矩形选择
    rectangularSelection(),
    crosshairCursor(),
    // 括号匹配
    bracketMatching(),
    // 闭合括号
    closeBrackets(),
    // 输入时自动缩进
    indentOnInput(),
    // 缩进单位
    indentUnit.of('  '),
    // 语法高亮（NoteBoard 自定义样式）
    themeCompartment.of(nbSyntaxHighlighting),
    // fallback 高亮（覆盖未映射的 tag）
    syntaxHighlighting(defaultHighlightStyle),
    // 编辑器界面主题
    nbEditorTheme,
    // 空白字符高亮
    highlightWhitespace(),
    // 折叠槽
    foldGutter(),
    // 选区匹配高亮
    highlightSelectionMatches(),
    // 软换行（默认关闭，可切换）
    wrapCompartment.of([]),
    // 排版（占位，后续设置面板会用）
    typographyCompartment.of([]),
    // 键映射
    keymap.of([
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...closeBracketsKeymap,
      indentWithTab,
    ]),
    // 语言（占位，由 openDocument 动态装载）
    languageCompartment.of([]),
  ];
}
