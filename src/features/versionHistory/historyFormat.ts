// NoteBoard 文档历史记录：时间线文案（纯函数）
// 按月分组、时间显示与版本摘要，供历史面板与单元测试共用

import type { HistoryEntry, HistoryStats } from '../../core/ipc/types';

export interface MonthGroup {
  key: string;
  label: string;
  entries: HistoryEntry[];
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 按月分组（输入为新到旧，分组保持顺序） */
export function groupByMonth(entries: HistoryEntry[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  for (const entry of entries) {
    const d = new Date(entry.at);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: `${d.getFullYear()}年${d.getMonth() + 1}月`, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

/** 版本时间：今天 14:32 / 昨天 09:10 / 10月21日 09:10 / 2025年6月30日 16:31 */
export function formatEntryTime(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, today)) return `今天 ${time}`;
  if (sameDay(d, yesterday)) return `昨天 ${time}`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

const UNIT_LABEL: Record<string, { measure: string; noun: string }> = {
  char: { measure: '', noun: '字' },
  element: { measure: '个', noun: '元素' },
  node: { measure: '个', noun: '节点' },
  row: { measure: '', noun: '行' },
  cell: { measure: '个', noun: '图形' },
};

/** 改动统计摘要：新增 12 字 · 删除 3 字 / 新增 2 个元素 · 修改 1 个 */
export function formatStats(stats: HistoryStats): string {
  const unit = UNIT_LABEL[stats.unit] ?? UNIT_LABEL.char;
  const parts: string[] = [];
  const amount = (n: number) => `${n} ${unit.measure}${unit.noun}`;
  if (stats.ins > 0) parts.push(`新增 ${amount(stats.ins)}`);
  if ((stats.modified ?? 0) > 0) parts.push(`修改 ${amount(stats.modified ?? 0)}`);
  if (stats.del > 0) parts.push(`删除 ${amount(stats.del)}`);
  return parts.length > 0 ? parts.join(' · ') : '细微调整';
}

/** 版本摘要（时间线第二行） */
export function describeEntry(entry: HistoryEntry, all: HistoryEntry[] = [], now: number = Date.now()): string {
  switch (entry.reason) {
    case 'initial':
      return '开始记录';
    case 'external':
      return '应用外修改';
    case 'before-sync':
      return '同步覆盖前的版本';
    case 'sync-pull':
      return entry.stats ? `同步更新 · ${formatStats(entry.stats)}` : '同步更新';
    case 'sync-merge':
      return '合并多端修改';
    case 'before-restore':
      return '还原前的编辑';
    case 'restore': {
      const source = all.find((e) => e.id === entry.restoredFrom);
      return source ? `还原到 ${formatEntryTime(source.at, now)}` : '还原历史版本';
    }
    default:
      return entry.stats ? formatStats(entry.stats) : '保存';
  }
}

/** 字节数格式化 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
