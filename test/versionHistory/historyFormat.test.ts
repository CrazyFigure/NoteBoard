// NoteBoard 历史记录时间线文案测试：按月分组、时间显示、版本摘要

import { describe, expect, it } from 'vitest';
import { describeEntry, formatBytes, formatEntryTime, formatStats, groupByMonth } from '../../src/features/versionHistory/historyFormat';
import type { HistoryEntry } from '../../src/core/ipc/types';

function entry(id: string, at: number, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id, start: at, at, hash: id, size: 1, reason: 'save',
    origin: { device: 'd', name: '我的电脑' }, isOwn: true, ...extra,
  };
}

describe('historyFormat', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime();

  it('按月分组并保持新到旧顺序', () => {
    const list = [
      entry('a', new Date(2026, 9, 22).getTime()),
      entry('b', new Date(2026, 9, 1).getTime()),
      entry('c', new Date(2026, 8, 30).getTime()),
      entry('d', new Date(2025, 5, 30).getTime()),
    ];
    const groups = groupByMonth(list);
    expect(groups.map((g) => g.label)).toEqual(['2026年10月', '2026年9月', '2025年6月']);
    expect(groups[0].entries.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('时间显示区分今天、昨天、今年与往年', () => {
    expect(formatEntryTime(new Date(2026, 9, 23, 9, 5).getTime(), now)).toBe('今天 09:05');
    expect(formatEntryTime(new Date(2026, 9, 22, 23, 59).getTime(), now)).toBe('昨天 23:59');
    expect(formatEntryTime(new Date(2026, 5, 30, 16, 31).getTime(), now)).toBe('6月30日 16:31');
    expect(formatEntryTime(new Date(2025, 5, 30, 16, 31).getTime(), now)).toBe('2025年6月30日 16:31');
  });

  it('改动统计按单位生成摘要', () => {
    expect(formatStats({ ins: 12, del: 3, unit: 'char' })).toBe('新增 12 字 · 删除 3 字');
    expect(formatStats({ ins: 2, del: 0, modified: 1, unit: 'element' })).toBe('新增 2 个元素 · 修改 1 个元素');
    expect(formatStats({ ins: 0, del: 0, unit: 'row' })).toBe('细微调整');
  });

  it('按原因描述版本，还原版本引用来源时间', () => {
    const source = entry('src', new Date(2026, 9, 21, 9, 10).getTime());
    const restored = entry('r', now, { reason: 'restore', restoredFrom: 'src' });
    expect(describeEntry(restored, [restored, source], now)).toBe('还原到 10月21日 09:10');
    expect(describeEntry(entry('i', now, { reason: 'initial' }))).toBe('开始记录');
    expect(describeEntry(entry('s', now, { stats: { ins: 1, del: 0, unit: 'char' } }))).toBe('新增 1 字');
    expect(describeEntry(entry('p', now, { reason: 'sync-pull' }))).toBe('同步更新');
  });

  it('字节数格式化', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
