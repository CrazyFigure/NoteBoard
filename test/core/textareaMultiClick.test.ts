// NoteBoard 多行文本框双击 / 三击选区修正测试
// 输入均为 Chromium 原生双击 / 三击后的实测选区

import { describe, test, expect } from 'vitest';
import { correctMultiClickRange } from '../../src/core/textareaMultiClick';

const VALUE = '第一行文字内容\nsecond line here\n\n第四行 after empty\n最后一行';

describe('correctMultiClickRange', () => {
  test('行尾右侧双击选中换行时，改选行尾最后一个词', () => {
    // 原生结果："\n" [7,8]
    expect(correctMultiClickRange(VALUE, { start: 7, end: 8 }, 2)).toEqual({ start: 5, end: 7 });
    // 原生结果："\n" [24,25]，行尾词为 here
    expect(correctMultiClickRange(VALUE, { start: 24, end: 25 }, 2)).toEqual({ start: 20, end: 24 });
  });

  test('空行双击只放置光标', () => {
    expect(correctMultiClickRange(VALUE, { start: 25, end: 26 }, 2)).toEqual({ start: 25, end: 25 });
  });

  test('行尾是空格时只放置光标', () => {
    expect(correctMultiClickRange('abc  \nnext', { start: 3, end: 6 }, 2)).toEqual({ start: 5, end: 5 });
  });

  test('三击去掉行尾换行，空行折叠为光标', () => {
    expect(correctMultiClickRange(VALUE, { start: 0, end: 8 }, 3)).toEqual({ start: 0, end: 7 });
    expect(correctMultiClickRange(VALUE, { start: 25, end: 26 }, 3)).toEqual({ start: 25, end: 25 });
  });

  test('选区不含换行时不修正', () => {
    expect(correctMultiClickRange(VALUE, { start: 3, end: 5 }, 2)).toBeNull();
    // 最后一行没有行尾换行
    expect(correctMultiClickRange(VALUE, { start: 42, end: 46 }, 3)).toBeNull();
  });
});
