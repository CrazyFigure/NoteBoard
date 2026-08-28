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
  resolveGroupKey,
  groupFlatTreeRows,
  compareRowsBySortRules,
  getSortDirectionLabels,
} from '@/features/bitable/bitableUtils';
import type { BitableColumn, BitableRow } from '@/features/bitable/bitableTypes';

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

  test('resolveGroupKey 对空列返回未指定占位', () => {
    const row: BitableRow = { id: 'r1', c1: '内容' };
    expect(resolveGroupKey(row, undefined)).toEqual({ key: '__empty__', label: '未指定' });
  });

  test('resolveGroupKey 对文本字段按字符串分组', () => {
    const row: BitableRow = { id: 'r1', c1: 'Alice' };
    expect(resolveGroupKey(row, textCol)).toEqual({ key: 'Alice', label: 'Alice' });
  });

  test('resolveGroupKey 对空文本字段返回未指定占位', () => {
    const row: BitableRow = { id: 'r1', c1: '' };
    expect(resolveGroupKey(row, textCol)).toEqual({ key: '__empty__', label: '未指定' });
  });

  test('resolveGroupKey 对单选字段返回选项标签与颜色', () => {
    const row: BitableRow = { id: 'r1', c2: 'opt_done' };
    expect(resolveGroupKey(row, selectCol)).toEqual({ key: 'opt_done', label: '已完成', color: 'green' });
  });

  test('resolveGroupKey 对多选字段取首个选项并返回其颜色', () => {
    const col: BitableColumn = {
      ...multiCol,
      options: [
        { id: 'tag_a', label: '前端', color: 'blue' },
        { id: 'tag_b', label: '后端', color: 'purple' },
      ],
    };
    const row: BitableRow = { id: 'r1', c3: ['tag_b', 'tag_a'] };
    expect(resolveGroupKey(row, col)).toEqual({ key: 'tag_b', label: '后端', color: 'purple' });
  });

  test('resolveGroupKey 对未选择的多选字段返回未指定占位', () => {
    const row: BitableRow = { id: 'r1', c3: [] };
    expect(resolveGroupKey(row, multiCol)).toEqual({ key: '__empty__', label: '未指定' });
  });

  test('groupFlatTreeRows 按文本列分组并保持组内顺序，空值组排在最后', () => {
    const flatRows = [
      { row: { id: 'r1', c1: 'Bob' } as BitableRow, depth: 0, hasChildren: false, isCollapsed: false, rowNumber: 1 },
      { row: { id: 'r2', c1: 'Alice' } as BitableRow, depth: 0, hasChildren: false, isCollapsed: false, rowNumber: 2 },
      { row: { id: 'r3', c1: 'Bob' } as BitableRow, depth: 0, hasChildren: false, isCollapsed: false, rowNumber: 3 },
      { row: { id: 'r4', c1: '' } as BitableRow, depth: 0, hasChildren: false, isCollapsed: false, rowNumber: 4 },
    ];
    const groups = groupFlatTreeRows(flatRows, textCol);
    expect(groups.map((g) => g.meta.label)).toEqual(['Alice', 'Bob', '未指定']);
    expect(groups.map((g) => g.rows.length)).toEqual([1, 2, 1]);
    expect(groups[1].rows.map((n) => n.row.id)).toEqual(['r1', 'r3']);
  });

  test('groupFlatTreeRows 对单选列按选项标签自然序排序', () => {
    const col: BitableColumn = {
      id: 'c2',
      key: 'status',
      name: '状态',
      type: 'select',
      options: [
        { id: 'opt_done', label: '已完成', color: 'green' },
        { id: 'opt_todo', label: '未开始', color: 'gray' },
        { id: 'opt_doing', label: '进行中', color: 'blue' },
      ],
    };
    const flatRows = [
      { row: { id: 'r1', c2: 'opt_done' } as BitableRow, depth: 0, hasChildren: false, isCollapsed: false, rowNumber: 1 },
      { row: { id: 'r2', c2: 'opt_todo' } as BitableRow, depth: 0, hasChildren: false, isCollapsed: false, rowNumber: 2 },
      { row: { id: 'r3', c2: 'opt_doing' } as BitableRow, depth: 0, hasChildren: false, isCollapsed: false, rowNumber: 3 },
    ];
    const groups = groupFlatTreeRows(flatRows, col);
    expect(groups.map((g) => g.meta.label)).toEqual(['进行中', '未开始', '已完成']);
  });

  test('groupFlatTreeRows 对未分组列返回按原顺序的单组', () => {
    const flatRows = [
      { row: { id: 'r1', c1: 'Bob' } as BitableRow, depth: 0, hasChildren: false, isCollapsed: false, rowNumber: 1 },
      { row: { id: 'r2', c1: 'Alice' } as BitableRow, depth: 0, hasChildren: false, isCollapsed: false, rowNumber: 2 },
    ];
    const groups = groupFlatTreeRows(flatRows, undefined);
    expect(groups).toHaveLength(1);
    expect(groups[0].meta.label).toBe('未指定');
    expect(groups[0].rows).toHaveLength(2);
  });

  test('compareRowsBySortRules 支持多字段联合排序', () => {
    const numberCol: BitableColumn = { id: 'cn', key: 'priority', name: '优先级', type: 'number' };
    const nameCol: BitableColumn = { id: 'c1', key: 'name', name: '名称', type: 'text' };
    const columns = [nameCol, numberCol];
    const rows: BitableRow[] = [
      { id: 'r1', c1: 'B', cn: 2 },
      { id: 'r2', c1: 'A', cn: 2 },
      { id: 'r3', c1: 'A', cn: 1 },
      { id: 'r4', c1: 'B', cn: 1 },
    ];
    const rules = [
      { columnId: 'cn', direction: 'asc' as const },
      { columnId: 'c1', direction: 'asc' as const },
    ];
    const sorted = [...rows].sort((a, b) => compareRowsBySortRules(a, b, columns, rules));
    expect(sorted.map((r) => r.id)).toEqual(['r3', 'r4', 'r2', 'r1']);
  });

  test('compareRowsBySortRules 空值始终后置', () => {
    const col: BitableColumn = { id: 'c1', key: 'name', name: '名称', type: 'text' };
    const rows: BitableRow[] = [
      { id: 'r1', c1: '' },
      { id: 'r2', c1: 'Apple' },
      { id: 'r3', c1: null as unknown as string },
    ];
    const sorted = [...rows].sort((a, b) => compareRowsBySortRules(a, b, [col], [{ columnId: 'c1', direction: 'asc' }]));
    expect(sorted[0].id).toBe('r2');
    expect(sorted.slice(1).map((r) => r.id).sort()).toEqual(['r1', 'r3']);
  });

  test('getSortDirectionLabels 按字段类型返回专有文案', () => {
    expect(getSortDirectionLabels('number')).toEqual({ asc: '0 → 9', desc: '9 → 0' });
    expect(getSortDirectionLabels('date')).toEqual({ asc: '最早的日期 → 最晚', desc: '最晚的日期 → 最早' });
    expect(getSortDirectionLabels('checkbox')).toEqual({ asc: '未勾选 → 勾选', desc: '勾选 → 未勾选' });
    expect(getSortDirectionLabels('select')).toEqual({ asc: '选项顺序', desc: '选项逆序' });
    expect(getSortDirectionLabels('text')).toEqual({ asc: 'A → Z', desc: 'Z → A' });
  });
});
