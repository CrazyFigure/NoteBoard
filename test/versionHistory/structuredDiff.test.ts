// NoteBoard 思维导图、多维表格与画板差异测试

import { describe, expect, it } from 'vitest';
import { diffMindmaps } from '../../src/features/versionHistory/diff/mindmapDiff';
import { diffBitables } from '../../src/features/versionHistory/diff/bitableDiff';
import type { MindNode } from '../../src/features/mindmap/mindmapTypes';
import type { BitableDocument } from '../../src/features/bitable/bitableTypes';
import { diffBoards, GHOST_SUFFIX } from '../../src/features/versionHistory/diff/boardDiff';
import type { ExcalidrawScene, ExcalidrawElement } from '../../src/features/board/sceneIo';

const n = (id: string, text: string, children: MindNode[] = [], extra: Partial<MindNode> = {}): MindNode => ({ id, text, children, ...extra });

describe('diffMindmaps', () => {
  it('区分新增、修改、移动与删除，删除的子树挂回原父节点', () => {
    const base = n('r', '根', [n('a', 'A', [n('a1', 'A1')]), n('b', 'B'), n('c', 'C', [n('c1', 'C1')])]);
    const next = n('r', '根', [n('b', 'B'), n('a', 'A 改', [n('new', '新')]), n('c1', 'C1')], {});
    const r = diffMindmaps(base, next);
    expect(r.marks.get('a')).toBe('mod');
    expect(r.marks.get('new')).toBe('ins');
    expect(r.marks.get('a1')).toBe('del');
    expect(r.marks.get('c')).toBe('del');
    expect(r.marks.get('c1')).toBe('moved');
    // a1 作为幽灵节点挂回 a 下；c 挂回根节点，其仍存在的子节点 c1 不重复出现
    const a = r.root.children.find((x) => x.id === 'a')!;
    expect(a.children.map((x) => x.id)).toContain('a1');
    const c = r.root.children.find((x) => x.id === 'c')!;
    expect(c.children).toEqual([]);
    expect(r.changes.find((x) => x.id === 'a')?.oldText).toBe('A');
  });

  it('改动所在的折叠分支被展开；无对比版本时没有改动', () => {
    const base = n('r', '根', [n('a', 'A', [n('x', 'X')], { isExpanded: false })]);
    const next = n('r', '根', [n('a', 'A', [n('x', 'X 改')], { isExpanded: false })]);
    const r = diffMindmaps(base, next);
    expect(r.root.children[0].isExpanded).toBe(true);
    expect(diffMindmaps(null, next).changes).toEqual([]);
  });
});

describe('diffBitables', () => {
  const col = (id: string, name: string, type = 'text') => ({ id, key: id, name, type }) as BitableDocument['columns'][number];
  const doc = (columns: BitableDocument['columns'], rows: BitableDocument['rows'], title = '表'): BitableDocument => ({
    schemaVersion: 1, title, columns, rows, views: [],
  });

  it('按 id 对齐列与行，记录修改的单元格，删除项保留在原位置', () => {
    const base = doc([col('c1', '名称'), col('c2', '状态'), col('c3', '备注')], [
      { id: 'r1', c1: '甲', c2: '进行中' },
      { id: 'r2', c1: '乙', c2: '完成' },
      { id: 'r3', c1: '丙' },
    ]);
    const next = doc([col('c1', '名称'), col('c2', '阶段'), col('c4', '负责人')], [
      { id: 'r1', c1: '甲', c2: '完成' },
      { id: 'r3', c1: '丙' },
      { id: 'r4', c1: '丁' },
    ], '新表');
    const r = diffBitables(base, next);
    expect(r.columns.map((c) => `${c.column.id}:${c.kind}`)).toEqual(['c1:same', 'c2:mod', 'c3:del', 'c4:ins']);
    expect(r.rows.map((x) => `${x.row.id}:${x.kind}`)).toEqual(['r1:mod', 'r2:del', 'r3:same', 'r4:ins']);
    expect([...r.rows[0].changedCells]).toEqual(['c2']);
    expect(r.notes).toContain('表名：表 → 新表');
    expect(r.changed).toBe(true);
  });

  it('只调整顺序的行标记为移动，调整列宽不算修改', () => {
    const base = doc([{ ...col('c1', '名称'), width: 100 }], [{ id: 'a', c1: '1' }, { id: 'b', c1: '2' }]);
    const next = doc([{ ...col('c1', '名称'), width: 240 }], [{ id: 'b', c1: '2' }, { id: 'a', c1: '1' }]);
    const r = diffBitables(base, next);
    expect(r.columns[0].kind).toBe('same');
    expect(r.rows.map((x) => x.kind).filter((k) => k !== 'same')).toEqual(['moved']);
  });
});

describe('diffBoards', () => {
  const el = (id: string, extra: Partial<ExcalidrawElement> = {}) =>
    ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, seed: 1, updated: 1, isDeleted: false, opacity: 100, groupIds: [], ...extra }) as ExcalidrawElement;
  const scene = (elements: ExcalidrawElement[]): ExcalidrawScene => ({ type: 'excalidraw', version: 2, source: '', elements, appState: { viewBackgroundColor: '#fff', gridSize: null } });

  it('忽略版本号变化，识别新增 / 修改 / 删除，删除项保留为幽灵副本', () => {
    const base = scene([el('a'), el('b', { x: 5 }), el('c', { y: 50 })]);
    const next = scene([el('a', { version: 9, seed: 7 }), el('b', { x: 99 }), el('d', { y: 80 })]);
    const r = diffBoards(base, next);
    expect(r.changes.map((c) => `${c.id}:${c.kind}`)).toEqual(['b:mod', `c${GHOST_SUFFIX}:del`, 'd:ins']);
    const ghost = r.elements.find((e) => e.id === `c${GHOST_SUFFIX}`)!;
    expect(ghost.locked).toBe(true);
    expect(ghost.opacity).toBe(35);
  });

  it('容器内文字的修改并入容器', () => {
    const base = scene([el('box'), el('t', { type: 'text', text: '旧', containerId: 'box' })]);
    const next = scene([el('box'), el('t', { type: 'text', text: '新', containerId: 'box' })]);
    const r = diffBoards(base, next);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].id).toBe('box');
    expect(r.changes[0].label).toBe('修改矩形：新');
  });
});
