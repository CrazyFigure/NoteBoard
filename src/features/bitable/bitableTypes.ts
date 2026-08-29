// NoteBoard 多维表格 (Bitable) 核心类型定义
// 完备支持丰富字段类型、双视图 (表格/看板) 与结构化持久化

export type BitableFieldType =
  /** 单行文本：不换行，单元格与表单中均为单行输入 */
  | 'text'
  /** 多行文本：保留换行，支持 Markdown 富文本，可在列头设置显示模式 */
  | 'longText'
  | 'number'
  | 'select'
  | 'multiSelect'
  /** 日期：只含年月日，存储为 YYYY-MM-DD */
  | 'date'
  /** 时间：只含时分秒，存储为 HH:mm:ss */
  | 'time'
  /** 日期时间：年月日 + 时分秒，存储为 YYYY-MM-DD HH:mm:ss（空格分隔以便字典序即时间序） */
  | 'dateTime'
  | 'checkbox'
  | 'rating'
  | 'progress'
  | 'link';

/**
 * 日期格式 ID
 * sample 为「示例值」，用于列头菜单里直接预览效果，避免只看到抽象的 ID。
 */
export type DateFormatId =
  /** 2026-08-29 */
  | 'ymd-dash'
  /** 2026/08/29 */
  | 'ymd-slash'
  /** 2026.08.29 */
  | 'ymd-dot'
  /** 2026年08月29日 */
  | 'ymd-cn'
  /** 08/29/2026 */
  | 'mdy-slash'
  /** 08月29日 */
  | 'md-cn';

/** 时间格式 ID */
export type TimeFormatId =
  /** 09:00 */
  | 'hm'
  /** 09:00:41 */
  | 'hms'
  /** 09时00分 */
  | 'hm-cn'
  /** 09时00分41秒 */
  | 'hms-cn'
  /** 上午 09:00 */
  | 'hm-12';

/** 日期时间字段的显示配置（仅对 date / time / dateTime 生效） */
export interface DateTimeConfig {
  /** 日期格式，默认 ymd-dash */
  dateFormat: DateFormatId;
  /** 时间格式，默认 hm */
  timeFormat: TimeFormatId;
}

/** 日期时间配置的默认值 */
export const DEFAULT_DATE_TIME_CONFIG: DateTimeConfig = {
  dateFormat: 'ymd-dash',
  timeFormat: 'hm',
};

/** 日期格式选项：label 用于菜单展示，sample 为该格式下的示例文本 */
export const DATE_FORMAT_OPTIONS: Array<{ id: DateFormatId; label: string; sample: string }> = [
  { id: 'ymd-dash', label: '- 间隔', sample: '2026-08-29' },
  { id: 'ymd-slash', label: '/ 间隔', sample: '2026/08/29' },
  { id: 'ymd-dot', label: '. 间隔', sample: '2026.08.29' },
  { id: 'ymd-cn', label: '年月日', sample: '2026年08月29日' },
  { id: 'mdy-slash', label: '月/日/年', sample: '08/29/2026' },
  { id: 'md-cn', label: '月日', sample: '08月29日' },
];

/** 时间格式选项 */
export const TIME_FORMAT_OPTIONS: Array<{ id: TimeFormatId; label: string; sample: string }> = [
  { id: 'hm', label: ': 间隔（时:分）', sample: '09:00' },
  { id: 'hms', label: ': 间隔（时:分:秒）', sample: '09:00:41' },
  { id: 'hm-cn', label: '时分', sample: '09时00分' },
  { id: 'hms-cn', label: '时分秒', sample: '09时00分41秒' },
  { id: 'hm-12', label: '12 小时制', sample: '上午 09:00' },
];

/**
 * 多行文本的显示模式
 * - firstLine：只显示第一行，行高保持紧凑（超出部分省略号）
 * - full：完整显示全部内容，行高随内容自适应变高
 */
export type LongTextDisplayMode = 'firstLine' | 'full';

/** 多行文本字段的显示与编辑配置（仅对 longText 生效） */
export interface LongTextConfig {
  /** 显示模式，默认 firstLine */
  displayMode: LongTextDisplayMode;
  /** 是否启用 Markdown 富文本（可视化编辑 + 渲染），默认 false */
  markdown: boolean;
}

/** 多行文本配置的默认值 */
export const DEFAULT_LONG_TEXT_CONFIG: LongTextConfig = {
  displayMode: 'firstLine',
  markdown: false,
};

/** 彩色标签选项颜色 */
export type SelectOptionColor =
  | 'blue'
  | 'green'
  | 'purple'
  | 'amber'
  | 'red'
  | 'cyan'
  | 'pink'
  | 'gray'
  | 'orange';

/** 单选/多选标签选项 */
export interface SelectOption {
  id: string;
  label: string;
  color: SelectOptionColor;
}

/** 字段/列定义 */
export interface BitableColumn {
  id: string;
  key: string;
  name: string;
  type: BitableFieldType;
  width?: number; // 像素宽度，默认 160
  options?: SelectOption[]; // 用于 select 和 multiSelect
  /** 多行文本的显示与编辑配置，仅 type === 'longText' 时生效 */
  longText?: Partial<LongTextConfig>;
  /** 日期时间的显示格式配置，仅 type 为 date / time / dateTime 时生效 */
  dateTime?: Partial<DateTimeConfig>;
}

/** 日期时间三兄弟：凡是要按「日期类字段」统一处理的地方都用它，避免各处手写联合类型漏项 */
export type DateTimeFieldType = Extract<BitableFieldType, 'date' | 'time' | 'dateTime'>;

/** 判断字段类型是否属于日期时间类 */
export function isDateTimeFieldType(type: BitableFieldType): type is DateTimeFieldType {
  return type === 'date' || type === 'time' || type === 'dateTime';
}

/** 记录行定义 */
export interface BitableRow {
  id: string;
  parentId?: string; // 父级行 ID，用于支持树形子任务与折叠
  [columnKey: string]: unknown;
  _createdAt?: number;
  _updatedAt?: number;
}

/** 视图类型 */
export type BitableViewType = 'grid' | 'kanban';

/** 过滤规则操作符 */
export type FilterOperator =
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'notEquals'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'isTrue'
  | 'isFalse'
  | 'greaterThan'
  | 'lessThan';

/** 过滤条件 */
export interface FilterRule {
  id: string;
  columnId: string;
  operator: FilterOperator;
  value: string;
}

/** 排序规则 */
export interface SortRule {
  columnId: string;
  direction: 'asc' | 'desc';
}

/** 视图配置 */
export interface BitableViewConfig {
  id: string;
  name: string;
  type: BitableViewType;
  filterRules?: FilterRule[];
  sortRules?: SortRule[];
  groupByColumnId?: string; // 看板视图使用的分组单选列 ID
  hiddenColumnIds?: string[];
}

/**
 * 单列标签选项的变更动作
 * 统一由上层在「一次提交」内完成「列选项 + 所有关联行数据」的联动更新，
 * 避免先改列再改行时两次提交相互覆盖（历史上表现为「新增选项后立即消失」）。
 */
export type ColumnOptionAction =
  | { type: 'add'; option: SelectOption }
  | { type: 'update'; optionId: string; label: string; color: SelectOptionColor }
  | { type: 'delete'; optionId: string }
  | { type: 'move'; optionId: string; direction: 'up' | 'down' }
  /** 拖拽换序：把 optionId 对应的选项移动到删除后的 toIndex 处 */
  | { type: 'reorder'; optionId: string; toIndex: number };

/** 完整多维表格持久化文档模型 */
export interface BitableDocument {
  schemaVersion: number;
  title: string;
  description?: string;
  columns: BitableColumn[];
  rows: BitableRow[];
  views: BitableViewConfig[];
  activeViewId?: string;
}
