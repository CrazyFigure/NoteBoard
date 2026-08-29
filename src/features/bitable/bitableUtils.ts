// NoteBoard 多维表格通用工具集
// 覆盖唯一 ID 生成、剪贴板矩阵解析、单元格值类型归一（粘贴/填充）与纯文本展示格式化

import {
  DEFAULT_DATE_TIME_CONFIG,
  DEFAULT_LONG_TEXT_CONFIG,
  isDateTimeFieldType,
  type BitableColumn,
  type BitableRow,
  type DateFormatId,
  type DateTimeConfig,
  type DateTimeFieldType,
  type LongTextConfig,
  type SelectOption,
  type SelectOptionColor,
  type SortRule,
  type TimeFormatId,
} from './bitableTypes';

let idSequence = 0;

/**
 * 生成文档内唯一 ID
 * 采用「时间戳 + 自增序列」而非单纯 Date.now()：同一次粘贴/批量创建会在同一毫秒内产生多条记录，
 * 仅依赖时间会造成 React key 与数据主键冲突，进而出现新增行不渲染等问题。
 */
export function createId(prefix: string): string {
  idSequence += 1;
  return `${prefix}_${Date.now().toString(36)}${idSequence.toString(36)}`;
}

/** 新建选项时按顺序轮转取色，保证相邻标签颜色不重复 */
const ROTATE_COLORS: SelectOptionColor[] = [
  'blue',
  'green',
  'amber',
  'purple',
  'cyan',
  'pink',
  'red',
  'gray',
];

export function pickNextColor(existing: SelectOption[]): SelectOptionColor {
  return ROTATE_COLORS[existing.length % ROTATE_COLORS.length];
}

/**
 * 把「插入槽位」换算为数组 splice 所需的「删除后插入索引」
 * 重排是 splice 先删后插：元素从 fromIdx 处移除后，落点在其右侧的槽位整体左移一位。
 * 不换算就会出现「指示线画在左边、元素却落到右边一位」的错位。
 */
export function slotToSpliceIndex(insertAt: number, fromIdx: number): number {
  return insertAt > fromIdx ? insertAt - 1 : insertAt;
}

/** 换算落点最终呈现的位置序号（从 1 起），用于拖拽时的落点提示文案 */
export function slotToFinalPosition(insertAt: number, fromIdx: number): number {
  return insertAt > fromIdx ? insertAt : insertAt + 1;
}

/** 槽位是否等价于原位：落在自身左右两侧时移动后顺序不变，无需提交 */
export function isSlotNoop(insertAt: number, fromIdx: number): boolean {
  return insertAt === fromIdx || insertAt === fromIdx + 1;
}

/** 将一行分隔文本解析为单元格数组，自动识别 Tab / 逗号分隔符并兼容双引号包裹 */
function splitDelimitedLine(line: string): string[] {
  const delimiter = line.includes('\t') ? '\t' : line.includes(',') ? ',' : '\t';
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * 解析剪贴板文本为二维矩阵
 * 兼容电子表格复制出的 TSV 与 CSV 格式，末尾空行会被丢弃
 */
export function parseClipboardMatrix(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmed = normalized.replace(/\n+$/, '');
  if (!trimmed) return [];
  return trimmed.split('\n').map(splitDelimitedLine);
}

// ── 日期时间工具集 ──
// 存储与显示彻底解耦：库里只存「可字典序排序」的规范串（YYYY-MM-DD / HH:mm:ss / YYYY-MM-DD HH:mm:ss），
// 展示时再按列上的格式配置渲染。这样换格式不会改动数据，排序也天然正确。

/** 补零到两位 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 宽松解析日期文本为 YYYY-MM-DD
 * 兼容 2026-8-29 / 2026/8/29 / 2026.8.29 / 2026年8月29日 等常见写法。
 */
export function normalizeDateInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  // 中文写法先剔除「年月日」再走数字分支，避免正则里堆一堆可选字符
  const cn = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/);
  if (cn) {
    const [, y, m, d] = cn;
    return `${y}-${pad2(Number(m))}-${pad2(Number(d))}`;
  }
  const matched = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (matched) {
    const [, y, m, d] = matched;
    return `${y}-${pad2(Number(m))}-${pad2(Number(d))}`;
  }
  return null;
}

/** 宽松解析时间文本为 HH:mm:ss，缺秒补 00；12 小时制（含上午/下午）也一并识别 */
export function normalizeTimeInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const cn = text.match(/^(上午|下午|早上|晚上)?\s*(\d{1,2})\s*[:时]\s*(\d{1,2})(?:\s*[:分]\s*(\d{1,2}))?\s*分?秒?$/);
  if (cn) {
    const [, ampm, h, m, s] = cn;
    let hour = Number(h);
    // 12 小时制只在 1~12 区间生效，且 12 点特殊：下午 12 点即 12 时，上午 12 点是 0 时
    if ((ampm === '下午' || ampm === '晚上') && hour < 12) hour += 12;
    if ((ampm === '上午' || ampm === '早上') && hour === 12) hour = 0;
    if (hour > 23 || Number(m) > 59 || (s !== undefined && Number(s) > 59)) return null;
    return `${pad2(hour)}:${pad2(Number(m))}:${pad2(Number(s ?? 0))}`;
  }
  return null;
}

/**
 * 拆分一段文本中的日期与时间成分
 * 允许「只有日期」「只有时间」「日期 + 时间（空格或 T 分隔）」三种形态，
 * 供三种字段类型各自取用所需的部分。
 */
export function parseDateTimeInput(raw: string): { date: string | null; time: string | null } {
  const text = raw.trim();
  if (!text) return { date: null, time: null };

  // 先按空白或 T 切成两段，分别尝试按日期/时间解析，兼容「日期在前」与「时间在前」
  const parts = text.split(/[\sT]+/).filter(Boolean);
  let date: string | null = null;
  let time: string | null = null;
  parts.forEach((part) => {
    if (!date) date = normalizeDateInput(part);
    if (!time) time = normalizeTimeInput(part);
  });
  return { date, time };
}

/** 取今天的日期串 YYYY-MM-DD（按本地时区，避免 toISOString 的 UTC 偏移串日期） */
export function todayDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** 取当前时刻串 HH:mm:ss（按本地时区） */
export function nowTimeString(): string {
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

/** 解析日期存储值为 { y, m, d } 三个数字，非法返回 null */
function splitDateValue(value: string): { y: string; m: string; d: string } | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) return null;
  const [, y, m, d] = matched;
  return { y, m, d };
}

/** 解析时间存储值为时/分/秒数字，非法返回 null */
function splitTimeValue(value: string): { h: number; m: number; s: number } | null {
  const matched = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!matched) return null;
  const [, h, m, s] = matched;
  return { h: Number(h), m: Number(m), s: Number(s ?? 0) };
}

/** 按日期格式渲染日期部分（入参为 YYYY-MM-DD） */
export function formatDatePart(date: string, format: DateFormatId): string {
  const parts = splitDateValue(date);
  if (!parts) return date;
  const { y, m, d } = parts;
  switch (format) {
    case 'ymd-slash':
      return `${y}/${m}/${d}`;
    case 'ymd-dot':
      return `${y}.${m}.${d}`;
    case 'ymd-cn':
      return `${y}年${m}月${d}日`;
    case 'mdy-slash':
      return `${m}/${d}/${y}`;
    case 'md-cn':
      return `${m}月${d}日`;
    case 'ymd-dash':
    default:
      return `${y}-${m}-${d}`;
  }
}

/** 按时间格式渲染时间部分（入参为 HH:mm[:ss]） */
export function formatTimePart(time: string, format: TimeFormatId): string {
  const parts = splitTimeValue(time);
  if (!parts) return time;
  const { h, m, s } = parts;
  switch (format) {
    case 'hms':
      return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
    case 'hm-cn':
      return `${pad2(h)}时${pad2(m)}分`;
    case 'hms-cn':
      return `${pad2(h)}时${pad2(m)}分${pad2(s)}秒`;
    case 'hm-12': {
      const ampm = h < 12 ? '上午' : '下午';
      const hour12 = h % 12 === 0 ? 12 : h % 12;
      return `${ampm} ${pad2(hour12)}:${pad2(m)}`;
    }
    case 'hm':
    default:
      return `${pad2(h)}:${pad2(m)}`;
  }
}

/**
 * 解析日期时间字段的有效配置
 * 列定义上的 dateTime 允许部分缺省，读取时统一补全，避免各渲染点各自写默认值造成不一致。
 */
export function resolveDateTimeConfig(column: BitableColumn): DateTimeConfig {
  return {
    dateFormat: column.dateTime?.dateFormat ?? DEFAULT_DATE_TIME_CONFIG.dateFormat,
    timeFormat: column.dateTime?.timeFormat ?? DEFAULT_DATE_TIME_CONFIG.timeFormat,
  };
}

/**
 * 按字段类型与格式配置渲染日期时间单元格
 * 三种类型的存储形态不同，这里统一收敛为一个出口，供表格、看板、侧边栏与 CSV 复用。
 */
export function formatDateTimeValue(
  value: unknown,
  type: DateTimeFieldType,
  config: DateTimeConfig,
): string {
  if (value === undefined || value === null || value === '') return '';
  const raw = String(value).trim();

  if (type === 'date') return formatDatePart(raw, config.dateFormat);
  if (type === 'time') return formatTimePart(raw, config.timeFormat);

  // dateTime：存储形态为 `YYYY-MM-DD HH:mm:ss`，按空格切开分别套用两部分格式
  const [datePart, timePart] = raw.split(/[\sT]+/);
  if (!datePart) return raw;
  const dateText = formatDatePart(datePart, config.dateFormat);
  if (!timePart) return dateText;
  return `${dateText} ${formatTimePart(timePart, config.timeFormat)}`;
}

/**
 * 解析多行文本字段的有效配置
 * 列定义上的 longText 允许部分缺省，读取时统一补全，避免各渲染点各自写默认值造成不一致。
 */
export function resolveLongTextConfig(column: BitableColumn): LongTextConfig {
  return {
    displayMode: column.longText?.displayMode ?? DEFAULT_LONG_TEXT_CONFIG.displayMode,
    markdown: column.longText?.markdown ?? DEFAULT_LONG_TEXT_CONFIG.markdown,
  };
}

/**
 * 去掉 Markdown 标记，转为用于单行预览的纯文本
 * 只剥离常见标记字符，不做完整 AST 解析：预览场景只需「读起来像原文」，
 * 用正则逐条替换的成本远低于引入完整解析器。
 */
export function stripMarkdown(raw: string): string {
  return raw
    // 代码围栏整体移除（含内部内容），避免 ``` 与语言名出现在预览里
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    // 标题、引用、列表、分割线等行首标记
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/gm, '')
    // 行内标记：加粗、斜体、删除线、行内代码、图片
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    // 合并替换产生的多余空格，并把换行压成空格
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

/**
 * 取多行文本的首行预览文本
 * 首行为空时会继续向后寻找第一个非空行，避免整格显示空白。
 */
export function firstLineOf(raw: string): string {
  const lines = String(raw ?? '').split(/\r?\n/);
  for (const line of lines) {
    if (line.trim()) return line.trim();
  }
  return '';
}

/**
 * 生成多行文本的预览文本
 * firstLine 模式取首行（并剥离 Markdown 标记），full 模式返回原文。
 */
export function previewLongText(raw: string, config: LongTextConfig): string {
  const text = raw === null || raw === undefined ? '' : String(raw);
  if (config.displayMode === 'full') return text;
  const first = firstLineOf(text);
  return config.markdown ? stripMarkdown(first) : first;
}

/**
 * 按字段类型把原始文本归一为合法单元格值
 * 对 select / multiSelect 而言，文本匹配不到的标签会自动创建新选项，
 * 并通过返回更新后的 column 让调用方一次性提交，避免「先改列再改行」的两次提交互相覆盖。
 */
export function coerceCellValue(
  column: BitableColumn,
  raw: string,
): { value: unknown; column: BitableColumn | null } {
  const text = raw.trim();

  switch (column.type) {
    case 'number':
    case 'progress':
    case 'rating': {
      if (text === '') return { value: null, column: null };
      const num = Number(text.replace('%', ''));
      if (Number.isNaN(num)) return { value: null, column: null };
      if (column.type === 'progress') {
        return { value: Math.min(100, Math.max(0, Math.round(num))), column: null };
      }
      return { value: num, column: null };
    }
    case 'checkbox':
      return {
        value: ['true', '1', 'yes', 'y', '是', '√', '✓'].includes(text.toLowerCase()),
        column: null,
      };
    case 'date': {
      if (!text) return { value: null, column: null };
      // 粘贴「2026-08-29 09:00」时只取日期部分，避免整串写进日期列后无法格式化
      const { date } = parseDateTimeInput(text);
      return { value: date, column: null };
    }
    case 'time': {
      if (!text) return { value: null, column: null };
      const { time } = parseDateTimeInput(text);
      return { value: time, column: null };
    }
    case 'dateTime': {
      if (!text) return { value: null, column: null };
      const { date, time } = parseDateTimeInput(text);
      // 只给日期则时间补零点；只给时间则日期补今天，保证存储形态始终是完整的可排序串
      if (!date && !time) return { value: null, column: null };
      return {
        value: `${date || todayDateString()} ${time || '00:00:00'}`,
        column: null,
      };
    }
    case 'select': {
      if (!text) return { value: null, column: null };
      const options = column.options || [];
      const hit = options.find((o) => o.label.toLowerCase() === text.toLowerCase());
      if (hit) return { value: hit.id, column: null };
      const created: SelectOption = {
        id: createId('opt'),
        label: text,
        color: pickNextColor(options),
      };
      return { value: created.id, column: { ...column, options: [...options, created] } };
    }
    case 'multiSelect': {
      if (!text) return { value: [], column: null };
      // 仅按中英文逗号/分号/顿号拆分：标签名本身可能包含空格，不能用空白切分
      const tokens = text.split(/[,;，；、]+/).map((t) => t.trim()).filter(Boolean);
      let options = column.options || [];
      let changed = false;
      const ids: string[] = [];
      tokens.forEach((token) => {
        const hit = options.find((o) => o.label.toLowerCase() === token.toLowerCase());
        if (hit) {
          ids.push(hit.id);
          return;
        }
        const created: SelectOption = {
          id: createId('opt'),
          label: token,
          color: pickNextColor(options),
        };
        options = [...options, created];
        ids.push(created.id);
        changed = true;
      });
      return {
        value: ids,
        column: changed ? { ...column, options } : null,
      };
    }
    default:
      return { value: raw, column: null };
  }
}

/** 单元格值的纯文本展示形式，用于复制到剪贴板与 CSV 导出 */
export function formatCellValue(column: BitableColumn, value: unknown): string {
  if (value === undefined || value === null) return '';
  // 多行文本的换行会破坏 TSV 行结构，导出/复制时压平为空格
  if (column.type === 'longText') {
    return String(value).replace(/\r?\n/g, ' ').trim();
  }
  if (column.type === 'select') {
    return column.options?.find((o) => o.id === value)?.label || '';
  }
  if (column.type === 'multiSelect') {
    if (!Array.isArray(value)) return '';
    return value.map((id) => column.options?.find((o) => o.id === id)?.label || id).join(', ');
  }
  if (column.type === 'checkbox') {
    return value ? '是' : '否';
  }
  // 日期时间类按列上的格式配置输出，保证复制出去的文本与界面所见一致
  if (isDateTimeFieldType(column.type)) {
    return formatDateTimeValue(value, column.type, resolveDateTimeConfig(column));
  }
  return String(value);
}

/** 创建新记录行，按字段类型补齐默认值 */
export function createRow(
  columns: BitableColumn[],
  extra?: Record<string, unknown>,
): BitableRow {
  const row: BitableRow = {
    id: createId('row'),
    _createdAt: Date.now(),
    _updatedAt: Date.now(),
  };
  columns.forEach((col) => {
    if (col.type === 'progress' || col.type === 'rating') row[col.id] = 0;
    if (col.type === 'checkbox') row[col.id] = false;
    if (col.type === 'multiSelect') row[col.id] = [];
  });
  if (extra) Object.assign(row, extra);
  return row;
}

/** 分组元数据：用于构建分组头部与折叠状态键 */
export interface GroupMeta {
  key: string;
  label: string;
  color?: SelectOptionColor;
}

/**
 * 获取行的分组键与展示标签
 * - select：按选项 ID 分组，返回选项标签与颜色
 * - multiSelect：按首个选中选项分组（不支持多个分组），未选归到空值
 * - 其他字段：按原始值字符串分组，空/undefined/null 归到空值组
 */
export function resolveGroupKey(
  row: BitableRow,
  column: BitableColumn | undefined,
): { key: string; label: string; color?: SelectOptionColor } {
  if (!column) return { key: '__empty__', label: '未指定' };
  const raw = row[column.id];

  if (column.type === 'select') {
    if (raw === undefined || raw === null || raw === '') return { key: '__empty__', label: '未指定' };
    const opt = (column.options || []).find((o) => o.id === raw);
    return {
      key: String(raw),
      label: opt?.label ?? String(raw),
      color: opt?.color,
    };
  }

  if (column.type === 'multiSelect') {
    if (!Array.isArray(raw) || raw.length === 0) return { key: '__empty__', label: '未指定' };
    const firstId = raw[0];
    const opt = (column.options || []).find((o) => o.id === firstId);
    return {
      key: String(firstId),
      label: opt?.label ?? String(firstId),
      color: opt?.color,
    };
  }

  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { key: '__empty__', label: '未指定' };
  }

  // 多行文本分组时取首行预览，避免把整个 Markdown 塞进标题
  if (column.type === 'longText') {
    const text = previewLongText(String(raw), resolveLongTextConfig(column)) || String(raw);
    return { key: String(raw), label: text };
  }

  return { key: String(raw), label: String(raw) };
}

/**
 * 对扁平树行按指定列分组
 * 保持组内原有顺序；组与组之间通过渲染层插入间距实现视觉分隔。
 */
export function groupFlatTreeRows(
  flatRows: { row: BitableRow; depth: number; hasChildren: boolean; isCollapsed: boolean; rowNumber: number }[],
  column: BitableColumn | undefined,
): Array<{ meta: GroupMeta; rows: typeof flatRows[number][] }> {
  const groupMap = new Map<string, { meta: GroupMeta; rows: typeof flatRows[number][] }>();
  const order: string[] = [];

  flatRows.forEach((node) => {
    const { key, label, color } = resolveGroupKey(node.row, column);
    let group = groupMap.get(key);
    if (!group) {
      group = { meta: { key, label, color }, rows: [] };
      groupMap.set(key, group);
      order.push(key);
    }
    group.rows.push(node);
  });

  // 空值组始终放在最后
  return order.map((k) => groupMap.get(k)!).sort((a, b) => {
    const aEmpty = a.meta.key === '__empty__';
    const bEmpty = b.meta.key === '__empty__';
    if (aEmpty && !bEmpty) return 1;
    if (!aEmpty && bEmpty) return -1;
    // 非空组按标签自然序排列（中文拼音 + 数字）
    return a.meta.label.localeCompare(b.meta.label, 'zh-CN', { numeric: true });
  });
}

/**
 * 单字段比较：按字段类型专有规则比较两个单元格值
 * 返回负数/0/正数，空值统一后置。
 */
function compareCellValues(
  a: unknown,
  b: unknown,
  column: BitableColumn,
): number {
  // 空值后置：两边都空视为相等，仅一边空则另一边更大
  const aEmpty = a === undefined || a === null || a === '';
  const bEmpty = b === undefined || b === null || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  const colType = column.type;
  if (colType === 'number' || colType === 'progress' || colType === 'rating') {
    return Number(a) - Number(b);
  }
  // 日期时间三类的存储串都是「高位在前、定长补零」，字典序即时间序，无需再解析成 Date
  if (colType === 'date' || colType === 'time' || colType === 'dateTime') {
    return String(a).localeCompare(String(b));
  }
  if (colType === 'checkbox') {
    if (Boolean(a) === Boolean(b)) return 0;
    return a ? 1 : -1;
  }
  if (colType === 'select') {
    const idxA = (column.options || []).findIndex((o) => o.id === a);
    const idxB = (column.options || []).findIndex((o) => o.id === b);
    return idxA - idxB;
  }
  if (colType === 'multiSelect') {
    const idsA = Array.isArray(a) ? a : [];
    const idsB = Array.isArray(b) ? b : [];
    const options = column.options || [];
    const idxA = options.findIndex((o) => o.id === idsA[0]);
    const idxB = options.findIndex((o) => o.id === idsB[0]);
    if (idxA !== idxB) return idxA - idxB;
    // 首选项相同时按长度作为次要依据，避免完全相同的数组反复比较
    return idsA.length - idsB.length;
  }
  // 文本、链接、多行文本使用中文拼音/自然排序
  return String(a).localeCompare(String(b), 'zh-CN', { numeric: true });
}

/**
 * 按多字段排序规则比较两行
 * 规则按数组顺序依次应用：前一条相等时才看下一条；全部相等返回 0。
 */
export function compareRowsBySortRules(
  a: BitableRow,
  b: BitableRow,
  columns: BitableColumn[],
  sortRules: SortRule[],
): number {
  for (const rule of sortRules) {
    const column = columns.find((c) => c.id === rule.columnId);
    if (!column) continue;
    const cmp = compareCellValues(a[column.id], b[column.id], column);
    if (cmp !== 0) {
      return rule.direction === 'asc' ? cmp : -cmp;
    }
  }
  return 0;
}

export interface FlatTreeNode {
  row: BitableRow;
  depth: number;
}

/**
 * 把树形行展开为「忽略折叠」的完整扁平序列
 * 与表格渲染用的 flatTreeRows 不同：拖拽换序必须基于完整序列计算，
 * 否则折叠隐藏的子行在重排后会丢失或被截断在错误的父级下。
 */
export function flattenTreeRowsFull(rows: BitableRow[]): FlatTreeNode[] {
  const childrenOf = new Map<string | undefined, BitableRow[]>();
  rows.forEach((row) => {
    const list = childrenOf.get(row.parentId) || [];
    list.push(row);
    childrenOf.set(row.parentId, list);
  });

  const result: FlatTreeNode[] = [];
  const walk = (parentId: string | undefined, depth: number) => {
    (childrenOf.get(parentId) || []).forEach((row) => {
      result.push({ row, depth });
      walk(row.id, depth + 1);
    });
  };
  walk(undefined, 0);
  return result;
}

/**
 * 收集某行的全部后代行 ID（不含自身）
 * 用于拦截「把父行拖进自己的子树」这类会破坏树结构的非法落点。
 */
export function collectDescendantRowIds(rows: BitableRow[], rowId: string): Set<string> {
  const childrenOf = new Map<string | undefined, BitableRow[]>();
  rows.forEach((row) => {
    const list = childrenOf.get(row.parentId) || [];
    list.push(row);
    childrenOf.set(row.parentId, list);
  });

  const result = new Set<string>();
  const stack = [...(childrenOf.get(rowId) || [])];
  while (stack.length) {
    const node = stack.pop()!;
    if (result.has(node.id)) continue;
    result.add(node.id);
    (childrenOf.get(node.id) || []).forEach((child) => stack.push(child));
  }
  return result;
}

/**
 * 在树形行中移动某一行（连同整棵子树）到指定落点
 *
 * @param beforeRowId 落点参照行：被拖行插入到它之前；null 表示追加到末尾
 * @param parentId 被拖行的新父级，由调用方按落点参照行的父级给出
 *
 * 数组顺序即兄弟顺序：重排扁平序列后原样写回即可，无需额外维护顺序字段。
 * 落点若落在自身子树内部（会形成环）则原样返回，避免数据结构损坏。
 */
export function moveTreeRow(
  rows: BitableRow[],
  draggedRowId: string,
  beforeRowId: string | null,
  parentId?: string,
): BitableRow[] {
  const flat = flattenTreeRowsFull(rows);
  const fromIdx = flat.findIndex((n) => n.row.id === draggedRowId);
  if (fromIdx < 0) return rows;

  // 紧随其后且层级更深的连续行即整棵子树
  const depth = flat[fromIdx].depth;
  let endIdx = fromIdx + 1;
  while (endIdx < flat.length && flat[endIdx].depth > depth) endIdx += 1;

  const moving = flat.slice(fromIdx, endIdx);
  // 落点落在自身子树内部会让父行成为自己的后代，直接判定为非法
  if (beforeRowId && moving.some((n) => n.row.id === beforeRowId)) return rows;
  if (parentId && moving.some((n) => n.row.id === parentId)) return rows;

  const rest = [...flat.slice(0, fromIdx), ...flat.slice(endIdx)];
  let insertIdx = beforeRowId ? rest.findIndex((n) => n.row.id === beforeRowId) : -1;
  if (insertIdx < 0) insertIdx = rest.length;

  const nextFlat = [...rest.slice(0, insertIdx), ...moving, ...rest.slice(insertIdx)];
  return nextFlat.map((node) => (node.row.id === draggedRowId ? { ...node.row, parentId } : node.row));
}

/**
 * 把标签选项从 fromIdx 移动到 toIdx（删除后的插入索引语义）
 * 看板泳道换序即等价于调整分组列标签选项的顺序。
 */
export function moveOptionByIndex(
  options: SelectOption[],
  fromIdx: number,
  toIdx: number,
): SelectOption[] {
  if (fromIdx < 0 || fromIdx >= options.length) return options;
  const next = [...options];
  const [moved] = next.splice(fromIdx, 1);
  const target = Math.max(0, Math.min(next.length, toIdx));
  next.splice(target, 0, moved);
  return next;
}

/**
 * 获取某字段类型的专有排序方向文案
 * 不同字段类型用不同隐喻（A-Z、0-9、日期先后等）。
 */
export function getSortDirectionLabels(
  columnType: BitableColumn['type'],
): { asc: string; desc: string } {
  switch (columnType) {
    case 'number':
    case 'progress':
    case 'rating':
      return { asc: '0 → 9', desc: '9 → 0' };
    case 'date':
      return { asc: '最早的日期 → 最晚', desc: '最晚的日期 → 最早' };
    case 'time':
      return { asc: '最早的时间 → 最晚', desc: '最晚的时间 → 最早' };
    case 'dateTime':
      return { asc: '最早的时间 → 最晚', desc: '最晚的时间 → 最早' };
    case 'checkbox':
      return { asc: '未勾选 → 勾选', desc: '勾选 → 未勾选' };
    case 'select':
    case 'multiSelect':
      return { asc: '选项顺序', desc: '选项逆序' };
    case 'text':
    case 'longText':
    case 'link':
    default:
      return { asc: 'A → Z', desc: 'Z → A' };
  }
}
