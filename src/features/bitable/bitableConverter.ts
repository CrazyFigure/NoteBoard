// NoteBoard 多维表格序列化、解析与数据转换器
// 支持 JSON 双向解析、CSV 导出与默认精选项目管理模板构建

import type { BitableDocument, BitableColumn, BitableRow, BitableViewConfig } from './bitableTypes';

/** 飞书风格标准颜色清单 */
export const BITABLE_PALETTE: Array<{ id: string; label: string; bg: string; text: string; border: string }> = [
  { id: 'blue', label: '沉稳蓝', bg: '#eff6ff', text: '#2563eb', border: '#bfdbfe' },
  { id: 'green', label: '清新绿', bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0' },
  { id: 'purple', label: '优雅紫', bg: '#faf5ff', text: '#9333ea', border: '#e9d5ff' },
  { id: 'amber', label: '活力橙', bg: '#fffbeb', text: '#d97706', border: '#fde68a' },
  { id: 'red', label: '警示红', bg: '#fef2f2', text: '#dc2626', border: '#fecaca' },
  { id: 'cyan', label: '湖水青', bg: '#ecfeff', text: '#0891b2', border: '#a5f3fc' },
  { id: 'pink', label: '浪漫粉', bg: '#fdf2f8', text: '#db2777', border: '#fbcfe8' },
  { id: 'gray', label: '中性灰', bg: '#f8fafc', text: '#475569', border: '#cbd5e1' },
];

/** 获取标签颜色配置 */
export function getOptionColor(colorName?: string) {
  const found = BITABLE_PALETTE.find((c) => c.id === colorName);
  return found || BITABLE_PALETTE[0];
}

/** 生成默认开箱即用的多维表格示例（项目任务跟踪） */
export function createDefaultBitableDocument(title = '项目与任务管理多维表格'): BitableDocument {
  const columns: BitableColumn[] = [
    {
      id: 'col_name',
      key: 'name',
      name: '任务名称',
      type: 'text',
      width: 240,
    },
    {
      id: 'col_status',
      key: 'status',
      name: '当前状态',
      type: 'select',
      width: 140,
      options: [
        { id: 'opt_todo', label: '未开始', color: 'gray' },
        { id: 'opt_doing', label: '进行中', color: 'blue' },
        { id: 'opt_review', label: '审核中', color: 'amber' },
        { id: 'opt_done', label: '已完成', color: 'green' },
      ],
    },
    {
      id: 'col_priority',
      key: 'priority',
      name: '优先级',
      type: 'select',
      width: 120,
      options: [
        { id: 'p_p0', label: '高 P0', color: 'red' },
        { id: 'p_p1', label: '中 P1', color: 'amber' },
        { id: 'p_p2', label: '低 P2', color: 'gray' },
      ],
    },
    {
      id: 'col_assignee',
      key: 'assignee',
      name: '负责人',
      type: 'text',
      width: 130,
    },
    {
      id: 'col_dueDate',
      key: 'dueDate',
      name: '截止日期',
      type: 'date',
      width: 140,
    },
    {
      id: 'col_progress',
      key: 'progress',
      name: '完成进度',
      type: 'progress',
      width: 150,
    },
    {
      id: 'col_rating',
      key: 'rating',
      name: '重要度',
      type: 'rating',
      width: 130,
    },
  ];

  const rows: BitableRow[] = [
    {
      id: 'row_1',
      col_name: '设计多维表格整体交互体验',
      col_status: 'opt_done',
      col_priority: 'p_p0',
      col_assignee: '产品体验组',
      col_dueDate: '2026-08-28',
      col_progress: 100,
      col_rating: 5,
    },
    {
      id: 'row_1_1',
      parentId: 'row_1',
      col_name: '设计单选/多选马卡龙标签面板',
      col_status: 'opt_done',
      col_priority: 'p_p0',
      col_assignee: 'UI 设计师',
      col_dueDate: '2026-08-28',
      col_progress: 100,
      col_rating: 5,
    },
    {
      id: 'row_2',
      col_name: '实现飞书风格单元格与标签选择器',
      col_status: 'opt_doing',
      col_priority: 'p_p0',
      col_assignee: '前端研发',
      col_dueDate: '2026-08-29',
      col_progress: 75,
      col_rating: 5,
    },
    {
      id: 'row_3',
      col_name: '实现看板视图与多维度切换',
      col_status: 'opt_doing',
      col_priority: 'p_p1',
      col_assignee: '核心架构',
      col_dueDate: '2026-08-30',
      col_progress: 40,
      col_rating: 4,
    },
    {
      id: 'row_4',
      col_name: '单测覆盖率校验与发布验证',
      col_status: 'opt_todo',
      col_priority: 'p_p1',
      col_assignee: 'QA 质量组',
      col_dueDate: '2026-08-31',
      col_progress: 0,
      col_rating: 4,
    },
  ];

  const views: BitableViewConfig[] = [
    {
      id: 'view_grid',
      name: '全部任务表格',
      type: 'grid',
    },
    {
      id: 'view_kanban_status',
      name: '按状态看板',
      type: 'kanban',
      groupByColumnId: 'col_status',
    },
    {
      id: 'view_kanban_priority',
      name: '按优先级看板',
      type: 'kanban',
      groupByColumnId: 'col_priority',
    },
  ];

  return {
    schemaVersion: 1,
    title,
    columns,
    rows,
    views,
    activeViewId: 'view_grid',
  };
}

/** 解析多维表格 JSON 文档，具备完备的容错与升级兼容机制 */
export function parseBitableDocument(content: string): BitableDocument {
  const trimmed = content.trim();
  if (!trimmed) {
    return createDefaultBitableDocument();
  }

  try {
    const obj = JSON.parse(trimmed) as Partial<BitableDocument>;
    if (!obj || typeof obj !== 'object') {
      return createDefaultBitableDocument();
    }

    const columns: BitableColumn[] = Array.isArray(obj.columns) && obj.columns.length > 0
      ? obj.columns
      : createDefaultBitableDocument().columns;

    const rows: BitableRow[] = Array.isArray(obj.rows) ? obj.rows : [];

    const views: BitableViewConfig[] = Array.isArray(obj.views) && obj.views.length > 0
      ? obj.views
      : createDefaultBitableDocument().views;

    return {
      schemaVersion: typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1,
      title: typeof obj.title === 'string' && obj.title.trim() ? obj.title : '未命名多维表格',
      description: typeof obj.description === 'string' ? obj.description : undefined,
      columns,
      rows,
      views,
      activeViewId: typeof obj.activeViewId === 'string' ? obj.activeViewId : views[0]?.id || 'view_grid',
    };
  } catch (e) {
    console.error('多维表格 JSON 解析容错回退:', e);
    return createDefaultBitableDocument();
  }
}

/** 将多维表格数据模型序列化为格式化 JSON 文本 */
export function serializeBitableDocument(doc: BitableDocument): string {
  return JSON.stringify(doc, null, 2);
}

/** 导出多维表格为 CSV 文本格式 */
export function exportBitableToCsv(doc: BitableDocument): string {
  const headers = doc.columns.map((col) => `"${col.name.replace(/"/g, '""')}"`).join(',');
  const rowLines = doc.rows.map((row) => {
    return doc.columns
      .map((col) => {
        let val = row[col.id];
        if (val === undefined || val === null) val = '';

        if (col.type === 'select') {
          const opt = col.options?.find((o) => o.id === val);
          val = opt ? opt.label : String(val);
        } else if (col.type === 'multiSelect' && Array.isArray(val)) {
          val = val
            .map((id) => col.options?.find((o) => o.id === id)?.label || id)
            .join('; ');
        }

        return `"${String(val).replace(/"/g, '""')}"`;
      })
      .join(',');
  });

  return [headers, ...rowLines].join('\n');
}
