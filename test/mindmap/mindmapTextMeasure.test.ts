// NoteBoard 思维导图文字测量与断行测试
// 覆盖中英文混排断行、超长单词拆分、行偏移与省略号截断
// 详见 docs/09-开发路线图.md

import { describe, test, expect } from 'vitest';
import {
  buildFont,
  clampNodeMaxWidth,
  ellipsizeLine,
  estimateTextWidth,
  wrapText,
  type TextMeasure,
} from '@/features/mindmap/mindmapTextMeasure';

/** 等宽测量：每个字符 10px，便于精确断言 */
const mono: TextMeasure = (text) => Array.from(text).length * 10;
const FONT = buildFont(12, 400, 'sans-serif');

describe('wrapText 断行', () => {
  test('中文逐字断行，行偏移可还原原文', () => {
    const text = '一二三四五六七八九十';
    const lines = wrapText(text, 40, mono, FONT);
    expect(lines.map((l) => l.text)).toEqual(['一二三四', '五六七八', '九十']);
    for (const line of lines) {
      expect(text.slice(line.start, line.start + line.text.length)).toBe(line.text);
    }
  });

  test('英文按单词换行，行首空白被吞掉', () => {
    const lines = wrapText('hello world foo', 60, mono, FONT);
    expect(lines.map((l) => l.text)).toEqual(['hello', 'world', 'foo']);
    expect(lines[1].start).toBe(6);
  });

  test('超长单词按字符拆分', () => {
    const lines = wrapText('abcdefghij', 40, mono, FONT);
    expect(lines.map((l) => l.text)).toEqual(['abcd', 'efgh', 'ij']);
  });

  test('中英文混排', () => {
    const lines = wrapText('中文abc测试', 50, mono, FONT);
    expect(lines.map((l) => l.text).join('')).toBe('中文abc测试');
    for (const line of lines) expect(mono(line.text, FONT)).toBeLessThanOrEqual(50);
  });

  test('空文本返回一个空行', () => {
    expect(wrapText('', 100, mono, FONT)).toEqual([{ text: '', start: 0 }]);
  });

  test('手动换行为硬换行，空段落保留为空行，行偏移指向原文', () => {
    const lines = wrapText('ab\n\ncdefgh\n', 40, mono, FONT);
    expect(lines).toEqual([
      { text: 'ab', start: 0 },
      { text: '', start: 3 },
      { text: 'cdef', start: 4 },
      { text: 'gh', start: 8 },
      { text: '', start: 11 },
    ]);
  });
});

describe('辅助函数', () => {
  test('估算测量：全角字符 1em，半角 0.6em', () => {
    expect(estimateTextWidth('中', buildFont(10, 400, 'x'))).toBe(10);
    expect(estimateTextWidth('ab', buildFont(10, 400, 'x'))).toBeCloseTo(12);
  });

  test('省略号截断不超过最大宽度', () => {
    const result = ellipsizeLine('一二三四五六', 40, mono, FONT);
    expect(result.endsWith('…')).toBe(true);
    expect(mono(result, FONT)).toBeLessThanOrEqual(40);
  });

  test('宽度设置收敛到合法范围', () => {
    expect(clampNodeMaxWidth(undefined)).toBe(280);
    expect(clampNodeMaxWidth(50)).toBe(160);
    expect(clampNodeMaxWidth(9999)).toBe(600);
    expect(clampNodeMaxWidth(333.6)).toBe(334);
  });
});
