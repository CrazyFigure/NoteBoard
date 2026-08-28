// NoteBoard 多维表格 (Bitable) 核心类型定义
// 深度借鉴飞书多维表格样式与交互架构，支持丰富字段类型、双视图 (表格/看板) 与结构化持久化

export type BitableFieldType =
  /** 单行文本：不换行，单元格与表单中均为单行输入 */
  | 'text'
  /** 多行文本：保留换行，支持 Markdown 富文本，可在列头设置显示模式 */
  | 'longText'
  | 'number'
  | 'select'
  | 'multiSelect'
  | 'date'
  | 'checkbox'
  | 'rating'
  | 'progress'
  | 'link';

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

/** 飞书风格马卡龙标签颜色 */
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
  | { type: 'move'; optionId: string; direction: 'up' | 'down' };

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
