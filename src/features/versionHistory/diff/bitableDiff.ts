// NoteBoard 文档历史记录：多维表格差异（按列 id / 行 id，纯函数）
//
//   - 列：新增 / 删除 / 修改（改名、改类型、选项变化）；删除的列保留在原位置
//   - 行：新增 / 删除 / 修改（记录哪些单元格变化）/ 移动；删除的行保留在原位置
//   - 表名、视图等其他变化以文字列出
// 「显示更改」关闭时只显示新版本的列与行。

import type { BitableColumn, BitableDocument, BitableRow } from '../../bitable/bitableTypes';
import { areCellValuesEqual } from '../../bitable/bitableUtils';
import { diffSequences } from './seqDiff';

export type TableDiffKind = 'same' | 'ins' | 'del' | 'mod' | 'moved';

export interface ColumnDiff {
  column: BitableColumn;
  kind: TableDiffKind;
  /** 修改前的列（改名 / 改类型时用于显示旧值） */
  old?: BitableColumn;
}

export interface RowDiff {
  row: BitableRow;
  kind: TableDiffKind;
  old?: BitableRow;
  /** 值有变化的列 id */
  changedCells: Set<string>;
}

export interface BitableDiffResult {
  columns: ColumnDiff[];
  rows: RowDiff[];
  /** 其他变化说明（表名、视图） */
  notes: string[];
  changed: boolean;
}

/** 列定义比较（不含宽度：调整列宽不算修改） */
function columnKey(c: BitableColumn): string {
  const { width: _w, ...rest } = c;
  return JSON.stringify(rest);
}

/** 按 id 对齐两组有序元素，删除项保留在原位置 */
function alignById<T extends { id: string }>(as: T[], bs: T[]): Array<{ a?: T; b?: T; moved: boolean }> {
  const ops = diffSequences(as.map((x) => x.id), bs.map((x) => x.id)) ?? [
    ...as.map((_, i) => ({ type: 'del' as const, a: i })),
    ...bs.map((_, i) => ({ type: 'ins' as const, b: i })),
  ];
  const inA = new Map(as.map((x) => [x.id, x]));
  const inB = new Set(bs.map((x) => x.id));
  const out: Array<{ a?: T; b?: T; moved: boolean }> = [];
  for (const op of ops) {
    if (op.type === 'equal') out.push({ a: as[op.a!], b: bs[op.b!], moved: false });
    else if (op.type === 'del') {
      // 只是换了位置：在新位置展示
      if (!inB.has(as[op.a!].id)) out.push({ a: as[op.a!], moved: false });
    } else {
      const b = bs[op.b!];
      const a = inA.get(b.id);
      out.push(a ? { a, b, moved: true } : { b, moved: false });
    }
  }
  return out;
}

export function diffBitables(base: BitableDocument | null, target: BitableDocument): BitableDiffResult {
  if (!base) {
    return {
      columns: target.columns.map((column) => ({ column, kind: 'same' })),
      rows: target.rows.map((row) => ({ row, kind: 'same', changedCells: new Set() })),
      notes: [],
      changed: false,
    };
  }
  const columns: ColumnDiff[] = alignById(base.columns, target.columns).map(({ a, b }) => {
    if (a && b) return { column: b, old: a, kind: columnKey(a) === columnKey(b) ? 'same' : 'mod' };
    return b ? { column: b, kind: 'ins' } : { column: a!, kind: 'del' };
  });
  // 单元格比较只针对两版都存在的列（行数据以列 id 为键）
  const shared = columns.filter((c) => c.old && c.kind !== 'del');
  const rows: RowDiff[] = alignById(base.rows, target.rows).map(({ a, b, moved }) => {
    if (a && b) {
      const changedCells = new Set<string>();
      for (const c of shared) {
        if (!areCellValuesEqual(a[c.old!.id], b[c.column.id])) changedCells.add(c.column.id);
      }
      const parentChanged = (a.parentId ?? null) !== (b.parentId ?? null);
      const kind: TableDiffKind = changedCells.size > 0 ? 'mod' : moved || parentChanged ? 'moved' : 'same';
      return { row: b, old: a, kind, changedCells };
    }
    return b ? { row: b, kind: 'ins', changedCells: new Set() } : { row: a!, kind: 'del', changedCells: new Set() };
  });
  const notes: string[] = [];
  if (base.title !== target.title) notes.push(`表名：${base.title} → ${target.title}`);
  if ((base.description ?? '') !== (target.description ?? '')) notes.push('修改了表格说明');
  const viewKey = (d: BitableDocument) => JSON.stringify(d.views ?? []);
  if (viewKey(base) !== viewKey(target)) notes.push('调整了视图设置');
  const changed = notes.length > 0 || columns.some((c) => c.kind !== 'same') || rows.some((r) => r.kind !== 'same');
  return { columns, rows, notes, changed };
}
