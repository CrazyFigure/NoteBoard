// NoteBoard 多维表格数据模型转换与持久化单元测试

import { describe, test, expect } from 'vitest';
import {
  createDefaultBitableDocument,
  parseBitableDocument,
  serializeBitableDocument,
  exportBitableToCsv,
} from '@/features/bitable/bitableConverter';
import type { BitableDocument } from '@/features/bitable/bitableTypes';

describe('Bitable 多维表格转换与序列化测试', () => {
  test('createDefaultBitableDocument 生成完备的默认模板与多视图', () => {
    const doc = createDefaultBitableDocument('测试看板');
    expect(doc.schemaVersion).toBe(1);
    expect(doc.title).toBe('测试看板');
    expect(doc.columns.length).toBeGreaterThanOrEqual(5);
    expect(doc.rows.length).toBeGreaterThanOrEqual(4);
    // 默认包含子行
    expect(doc.rows.some((r) => r.parentId !== undefined)).toBe(true);
    // 默认包含多个看板视图
    expect(doc.views.length).toBeGreaterThanOrEqual(3);
    expect(doc.views.some((v) => v.type === 'grid')).toBe(true);
    expect(doc.views.filter((v) => v.type === 'kanban').length).toBeGreaterThanOrEqual(2);
  });

  test('JSON 双向序列化与反序列化保真（包含 parentId 与多视图）', () => {
    const original = createDefaultBitableDocument('项目进度跟踪');
    const json = serializeBitableDocument(original);
    const parsed = parseBitableDocument(json);

    expect(parsed.title).toBe(original.title);
    expect(parsed.columns.length).toBe(original.columns.length);
    expect(parsed.rows.length).toBe(original.rows.length);
    expect(parsed.views.length).toBe(original.views.length);
    expect(parsed.columns[0].name).toBe(original.columns[0].name);
    // 子行 parentId 保真
    const subRow = parsed.rows.find((r) => r.id === 'row_1_1');
    expect(subRow?.parentId).toBe('row_1');
  });

  test('非法 JSON 与空字符串安全容错回退', () => {
    const emptyDoc = parseBitableDocument('');
    expect(emptyDoc).toBeDefined();
    expect(emptyDoc.columns.length).toBeGreaterThan(0);

    const invalidDoc = parseBitableDocument('{ invalid json content ...');
    expect(invalidDoc).toBeDefined();
    expect(invalidDoc.schemaVersion).toBe(1);
  });

  test('exportBitableToCsv 正确导出带引号与逗号分隔的 CSV 格式', () => {
    const doc: BitableDocument = {
      schemaVersion: 1,
      title: '导出测试',
      columns: [
        { id: 'c1', key: 'title', name: '任务标题', type: 'text' },
        {
          id: 'c2',
          key: 'status',
          name: '状态',
          type: 'select',
          options: [{ id: 'opt1', label: '进行中', color: 'blue' }],
        },
      ],
      rows: [
        { id: 'r1', c1: '编写测试用例', c2: 'opt1' },
      ],
      views: [{ id: 'v1', name: '表格', type: 'grid' }],
    };

    const csv = exportBitableToCsv(doc);
    expect(csv).toContain('"任务标题","状态"');
    expect(csv).toContain('"编写测试用例","进行中"');
  });
});
