// NoteBoard 多维表格「拖拽换序」纯函数单元测试
// 覆盖树形行整棵子树搬迁、非法落点拦截与标签选项换序

import { describe, test, expect } from 'vitest';
import {
  collectDescendantRowIds,
  flattenTreeRowsFull,
  moveOptionByIndex,
  moveTreeRow,
} from '@/features/bitable/bitableUtils';
import type { BitableRow, SelectOption } from '@/features/bitable/bitableTypes';

/** 构造树形行：A 为顶层，A1/A2 为 A 的子行，A1a 为 A1 的子行，B 为另一个顶层行 */
function buildTree(): BitableRow[] {
  return [
    { id: 'A' },
    { id: 'A1', parentId: 'A' },
    { id: 'A1a', parentId: 'A1' },
    { id: 'A2', parentId: 'A' },
    { id: 'B' },
  ];
}

const ids = (rows: BitableRow[]) => rows.map((r) => r.id);

const opt = (id: string): SelectOption => ({ id, label: id, color: 'blue' });

describe('树形行拖拽换序', () => {
  test('flattenTreeRowsFull 按深度优先展开且忽略折叠状态', () => {
    const flat = flattenTreeRowsFull(buildTree());
    expect(flat.map((n) => n.row.id)).toEqual(['A', 'A1', 'A1a', 'A2', 'B']);
    expect(flat.map((n) => n.depth)).toEqual([0, 1, 2, 1, 0]);
  });

  test('移动顶层行时整棵子树一并搬迁', () => {
    // 把 A（含 A1/A1a/A2）拖到 B 之后
    const next = moveTreeRow(buildTree(), 'A', null, undefined);
    expect(ids(next)).toEqual(['B', 'A', 'A1', 'A1a', 'A2']);
  });

  test('插入到参照行之前时改写父级为参照行的父级', () => {
    // 把 B 拖到 A1 之前：B 应成为 A 的子行，且排在 A1 前面
    const next = moveTreeRow(buildTree(), 'B', 'A1', 'A');
    expect(ids(next)).toEqual(['A', 'B', 'A1', 'A1a', 'A2']);
    expect(next.find((r) => r.id === 'B')?.parentId).toBe('A');
  });

  test('把子行拖到顶层参照行之前会升级为顶层', () => {
    const next = moveTreeRow(buildTree(), 'A1', 'B', undefined);
    expect(ids(next)).toEqual(['A', 'A2', 'A1', 'A1a', 'B']);
    expect(next.find((r) => r.id === 'A1')?.parentId).toBeUndefined();
  });

  test('落点落在自身子树内部时判定非法并原样返回', () => {
    const original = buildTree();
    // A 不能插到自己的子行 A1 之前（参照行本身就在被搬走的子树里）
    expect(moveTreeRow(original, 'A', 'A1', undefined)).toBe(original);
    // A1 不能插到自己的后代 A1a 之前
    expect(moveTreeRow(original, 'A1', 'A1a', 'A1')).toBe(original);
    // A 不能成为自己后代的子行
    expect(moveTreeRow(original, 'A', 'A2', 'A1')).toBe(original);
  });

  test('被拖行不存在时原样返回，不产生脏数据', () => {
    const original = buildTree();
    expect(moveTreeRow(original, 'NOT_EXIST', null, undefined)).toBe(original);
  });

  test('移动到首行之前', () => {
    const next = moveTreeRow(buildTree(), 'B', 'A', undefined);
    expect(ids(next)).toEqual(['B', 'A', 'A1', 'A1a', 'A2']);
  });

  test('collectDescendantRowIds 递归收集全部后代且不含自身', () => {
    const rows = buildTree();
    expect(Array.from(collectDescendantRowIds(rows, 'A')).sort()).toEqual(['A1', 'A1a', 'A2']);
    expect(Array.from(collectDescendantRowIds(rows, 'A1'))).toEqual(['A1a']);
    expect(Array.from(collectDescendantRowIds(rows, 'B'))).toEqual([]);
  });
});

describe('标签选项换序（看板泳道换序）', () => {
  const options = [opt('o1'), opt('o2'), opt('o3'), opt('o4')];

  test('按「删除后插入索引」语义换序', () => {
    // 第 1 项移到末尾：删除后长度为 3，插入索引 3 即追加
    expect(moveOptionByIndex(options, 0, 3).map((o) => o.id)).toEqual(['o2', 'o3', 'o4', 'o1']);
    // 末项移到首位
    expect(moveOptionByIndex(options, 3, 0).map((o) => o.id)).toEqual(['o4', 'o1', 'o2', 'o3']);
    // 相邻交换
    expect(moveOptionByIndex(options, 1, 2).map((o) => o.id)).toEqual(['o1', 'o3', 'o2', 'o4']);
  });

  test('越界索引被夹取到两端，不会产生空洞', () => {
    expect(moveOptionByIndex(options, 1, 99).map((o) => o.id)).toEqual(['o1', 'o3', 'o4', 'o2']);
    expect(moveOptionByIndex(options, 1, -5).map((o) => o.id)).toEqual(['o2', 'o1', 'o3', 'o4']);
  });

  test('传入非法源索引时原样返回', () => {
    expect(moveOptionByIndex(options, 9, 0)).toBe(options);
    expect(moveOptionByIndex(options, -1, 0)).toBe(options);
  });
});
