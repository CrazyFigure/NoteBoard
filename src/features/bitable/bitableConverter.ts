// NoteBoard 多维表格序列化、解析与数据转换器
// 支持 JSON 双向解析、CSV 导出与默认精选项目管理模板构建

import {
  DEFAULT_DATE_TIME_CONFIG,
  DEFAULT_LONG_TEXT_CONFIG,
  isDateTimeFieldType,
  type BitableDocument,
  type BitableColumn,
  type BitableFieldType,
  type BitableRow,
  type BitableViewConfig,
} from './bitableTypes';

/**
 * 标准多维表格颜色清单。
 * 三色语义：bg = 标签底色、text = 标签文字（也是甘特条形的填充色）、border = 标签描边。
 *
 * 配色原则（改前务必按 CIELab 校验，别只用眼睛）：
 * 1. 白底附近的 sRGB 色域极窄 —— L*96 一带，品红域能取到的最大彩度只有 5.7。
 *    所以「都保持 50 级浅底」和「红粉一眼分明」物理上不可兼得（同亮度实测 ΔE 仅 3.1，并排不可辨，
 *    ΔE <3 不可辨 / 5~10 看得出 / >10 一眼分明）。要分离只能拉开亮度。
 * 2. 亮度关系要符合语义直觉：警示红比浪漫粉重（红 L*85.8 / 粉 L*96.5），
 *    反之会让用户觉得「粉色怎么比红色还深」。红粉现在填充 ΔE 19.4、描边 ΔE 25.6。
 * 3. 每个色面各自形成 200/300/700 的层次，文字对比度取到 AA（4.5:1）以上。
 *    警示红的文字因此用 800 级 —— 600 级放在 200 级底色上只有 3.34:1。
 */
export const BITABLE_PALETTE: Array<{ id: string; label: string; bg: string; text: string; border: string }> = [
  { id: 'blue', label: '沉稳蓝', bg: '#eff6ff', text: '#2563eb', border: '#bfdbfe' },
  { id: 'green', label: '清新绿', bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0' },
  { id: 'purple', label: '优雅紫', bg: '#faf5ff', text: '#9333ea', border: '#e9d5ff' },
  { id: 'amber', label: '活力橙', bg: '#fffbeb', text: '#d97706', border: '#fde68a' },
  { id: 'red', label: '警示红', bg: '#fecaca', text: '#991b1b', border: '#fca5a5' },
  { id: 'cyan', label: '湖水青', bg: '#ecfeff', text: '#0891b2', border: '#a5f3fc' },
  { id: 'pink', label: '浪漫粉', bg: '#fdf2f8', text: '#be185d', border: '#ffc6e9' },
  { id: 'gray', label: '中性灰', bg: '#f8fafc', text: '#475569', border: '#cbd5e1' },
];

/**
 * 历史颜色 id 别名。
 * 'orange' 是早期版本遗留的取值（后来色板统一收敛为 'amber' 且标签就叫「活力橙」）。
 * 老文档 / 外部导入的数据里可能还带着它，直接查表会落空并静默回落成蓝色，
 * 因此先做一次别名归一再查表，避免旧数据「颜色悄悄变成蓝色」。
 */
const LEGACY_COLOR_ALIAS: Record<string, string> = {
  orange: 'amber',
};

/** 获取标签颜色配置 */
export function getOptionColor(colorName?: string) {
  const normalized = colorName ? LEGACY_COLOR_ALIAS[colorName] || colorName : undefined;
  const found = BITABLE_PALETTE.find((c) => c.id === normalized);
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
      id: 'col_notes',
      key: 'notes',
      name: '任务说明',
      type: 'longText',
      width: 260,
      longText: { displayMode: 'firstLine', markdown: true },
    },
    {
      id: 'col_startDate',
      key: 'startDate',
      name: '开始日期',
      type: 'date',
      width: 140,
      // 显式写一份格式配置：模板生成的文档不经过解析期补全，
      // 只留内存默认值会让落盘数据与界面表现对不上
      dateTime: { ...DEFAULT_DATE_TIME_CONFIG },
    },
    {
      id: 'col_dueDate',
      key: 'dueDate',
      name: '截止日期',
      type: 'date',
      width: 140,
      dateTime: { ...DEFAULT_DATE_TIME_CONFIG },
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
      col_startDate: '2026-08-24',
      col_dueDate: '2026-08-28',
      col_progress: 100,
      col_rating: 5,
      col_notes: '对齐多维表格的交互细节，输出 **单元格** 与 **看板** 两套视觉稿。',
    },
    {
      id: 'row_1_1',
      parentId: 'row_1',
      col_name: '设计单选/多选马卡龙标签面板',
      col_status: 'opt_done',
      col_priority: 'p_p0',
      col_assignee: 'UI 设计师',
      col_startDate: '2026-08-25',
      col_dueDate: '2026-08-28',
      col_progress: 100,
      col_rating: 5,
    },
    {
      id: 'row_2',
      col_name: '实现多维表格单元格与标签选择器',
      col_status: 'opt_doing',
      col_priority: 'p_p0',
      col_assignee: '前端研发',
      col_startDate: '2026-08-26',
      col_dueDate: '2026-09-02',
      col_progress: 75,
      col_rating: 5,
      col_notes:
        '双击单元格可展开编辑弹层。\n\n- 支持 `加粗`、`行内代码`\n- 支持代码块：\n\n```ts\nconst cell = row[col.id];\n```\n\n列头菜单可切换「仅首行 / 全显示」。',
    },
    {
      id: 'row_3',
      col_name: '实现看板视图与多维度切换',
      col_status: 'opt_doing',
      col_priority: 'p_p1',
      col_assignee: '核心架构',
      col_startDate: '2026-08-28',
      col_dueDate: '2026-09-08',
      col_progress: 40,
      col_rating: 4,
    },
    {
      id: 'row_4',
      col_name: '单测覆盖率校验与发布验证',
      col_status: 'opt_todo',
      col_priority: 'p_p1',
      col_assignee: 'QA 质量组',
      col_startDate: '2026-09-07',
      col_dueDate: '2026-09-11',
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
    {
      id: 'view_gantt',
      name: '任务甘特图',
      type: 'gantt',
      gantt: {
        startColumnId: 'col_startDate',
        endColumnId: 'col_dueDate',
        titleColumnId: 'col_name',
        colorMode: 'custom',
        color: 'blue',
        workdaysOnly: false,
        zoom: 'month',
        leftColumnIds: ['col_name'],
      },
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

/** 已知字段类型清单：用于过滤外部数据中的非法类型，避免未知类型导致渲染分支缺失 */
const KNOWN_FIELD_TYPES: ReadonlySet<string> = new Set([
  'text',
  'longText',
  'number',
  'select',
  'multiSelect',
  'date',
  'time',
  'dateTime',
  'checkbox',
  'rating',
  'progress',
  'link',
]);

/**
 * 单列定义的容错归一
 * 外部粘贴或手工编辑过的 JSON 可能带有非法字段类型或残缺的 longText 配置，
 * 在此统一收敛，避免把脏数据带进渲染层。
 */
function normalizeColumn(col: BitableColumn): BitableColumn {
  const type: BitableFieldType = KNOWN_FIELD_TYPES.has(col?.type) ? col.type : 'text';
  if (type === 'longText') {
    return {
      ...col,
      type,
      longText: {
        displayMode: col.longText?.displayMode ?? DEFAULT_LONG_TEXT_CONFIG.displayMode,
        markdown: col.longText?.markdown ?? DEFAULT_LONG_TEXT_CONFIG.markdown,
      },
    };
  }
  // 日期时间类同样补齐显式格式配置，保证渲染层读到的永远是完整配置
  if (isDateTimeFieldType(type)) {
    return {
      ...col,
      type,
      dateTime: {
        dateFormat: col.dateTime?.dateFormat ?? DEFAULT_DATE_TIME_CONFIG.dateFormat,
        timeFormat: col.dateTime?.timeFormat ?? DEFAULT_DATE_TIME_CONFIG.timeFormat,
      },
    };
  }
  return { ...col, type };
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
      ? obj.columns.map(normalizeColumn)
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
