// NoteBoard Markdown 格式规范化决策
// 可视化编辑器只能以规范格式输出 Markdown（如 `*` 列表统一为 `-`、`_x_` 统一为 `*x*`）。
// 原则：规范化必须经用户同意——进入可视化模式前比较"解析→序列化"结果与原文，
// 不同则按策略（每次询问 / 总是规范化 / 保持源码模式）处理，绝不静默改写文件。

import type { MarkdownNormalizationPolicy } from '../../core/ipc/types';

/** 用户在询问框中的选择：规范化进入可视化，或保持源码模式 */
export type NormalizationChoice = 'normalize' | 'source';

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
}

/** 差异分类：用于向用户说明"会改什么" */
export type NormalizationCategory =
  | 'list-marker'
  | 'emphasis'
  | 'heading'
  | 'table'
  | 'whitespace'
  | 'escape'
  | 'other';

export const NORMALIZATION_CATEGORY_LABELS: Record<NormalizationCategory, string> = {
  'list-marker': '列表符号统一为 -',
  emphasis: '强调符号统一为 * / **',
  heading: '标题写法统一为 #',
  table: '表格列宽对齐',
  whitespace: '空行与空白调整',
  escape: '转义字符调整',
  other: '其他格式调整',
};

export interface NormalizationDiff {
  hunks: NormalizationHunk[];
  categories: Array<{ category: NormalizationCategory; count: number }>;
}

/** 判断一处差异属于哪类规范化（启发式，仅用于说明，不影响行为） */
function classifyHunk(before: string, after: string): NormalizationCategory {
  const compact = (value: string) => value.replace(/\s+/g, '');
  if (compact(before) === compact(after)) return 'whitespace';
  if (/^\s*[*+]\s/m.test(before) && /^\s*-\s/m.test(after)) return 'list-marker';
  if (/^\s*\d+\)\s/m.test(before) && /^\s*\d+\.\s/m.test(after)) return 'list-marker';
  if (/^\s*(?:=+|-+)\s*$/m.test(before) && /^#{1,2}\s/m.test(after)) return 'heading';
  if (/^\s*\|/m.test(before) || /^\s*\|/m.test(after)) return 'table';
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
