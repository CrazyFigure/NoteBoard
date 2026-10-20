// NoteBoard 思维导图标题富文本测试
// 覆盖格式应用 / 切换 / 清除、文本变化后的格式平移、片段切分与外部输入校验
// 详见 docs/09-开发路线图.md

import { describe, test, expect } from 'vitest';
import {
  adjustMarksForTextChange,
  applyStylePatch,
  commonColor,
  isStyleActive,
  normalizeMarks,
  restoreLineBreaks,
  splitStyledRuns,
  toSingleLineText,
  type MindTextMark,
} from '@/features/mindmap/mindmapRichText';

describe('格式应用', () => {
  test('加粗区间并合并相邻同格式', () => {
    let marks = applyStylePatch(6, undefined, 0, 2, { type: 'toggle', key: 'bold' });
    marks = applyStylePatch(6, marks, 2, 4, { type: 'toggle', key: 'bold' });
    expect(marks).toEqual([{ start: 0, end: 4, bold: true }]);
  });

  test('区间已全部加粗时再次切换为取消', () => {
    const marks = applyStylePatch(6, [{ start: 0, end: 6, bold: true }], 2, 4, { type: 'toggle', key: 'bold' });
    expect(marks).toEqual([
      { start: 0, end: 2, bold: true },
      { start: 4, end: 6, bold: true },
    ]);
  });

  test('颜色与高亮可叠加，传 null 移除，clear 清空', () => {
    let marks = applyStylePatch(5, undefined, 0, 5, { type: 'color', key: 'color', value: '#ef4444' });
    marks = applyStylePatch(5, marks, 1, 3, { type: 'color', key: 'highlight', value: 'yellow' });
    expect(commonColor(5, marks, 1, 3, 'highlight')).toBe('yellow');
    expect(commonColor(5, marks, 0, 3, 'highlight')).toBeUndefined();
    expect(commonColor(5, marks, 0, 5, 'color')).toBe('#ef4444');
    marks = applyStylePatch(5, marks, 0, 5, { type: 'color', key: 'color', value: null });
    expect(marks).toEqual([{ start: 1, end: 3, highlight: 'yellow' }]);
    expect(applyStylePatch(5, marks, 0, 5, { type: 'clear' })).toEqual([]);
  });

  test('isStyleActive 要求区间内每个字符都具备', () => {
    const marks: MindTextMark[] = [{ start: 0, end: 3, italic: true }];
    expect(isStyleActive(5, marks, 0, 3, 'italic')).toBe(true);
    expect(isStyleActive(5, marks, 0, 4, 'italic')).toBe(false);
  });
});

describe('文本变化后的格式平移', () => {
  const marks: MindTextMark[] = [{ start: 2, end: 4, bold: true }];

  test('在格式区间之前插入文字，区间整体后移', () => {
    expect(adjustMarksForTextChange('abcdef', 'XXabcdef', marks)).toEqual([{ start: 4, end: 6, bold: true }]);
  });

  test('在格式区间内部插入文字，新字继承格式', () => {
    expect(adjustMarksForTextChange('abcdef', 'abcZZdef', marks)).toEqual([{ start: 2, end: 6, bold: true }]);
  });

  test('删除格式区间内的文字，区间收缩；全部删除后返回 undefined', () => {
    expect(adjustMarksForTextChange('abcdef', 'abdef', marks)).toEqual([{ start: 2, end: 3, bold: true }]);
    expect(adjustMarksForTextChange('abcdef', 'abef', marks)).toBeUndefined();
  });

  test('首尾空白裁剪', () => {
    expect(adjustMarksForTextChange('  ab', 'ab', [{ start: 2, end: 4, strike: true }])).toEqual([
      { start: 0, end: 2, strike: true },
    ]);
  });
});

describe('片段切分与校验', () => {
  test('按格式边界切分区间', () => {
    const runs = splitStyledRuns([{ start: 2, end: 4, bold: true }], 0, 6);
    expect(runs).toEqual([
      { start: 0, end: 2, style: {} },
      { start: 2, end: 4, style: { bold: true } },
      { start: 4, end: 6, style: {} },
    ]);
    expect(splitStyledRuns([{ start: 2, end: 4, bold: true }], 3, 5)).toEqual([
      { start: 3, end: 4, style: { bold: true } },
      { start: 4, end: 5, style: {} },
    ]);
  });

  test('外部输入的标记被裁剪到文本长度并过滤非法项', () => {
    const raw = [{ start: 1, end: 99, bold: true }, { start: 'x' }, null, { start: 0, end: 1, color: 5 }];
    expect(normalizeMarks(raw, 4)).toEqual([{ start: 1, end: 4, bold: true }]);
    expect(normalizeMarks([], 4)).toBeUndefined();
    expect(normalizeMarks([{ start: 0, end: 2, bold: true }], 0)).toBeUndefined();
  });
});

describe('单行输入框中的节点内换行', () => {
  test('换行显示为空格，未改动处的换行原样保留', () => {
    const original = 'ab\ncd\nef';
    expect(toSingleLineText(original)).toBe('ab cd ef');
    // 在末尾追加文字
    expect(restoreLineBreaks(original, 'ab cd efg')).toBe('ab\ncd\nefg');
    // 修改中间文字
    expect(restoreLineBreaks(original, 'ab cX ef')).toBe('ab\ncX\nef');
    // 删除换行处的空格即合并两行
    expect(restoreLineBreaks(original, 'abcd ef')).toBe('abcd\nef');
  });

  test('原文无换行时直接取新值', () => {
    expect(restoreLineBreaks('abc', 'abcd')).toBe('abcd');
  });
});
