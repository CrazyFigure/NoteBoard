// NoteBoard CodeMirror 6 基础配置
// history / defaultKeymap / searchKeymap / indentWithTab / bracketMatching 等
// 详见 docs/09-开发路线图.md 阶段4

import { Compartment, type Extension, RangeSetBuilder } from '@codemirror/state';
import {
  history,
  defaultKeymap,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { search, highlightSelectionMatches } from '@codemirror/search';
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
  highlightSpecialChars,
  highlightWhitespace,
  ViewPlugin,
  Decoration,
  type DecorationSet,
  WidgetType,
  type ViewUpdate,
} from '@codemirror/view';
import { nbSyntaxHighlighting } from './highlightStyle';
import { nbEditorTheme } from './theme';

// ── 热重配 Compartment ──
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

/** 空白字符显示热重配 */
export const whitespaceCompartment = new Compartment();

/** 换行符号显示热重配 */
export const lineEndingCompartment = new Compartment();

// ── 换行符号小部件与扩展 ──

/** 换行符号小部件（渲染 ↵ 标记） */
class NewlineWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-newline-marker';
    span.textContent = '↵';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
}

const newlineWidget = new NewlineWidget();

/** 构建可视区域内的换行符号装饰集 */
function buildNewlineDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      // 非末行在行尾添加 ↵ 换行小部件
      if (line.number < view.state.doc.lines) {
        builder.add(line.to, line.to, Decoration.widget({
          widget: newlineWidget,
          side: 1,
        }));
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** 换行符号显示扩展 */
export const showLineEndingsExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildNewlineDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildNewlineDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

// ── 基础扩展集选项 ──

export interface BaseExtensionsOptions {
  showWhitespace?: boolean;
  showLineEndings?: boolean;
  showLineNumbers?: boolean;
  softWrap?: boolean;
}

/**
 * 相邻输入合并为同一次撤销的最大间隔。
 * 采用比内核默认值更短的 300ms，避免连续但已有明显停顿的输入被一次性撤销过多。
 */
export const HISTORY_NEW_GROUP_DELAY_MS = 300;

/**
 * 编辑历史的最低保留步数。
 * 保存只更新磁盘基线，不清空这部分历史，因此保存前后的内容仍可继续撤销和重做。
 */
export const HISTORY_MIN_DEPTH = 200;

// ── 基础扩展集 ──

export function createBaseExtensions(options?: BaseExtensionsOptions): Extension[] {
  return [
    // 编辑历史：缩短合并窗口并扩大容量，减少单次回退过多，同时保留更长的前后变化链
    history({
      minDepth: HISTORY_MIN_DEPTH,
      newGroupDelay: HISTORY_NEW_GROUP_DELAY_MS,
    }),
    // 行号（通过 compartment 切换）
    lineNumberCompartment.of(
      options?.showLineNumbers !== false ? [lineNumbers(), highlightActiveLineGutter()] : [],
    ),
    // 活动行高亮
    highlightActiveLine(),
    // 特殊字符高亮
    highlightSpecialChars(),
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
    // 空白字符高亮（默认关闭，可通过 compartment 切换）
    whitespaceCompartment.of(options?.showWhitespace ? highlightWhitespace() : []),
    // 换行符号高亮（默认关闭，可通过 compartment 切换）
    lineEndingCompartment.of(options?.showLineEndings ? showLineEndingsExtension : []),
    // 折叠槽
    foldGutter(),
    // 搜索底层高亮与查询支持（不使用 CM 默认 UI）
    search({ top: false }),
    // 选区匹配高亮
    highlightSelectionMatches(),
    // 软换行（可通过 compartment 切换）
    wrapCompartment.of(options?.softWrap ? EditorView.lineWrapping : []),
    // 排版（占位，后续设置面板会用）
    typographyCompartment.of([]),
    // 键映射
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...closeBracketsKeymap,
      indentWithTab,
    ]),
    // 语言（占位，由 openDocument 动态装载）
    languageCompartment.of([]),
  ];
}
