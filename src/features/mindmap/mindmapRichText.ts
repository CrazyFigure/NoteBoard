// NoteBoard 思维导图节点标题富文本
// 标题仍以纯文本 text 存储，格式以「区间标记」marks 附加（加粗 / 斜体 / 下划线 / 删除线 / 文字颜色 / 高亮背景）。
// 区间按 UTF-16 下标计算；文本被编辑、替换时用前后缀差分平移标记，保证格式跟随文字。
// 详见 docs/09-开发路线图.md

import type { CSSProperties } from 'react';

/** 单字符格式 */
export interface MindTextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** 文字颜色 */
  color?: string;
  /** 高亮背景色 */
  highlight?: string;
}

/** 格式区间 [start, end) */
export interface MindTextMark extends MindTextStyle {
  start: number;
  end: number;
}

/** 带格式的文本片段 */
export interface StyledRun {
  start: number;
  end: number;
  style: MindTextStyle;
}

export type ToggleStyleKey = 'bold' | 'italic' | 'underline' | 'strike';
export type ColorStyleKey = 'color' | 'highlight';

const STYLE_KEYS: Array<keyof MindTextStyle> = ['bold', 'italic', 'underline', 'strike', 'color', 'highlight'];

/** 去掉空值后的格式（便于比较与序列化） */
export function cleanStyle(style: MindTextStyle): MindTextStyle {
  const result: MindTextStyle = {};
  if (style.bold) result.bold = true;
  if (style.italic) result.italic = true;
  if (style.underline) result.underline = true;
  if (style.strike) result.strike = true;
  if (style.color) result.color = style.color;
  if (style.highlight) result.highlight = style.highlight;
  return result;
}

export function isEmptyStyle(style: MindTextStyle): boolean {
  return Object.keys(cleanStyle(style)).length === 0;
}

export function sameStyle(a: MindTextStyle, b: MindTextStyle): boolean {
  return STYLE_KEYS.every((k) => (a[k] || undefined) === (b[k] || undefined));
}

/** 展开为逐字符格式数组 */
export function toStyleArray(length: number, marks: readonly MindTextMark[] | undefined): MindTextStyle[] {
  const styles: MindTextStyle[] = Array.from({ length }, () => ({}));
  for (const mark of marks ?? []) {
    const from = Math.max(0, mark.start);
    const to = Math.min(length, mark.end);
    const style = cleanStyle(mark);
    for (let i = from; i < to; i += 1) styles[i] = { ...styles[i], ...style };
  }
  return styles;
}

/** 逐字符格式数组压缩为区间标记（相邻同格式合并，无格式部分省略） */
export function fromStyleArray(styles: readonly MindTextStyle[]): MindTextMark[] {
  const marks: MindTextMark[] = [];
  let i = 0;
  while (i < styles.length) {
    const style = cleanStyle(styles[i]);
    let j = i + 1;
    while (j < styles.length && sameStyle(styles[j], style)) j += 1;
    if (!isEmptyStyle(style)) marks.push({ start: i, end: j, ...style });
    i = j;
  }
  return marks;
}

/** 校验并规范化外部输入的标记；无有效标记时返回 undefined */
export function normalizeMarks(raw: unknown, textLength: number): MindTextMark[] | undefined {
  if (!Array.isArray(raw) || textLength === 0) return undefined;
  const valid: MindTextMark[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    if (typeof m.start !== 'number' || typeof m.end !== 'number') continue;
    valid.push({
      start: m.start,
      end: m.end,
      bold: m.bold === true || undefined,
      italic: m.italic === true || undefined,
      underline: m.underline === true || undefined,
      strike: m.strike === true || undefined,
      color: typeof m.color === 'string' ? m.color : undefined,
      highlight: typeof m.highlight === 'string' ? m.highlight : undefined,
    });
  }
  const marks = fromStyleArray(toStyleArray(textLength, valid));
  return marks.length > 0 ? marks : undefined;
}

/** 区间内所有字符是否都具备某开关格式 */
export function isStyleActive(
  length: number,
  marks: readonly MindTextMark[] | undefined,
  from: number,
  to: number,
  key: ToggleStyleKey,
): boolean {
  if (to <= from) return false;
  const styles = toStyleArray(length, marks);
  for (let i = from; i < to; i += 1) if (!styles[i]?.[key]) return false;
  return true;
}

/** 区间内统一的颜色值（不一致时返回 undefined） */
export function commonColor(
  length: number,
  marks: readonly MindTextMark[] | undefined,
  from: number,
  to: number,
  key: ColorStyleKey,
): string | undefined {
  if (to <= from) return undefined;
  const styles = toStyleArray(length, marks);
  const first = styles[from]?.[key];
  for (let i = from + 1; i < to; i += 1) if (styles[i]?.[key] !== first) return undefined;
  return first;
}

/** 格式修改指令 */
export type StylePatch =
  | { type: 'toggle'; key: ToggleStyleKey }
  | { type: 'color'; key: ColorStyleKey; value: string | null }
  | { type: 'clear' };

/** 对 [from, to) 应用格式修改，返回新的标记 */
export function applyStylePatch(
  length: number,
  marks: readonly MindTextMark[] | undefined,
  from: number,
  to: number,
  patch: StylePatch,
): MindTextMark[] {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(length, Math.max(from, to));
  const styles = toStyleArray(length, marks);
  // 开关格式：区间内全部已具备则取消，否则统一加上
  const turnOn = patch.type === 'toggle' ? !isStyleActive(length, marks, start, end, patch.key) : false;
  for (let i = start; i < end; i += 1) {
    const next = { ...styles[i] };
    if (patch.type === 'clear') {
      styles[i] = {};
      continue;
    }
    if (patch.type === 'toggle') {
      if (turnOn) next[patch.key] = true;
      else delete next[patch.key];
    } else if (patch.value) {
      next[patch.key] = patch.value;
    } else {
      delete next[patch.key];
    }
    styles[i] = next;
  }
  return fromStyleArray(styles);
}

/**
 * 文本变化后平移标记：按公共前缀 / 后缀定位被替换的区段，
 * 删除的字符连同格式一起删除，新插入的字符继承插入点前一个字符的格式
 */
export function adjustMarksForTextChange(
  oldText: string,
  newText: string,
  marks: readonly MindTextMark[] | undefined,
): MindTextMark[] | undefined {
  if (!marks || marks.length === 0) return undefined;
  if (oldText === newText) return [...marks];
  const oldStyles = toStyleArray(oldText.length, marks);
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const inserted = newText.length - prefix - suffix;
  const inherit = prefix > 0 ? oldStyles[prefix - 1] : {};
  const nextStyles = [
    ...oldStyles.slice(0, prefix),
    ...Array.from({ length: inserted }, () => ({ ...inherit })),
    ...oldStyles.slice(oldText.length - suffix),
  ];
  const result = fromStyleArray(nextStyles);
  return result.length > 0 ? result : undefined;
}

/** 把 [start, end) 按格式切分为片段（无标记时为单个无格式片段） */
export function splitStyledRuns(
  marks: readonly MindTextMark[] | undefined,
  start: number,
  end: number,
): StyledRun[] {
  if (end <= start) return [];
  const boundaries = new Set<number>([start, end]);
  for (const m of marks ?? []) {
    if (m.start > start && m.start < end) boundaries.add(m.start);
    if (m.end > start && m.end < end) boundaries.add(m.end);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const runs: StyledRun[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const style: MindTextStyle = {};
    for (const m of marks ?? []) {
      if (m.start <= a && m.end >= b) Object.assign(style, cleanStyle(m));
    }
    const prev = runs[runs.length - 1];
    if (prev && sameStyle(prev.style, style)) prev.end = b;
    else runs.push({ start: a, end: b, style });
  }
  return runs;
}

/** 所有标记边界（用于断行时在格式切换处拆分测量单元） */
export function markBoundaries(marks: readonly MindTextMark[] | undefined): number[] {
  const set = new Set<number>();
  for (const m of marks ?? []) {
    set.add(m.start);
    set.add(m.end);
  }
  return [...set].sort((a, b) => a - b);
}

/** 加粗时的字重：在层级基础字重上加重 */
export function boldWeight(baseWeight: number): number {
  return Math.min(900, Math.max(700, baseWeight + 200));
}

/** 片段格式转为内联样式（画布节点与编辑框共用） */
export function styleToCss(style: MindTextStyle, baseWeight: number): CSSProperties {
  const css: CSSProperties = {};
  if (style.bold) css.fontWeight = boldWeight(baseWeight);
  if (style.italic) css.fontStyle = 'italic';
  const decorations = [style.underline ? 'underline' : '', style.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ');
  if (decorations) css.textDecorationLine = decorations;
  if (style.color) css.color = style.color;
  if (style.highlight) {
    css.background = style.highlight;
    css.borderRadius = 2;
  }
  return css;
}

/** 文字颜色预设 */
export const TEXT_COLOR_PRESETS = [
  { value: '#ef4444', name: '红色' },
  { value: '#f97316', name: '橙色' },
  { value: '#ca8a04', name: '黄色' },
  { value: '#16a34a', name: '绿色' },
  { value: '#0891b2', name: '青色' },
  { value: '#2563eb', name: '蓝色' },
  { value: '#7c3aed', name: '紫色' },
  { value: '#db2777', name: '粉色' },
  { value: '#6b7280', name: '灰色' },
];

/** 高亮背景预设（半透明，浅色 / 深色主题下都可读） */
export const HIGHLIGHT_PRESETS = [
  { value: 'rgba(250, 204, 21, 0.45)', name: '黄色' },
  { value: 'rgba(251, 146, 60, 0.4)', name: '橙色' },
  { value: 'rgba(248, 113, 113, 0.4)', name: '红色' },
  { value: 'rgba(74, 222, 128, 0.4)', name: '绿色' },
  { value: 'rgba(96, 165, 250, 0.4)', name: '蓝色' },
  { value: 'rgba(167, 139, 250, 0.4)', name: '紫色' },
  { value: 'rgba(244, 114, 182, 0.4)', name: '粉色' },
  { value: 'rgba(148, 163, 184, 0.45)', name: '灰色' },
];
