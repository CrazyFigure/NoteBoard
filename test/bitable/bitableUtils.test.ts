// NoteBoard 多维表格通用工具单元测试
// 覆盖剪贴板矩阵解析、粘贴值类型归一（含标签自动创建）与展示格式化

import { describe, test, expect } from 'vitest';
import {
  createId,
  parseClipboardMatrix,
  coerceCellValue,
  formatCellValue,
  createRow,
  slotToSpliceIndex,
  slotToFinalPosition,
  isSlotNoop,
} from '@/features/bitable/bitableUtils';
import type { BitableColumn } from '@/features/bitable/bitableTypes';

/** 按游标语义模拟一次拖拽落库：先删除原元素，再插入到换算后的索引 */
function applyReorder<T>(list: T[], fromIdx: number, insertAt: number): T[] {
  const next = [...list];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(slotToSpliceIndex(insertAt, fromIdx), 0, moved);
  return next;
}

const textCol: BitableColumn = { id: 'c1', key: 'name', name: '名称', type: 'text' };
const selectCol: BitableColumn = {
  id: 'c2',
  key: 'status',
  name: '状态',
  type: 'select',
  options: [{ id: 'opt_done', label: '已完成', color: 'green' }],
};
const multiCol: BitableColumn = {
  id: 'c3',
  key: 'tags',
  name: '标签',
  type: 'multiSelect',
  options: [{ id: 'tag_a', label: '前端', color: 'blue' }],
};

describe('多维表格通用工具测试', () => {
  test('createId 在同一毫秒内批量创建也不会产生重复 ID', () => {
    const ids = new Set(Array.from({ length: 500 }, () => createId('row')));
    expect(ids.size).toBe(500);
  });

  test('parseClipboardMatrix 正确解析 TSV 多行多列并忽略末尾空行', () => {
    const matrix = parseClipboardMatrix('A1\tB1\nA2\tB2\n');
    expect(matrix).toEqual([
      ['A1', 'B1'],
      ['A2', 'B2'],
    ]);
  });

  test('parseClipboardMatrix 兼容 CSV 与双引号包裹的字段', () => {
    const matrix = parseClipboardMatrix('"含,逗号的值",第二列');
    expect(matrix).toEqual([['含,逗号的值', '第二列']]);
  });

  test('coerceCellValue 对单选字段：命中标签复用，未命中则创建新选项', () => {
    const hit = coerceCellValue(selectCol, '已完成');
    expect(hit.value).toBe('opt_done');
    expect(hit.column).toBeNull();

    const miss = coerceCellValue(selectCol, '已延期');
    expect(miss.column).not.toBeNull();
    expect(miss.column?.options?.length).toBe(2);
    // 返回值必须是新选项自身的 ID，否则单元格会指向不存在的标签
    const created = miss.column?.options?.[1];
    expect(miss.value).toBe(created?.id);
  });

  test('coerceCellValue 对多选字段：按中英文标点拆分且不破坏含空格的标签名', () => {
    const result = coerceCellValue(multiCol, '前端，高 P0');
    expect(result.column?.options?.length).toBe(2);
    expect(result.value).toHaveLength(2);
    expect(result.column?.options?.[1]?.label).toBe('高 P0');
  });

  test('coerceCellValue 对数字与进度字段做范围裁剪，对勾选做中文识别', () => {
    expect(coerceCellValue({ ...textCol, type: 'number' }, '42').value).toBe(42);
    expect(coerceCellValue({ ...textCol, type: 'progress' }, '180').value).toBe(100);
    expect(coerceCellValue({ ...textCol, type: 'checkbox' }, '是').value).toBe(true);
    expect(coerceCellValue({ ...textCol, type: 'checkbox' }, '否').value).toBe(false);
  });

  test('formatCellValue 输出标签文本而非内部 ID，空值输出空串', () => {
    expect(formatCellValue(selectCol, 'opt_done')).toBe('已完成');
    expect(formatCellValue(multiCol, ['tag_a'])).toBe('前端');
    expect(formatCellValue(textCol, null)).toBe('');
  });

  test('落点即所得：把第 1 列拖到任意槽位，结果位置必须与槽位一致', () => {
    const list = ['A', 'B', 'C', 'D'];
    // 槽位 2 = 「B 与 C 之间」，A 必须落在这里，而不是 C 的右侧
    expect(applyReorder(list, 0, 2)).toEqual(['B', 'A', 'C', 'D']);
    // 槽位 3 = 「C 与 D 之间」
    expect(applyReorder(list, 0, 3)).toEqual(['B', 'C', 'A', 'D']);
    // 槽位 4 = 末尾
    expect(applyReorder(list, 0, 4)).toEqual(['B', 'C', 'D', 'A']);
  });

  test('落点即所得：反向拖拽（从右往左）同样不错位', () => {
    const list = ['A', 'B', 'C', 'D'];
    // 把 D 拖到「A 与 B 之间」
    expect(applyReorder(list, 3, 1)).toEqual(['A', 'D', 'B', 'C']);
    // 把 C 拖到最前面
    expect(applyReorder(list, 2, 0)).toEqual(['C', 'A', 'B', 'D']);
  });

  test('落点提示序号与实际最终位置一致', () => {
    const list = ['A', 'B', 'C', 'D'];
    for (let from = 0; from < list.length; from += 1) {
      for (let slot = 0; slot <= list.length; slot += 1) {
        const moved = list[from];
        const result = applyReorder(list, from, slot);
        expect(result.indexOf(moved) + 1).toBe(slotToFinalPosition(slot, from));
      }
    }
  });

  test('落在自身左右两侧的槽位判定为空操作，不产生移动', () => {
    expect(isSlotNoop(2, 2)).toBe(true);
    expect(isSlotNoop(3, 2)).toBe(true);
    expect(isSlotNoop(1, 2)).toBe(false);
    expect(isSlotNoop(4, 2)).toBe(false);
  });

  test('createRow 按字段类型补齐默认值且 ID 唯一', () => {
    const columns = [textCol, { ...textCol, id: 'cp', type: 'progress' as const }, multiCol];
    const a = createRow(columns);
    const b = createRow(columns);
    expect(a.id).not.toBe(b.id);
    expect(a['cp']).toBe(0);
    expect(a['c3']).toEqual([]);
  });
});
