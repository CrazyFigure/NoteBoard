// NoteBoard 多维表格通用工具集
// 覆盖唯一 ID 生成、剪贴板矩阵解析、单元格值类型归一（粘贴/填充）与纯文本展示格式化

import {
  DEFAULT_LONG_TEXT_CONFIG,
  type BitableColumn,
  type BitableRow,
  type LongTextConfig,
  type SelectOption,
  type SelectOptionColor,
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
 * 兼容 Excel / 飞书表格复制出的 TSV 与 CSV 格式，末尾空行会被丢弃
 */
export function parseClipboardMatrix(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmed = normalized.replace(/\n+$/, '');
  if (!trimmed) return [];
  return trimmed.split('\n').map(splitDelimitedLine);
}

/** 将常见日期写法归一为 YYYY-MM-DD，无法识别时原样返回 */
function normalizeDateInput(raw: string): string {
  const matched = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (matched) {
    const [, y, m, d] = matched;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return raw;
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
    case 'date':
      return { value: text ? normalizeDateInput(text) : null, column: null };
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
