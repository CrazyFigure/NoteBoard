// NoteBoard Markdown 格式规范化决策
// 可视化编辑器只能以规范格式输出 Markdown（如 `*` 列表统一为 `-`、`_x_` 统一为 `*x*`）。
// 原则：规范化必须经用户同意——进入可视化模式前比较"解析→序列化"结果与原文，
// 不同则按策略（每次询问 / 总是规范化 / 保持源码模式）处理，绝不静默改写文件。

import type { MarkdownNormalizationPolicy } from '../../core/ipc/types';

/** 用户在询问框中的选择：规范化进入可视化，或保持源码模式 */
export type NormalizationChoice = 'normalize' | 'source';

/** 取消只中止本次打开，不属于可记住的文档规范化策略。 */
export type NormalizationDialogChoice = NormalizationChoice | 'cancel';

// 会话内按文档记住的选择（关闭应用后失效，避免长期记忆造成"为何不再询问"的困惑）
const rememberedChoices = new Map<string, NormalizationChoice>();

/** 记住某文档本次会话的选择 */
export function rememberNormalizationChoice(docKey: string, choice: NormalizationChoice): void {
  rememberedChoices.set(docKey, choice);
}

/** 文档重命名/迁移身份时同步记忆 */
export function moveNormalizationChoice(fromKey: string, toKey: string): void {
  const choice = rememberedChoices.get(fromKey);
  if (choice === undefined) return;
  rememberedChoices.delete(fromKey);
  rememberedChoices.set(toKey, choice);
}

/** 计算该文档的生效策略：会话记忆优先于全局设置 */
export function resolveNormalizationPolicy(
  docKey: string,
  settingPolicy: MarkdownNormalizationPolicy | undefined,
): MarkdownNormalizationPolicy {
  const remembered = rememberedChoices.get(docKey);
  if (remembered === 'normalize') return 'always';
  if (remembered === 'source') return 'never';
  return settingPolicy ?? 'ask';
}

/** 仅供测试：清空会话记忆 */
export function resetNormalizationMemory(): void {
  rememberedChoices.clear();
}

// ── 差异摘要 ──

/** 一处差异块（按整行展开） */
export interface NormalizationHunk {
  before: string;
  after: string;
  /** 原文中的起始行号（1 基） */
  line: number;
  /** 该处差异的分类（用于逐处说明规范化理由） */
  category: NormalizationCategory;
}

/** 差异分类：用于向用户说明"会改什么" */
export type NormalizationCategory =
  | 'trailing-whitespace'
  | 'list-indent'
  | 'whitespace'
  | 'entity'
  | 'list-marker'
  | 'list-number'
  | 'emphasis'
  | 'heading'
  | 'horizontal-rule'
  | 'code-fence'
  | 'table'
  | 'link'
  | 'line-break'
  | 'escape'
  | 'other';

export const NORMALIZATION_CATEGORY_LABELS: Record<NormalizationCategory, string> = {
  'trailing-whitespace': '去除行尾空格',
  'list-indent': '列表续行缩进对齐',
  whitespace: '空行与缩进调整',
  entity: 'HTML 实体写法调整',
  'list-marker': '列表符号统一',
  'list-number': '有序列表重新编号',
  emphasis: '强调符号统一为 * / **',
  heading: '标题写法统一为 #',
  'horizontal-rule': '分隔线统一为 ---',
  'code-fence': '代码块围栏调整',
  table: '表格重新排版',
  link: '链接改为内联写法',
  'line-break': '换行写法调整',
  escape: '转义字符调整',
  other: '其他格式调整',
};

/** 每类规范化的理由：说明为什么可视化编辑器会这样写回 */
export const NORMALIZATION_CATEGORY_REASONS: Record<NormalizationCategory, string> = {
  'trailing-whitespace': '解析时会丢弃',
  'list-indent': '请核对列表层级',
  whitespace: '请核对缩进与空行',
  entity: '显示不变',
  'list-marker': '写法等价',
  'list-number': '显示不变',
  emphasis: '写法等价',
  heading: '写法等价',
  'horizontal-rule': '写法等价',
  'code-fence': '防止提前闭合',
  table: '显示不变',
  link: '写法等价',
  'line-break': '写法等价',
  escape: '请核对字面字符',
  other: '请核对差异',
};

export interface NormalizationDiff {
  hunks: NormalizationHunk[];
  categories: Array<{ category: NormalizationCategory; count: number }>;
}

// HTML 实体引用（&copy;、&#169;、&#xA9;）
const HTML_ENTITY_PATTERN = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/g;

/** 行数相同、仅行首缩进加深的差异：列表续段/子列表缩进对齐到列表标记宽度 */
function isListIndentWidening(before: string, after: string): boolean {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  if (beforeLines.length !== afterLines.length) return false;
  let widened = false;
  for (let index = 0; index < beforeLines.length; index += 1) {
    const left = beforeLines[index];
    const right = afterLines[index];
    if (left === right) continue;
    const leftIndent = /^ */.exec(left)?.[0].length ?? 0;
    const rightIndent = /^ */.exec(right)?.[0].length ?? 0;
    if (left.slice(leftIndent) !== right.slice(rightIndent) || rightIndent <= leftIndent) return false;
    widened = true;
  }
  return widened;
}

/** 有序列表行去掉编号后的形态（用于识别仅编号不同的差异） */
const withoutListNumbers = (value: string) => value.replace(/^(\s*)\d+([.)]\s)/gm, '$1#$2');

/** 判断一处差异属于哪类规范化（启发式，仅用于说明，不影响行为） */
function classifyHunk(before: string, after: string): NormalizationCategory {
  const compact = (value: string) => value.replace(/\s+/g, '');
  if (compact(before) === compact(after)) {
    // 逐行去掉行尾空白后相同：只差行尾空格；否则为空行或缩进差异
    const trimLines = (value: string) => value.split('\n').map((line) => line.trimEnd()).join('\n');
    if (trimLines(before) === trimLines(after)) return 'trailing-whitespace';
    return isListIndentWidening(before, after) ? 'list-indent' : 'whitespace';
  }
  const entityCount = (value: string) => value.match(HTML_ENTITY_PATTERN)?.length ?? 0;
  if (entityCount(before) !== entityCount(after)) return 'entity';
  if (/^\s*[*+]\s/m.test(before) && /^\s*-\s/m.test(after)) return 'list-marker';
  if (/^\s*\d+\)\s/m.test(before) && /^\s*\d+\.\s/m.test(after)) return 'list-marker';
  if (before !== after && withoutListNumbers(before) === withoutListNumbers(after)) return 'list-number';
  if (/^\s*(?:=+|-+)\s*$/m.test(before) && /^#{1,2}\s/m.test(after)) return 'heading';
  if (/^ {0,3}(?:(?:\*\s*){3,}|(?:_\s*){3,})$/m.test(before) && /^---$/m.test(after)) return 'horizontal-rule';
  if (/^ {0,3}(?:`{3,}|~{3,})/m.test(after) && (/^ {0,3}(?:`{3,}|~{3,})/m.test(before) || /^ {4}/m.test(before))) {
    return 'code-fence';
  }
  if (/^\s*\|/m.test(before) || /^\s*\|/m.test(after)) return 'table';
  if ((/<https?:\/\/[^>]+>/.test(before) || /\]\[[^\]]*\]|^\s*\[[^\]]+\]:\s/m.test(before)) && /\]\(/.test(after)) {
    return 'link';
  }
  if (/<br\s*\/?>/i.test(before) && !/<br\s*\/?>/i.test(after)) return 'line-break';
  if (/(^|[^\w])_{1,2}\S/.test(before) && /\*{1,2}\S/.test(after)) return 'emphasis';
  if (before.replace(/\\/g, '') === after.replace(/\\/g, '')) return 'escape';
  return 'other';
}

/** 行起点：给定偏移所在行的行首偏移 */
function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

/** 行终点：给定偏移所在行的行尾偏移（不含换行符） */
function lineEndOf(text: string, offset: number): number {
  const index = text.indexOf('\n', offset);
  return index < 0 ? text.length : index;
}

/**
 * 计算原文与规范化结果的整行差异块与分类统计。
 * 差异算法复用 @codemirror/merge（按需加载，与文本对比工具共享分包）。
 */
export async function computeNormalizationDiff(
  original: string,
  normalized: string,
  maxHunks = 50,
): Promise<NormalizationDiff> {
  const { diff } = await import('@codemirror/merge');
  const before = original.replace(/\r\n/g, '\n');
  const after = normalized.replace(/\r\n/g, '\n');
  const changes = diff(before, after, { scanLimit: 5000 });

  // 把字符级变更扩展为整行区间，并合并相邻/重叠的区间
  const ranges: Array<{ fromA: number; toA: number; fromB: number; toB: number }> = [];
  for (const change of changes) {
    const range = {
      fromA: lineStartOf(before, change.fromA),
      toA: lineEndOf(before, change.toA),
      fromB: lineStartOf(after, change.fromB),
      toB: lineEndOf(after, change.toB),
    };
    const last = ranges[ranges.length - 1];
    if (last && range.fromA <= last.toA + 1) {
      last.toA = Math.max(last.toA, range.toA);
      last.toB = Math.max(last.toB, range.toB);
    } else {
      ranges.push(range);
    }
  }

  const counts = new Map<NormalizationCategory, number>();
  const hunks: NormalizationHunk[] = [];
  for (const range of ranges) {
    const hunkBefore = before.slice(range.fromA, range.toA);
    const hunkAfter = after.slice(range.fromB, range.toB);
    const category = classifyHunk(hunkBefore, hunkAfter);
    counts.set(category, (counts.get(category) ?? 0) + 1);
    if (hunks.length < maxHunks) {
      hunks.push({
        before: hunkBefore,
        after: hunkAfter,
        line: before.slice(0, range.fromA).split('\n').length,
        category,
      });
    }
  }

  return {
    hunks,
    categories: [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((left, right) => right.count - left.count),
  };
}
