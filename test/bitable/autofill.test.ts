// NoteBoard 多维表格自动补齐算法与矩阵平铺单元测试

import { describe, test, expect } from 'vitest';
import { calculateAutoFillValues, coerceCellValue, tileMatrix } from '@/features/bitable/bitableUtils';
import type { BitableColumn } from '@/features/bitable/bitableTypes';

const numCol: BitableColumn = { id: 'c_num', key: 'num', name: '数字', type: 'number' };
const textCol: BitableColumn = { id: 'c_text', key: 'text', name: '文本', type: 'text' };
const dateCol: BitableColumn = { id: 'c_date', key: 'date', name: '日期', type: 'date' };
const selectCol: BitableColumn = { id: 'c_select', key: 'select', name: '单选', type: 'select' };

describe('calculateAutoFillValues 自动补齐算法测试', () => {
  test('数字序列：双数字等差步长递增与递减', () => {
    // 递增 1, 2 -> 3, 4, 5
    expect(calculateAutoFillValues(numCol, [1, 2], 3, 'forward')).toEqual([3, 4, 5]);
    // 递减 10, 8 -> 6, 4
    expect(calculateAutoFillValues(numCol, [10, 8], 2, 'forward')).toEqual([6, 4]);
    // 反向向上填充 5, 6 前方 2 项 -> 3, 4
    expect(calculateAutoFillValues(numCol, [5, 6], 2, 'backward')).toEqual([3, 4]);
  });

  test('数字序列：单数字默认复制重复', () => {
    expect(calculateAutoFillValues(numCol, [42], 3, 'forward')).toEqual([42, 42, 42]);
  });

  test('文本数字后缀：单项自动递增 (如 任务 1 -> 任务 2, 任务 3)', () => {
    expect(calculateAutoFillValues(textCol, ['任务 1'], 3, 'forward')).toEqual([
      '任务 2',
      '任务 3',
      '任务 4',
    ]);
  });

  test('文本数字后缀：带前导零保持位数 (如 Item-01, Item-02 -> Item-03)', () => {
    expect(calculateAutoFillValues(textCol, ['Item-01', 'Item-02'], 2, 'forward')).toEqual([
      'Item-03',
      'Item-04',
    ]);
  });

  test('日期序列：按天自动递增', () => {
    expect(calculateAutoFillValues(dateCol, ['2026-08-30'], 3, 'forward')).toEqual([
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
  });

  test('日期序列：双日期等间隔步进', () => {
    expect(calculateAutoFillValues(dateCol, ['2026-08-01', '2026-08-03'], 2, 'forward')).toEqual([
      '2026-08-05',
      '2026-08-07',
    ]);
  });

  test('日期时间序列：带时间后缀保持时间并按天递增', () => {
    const dateTimeCol: BitableColumn = { id: 'c_dt', key: 'dt', name: '日期时间', type: 'dateTime' };
    expect(calculateAutoFillValues(dateTimeCol, ['2026-08-30 09:30:00'], 2, 'forward')).toEqual([
      '2026-08-31 09:30:00',
      '2026-09-01 09:30:00',
    ]);
  });

  test('单选/多选/无规律文本：周期循环填充', () => {
    expect(calculateAutoFillValues(selectCol, ['opt_a', 'opt_b'], 4, 'forward')).toEqual([
      'opt_a',
      'opt_b',
      'opt_a',
      'opt_b',
    ]);
  });
});

describe('coerceCellValue 选项兼容与归一化测试', () => {
  const optSelectCol: BitableColumn = {
    id: 'c_status',
    key: 'status',
    name: '状态',
    type: 'select',
    options: [
      { id: 'opt_done', label: '已完成', color: 'green' },
      { id: 'opt_todo', label: '待处理', color: 'blue' },
    ],
  };

  test('直接传入已存在的 option id 不应新建选项', () => {
    const res = coerceCellValue(optSelectCol, 'opt_done');
    expect(res.value).toBe('opt_done');
    expect(res.column).toBeNull();
  });

  test('传入选项 label 应正确匹配已有 option id', () => {
    const res = coerceCellValue(optSelectCol, '已完成');
    expect(res.value).toBe('opt_done');
    expect(res.column).toBeNull();
  });

  test('传入不存在的 label 时应自动新建选项并返回新 column', () => {
    const res = coerceCellValue(optSelectCol, '进行中');
    expect(typeof res.value).toBe('string');
    expect(res.column).not.toBeNull();
    expect(res.column?.options?.some((o) => o.label === '进行中')).toBe(true);
  });
});

describe('tileMatrix 矩阵平铺测试', () => {
  test('单值平铺为 2x3 矩阵', () => {
    expect(tileMatrix([['A']], 2, 3)).toEqual([
      ['A', 'A', 'A'],
      ['A', 'A', 'A'],
    ]);
  });

  test('2x2 矩阵平铺为 3x3 矩阵', () => {
    const src = [
      ['1', '2'],
      ['3', '4'],
    ];
    expect(tileMatrix(src, 3, 3)).toEqual([
      ['1', '2', '1'],
      ['3', '4', '3'],
      ['1', '2', '1'],
    ]);
  });
});
