// NoteBoard 多维表格标签颜色单元测试
// 覆盖两件事：色板与颜色类型枚举必须一一对应；历史遗留颜色 id 的归一与兜底

import { describe, test, expect } from 'vitest';
import { BITABLE_PALETTE, getOptionColor } from '@/features/bitable/bitableConverter';

/** 与 SelectOptionColor 联合类型保持同步的颜色 id 清单 */
const COLOR_IDS = ['blue', 'green', 'purple', 'amber', 'red', 'cyan', 'pink', 'gray'];

describe('Bitable 标签颜色', () => {
  test('色板 id 与颜色类型枚举完全对齐', () => {
    // 色板多一个 / 少一个都会让某个颜色取不到值，最终静默回落成蓝色
    expect(BITABLE_PALETTE.map((c) => c.id)).toEqual(COLOR_IDS);
  });

  test('每个色板颜色都能取回自身配置', () => {
    for (const id of COLOR_IDS) {
      expect(getOptionColor(id).id).toBe(id);
      // 三色齐全，标签胶囊渲染样式依赖它们
      const color = getOptionColor(id);
      expect(color.bg).toMatch(/^#[0-9a-f]{6}$/i);
      expect(color.text).toMatch(/^#[0-9a-f]{6}$/i);
      expect(color.border).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test('历史颜色 id "orange" 归一到 amber，而不是静默变成蓝色', () => {
    expect(getOptionColor('orange').id).toBe('amber');
  });

  test('未知颜色与空值回落首个色板颜色', () => {
    expect(getOptionColor('chartreuse').id).toBe('blue');
    expect(getOptionColor(undefined).id).toBe('blue');
    expect(getOptionColor('').id).toBe('blue');
  });
});
