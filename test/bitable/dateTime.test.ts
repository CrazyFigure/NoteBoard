// NoteBoard 多维表格日期 / 时间字段单元测试
// 覆盖文本宽松解析、按格式渲染、粘贴归一、排序与非法数据的容错回落

import { describe, test, expect } from 'vitest';
import {
  coerceCellValue,
  compareRowsBySortRules,
  formatCellValue,
  formatDateTimeValue,
  formatDatePart,
  formatTimePart,
  getSortDirectionLabels,
  normalizeDateInput,
  normalizeTimeInput,
  nowTimeString,
  parseDateTimeInput,
  resolveDateTimeConfig,
  todayDateString,
} from '@/features/bitable/bitableUtils';
import { parseBitableDocument } from '@/features/bitable/bitableConverter';
import type { BitableColumn, BitableRow } from '@/features/bitable/bitableTypes';

const dateCol: BitableColumn = { id: 'c1', key: 'd', name: '日期', type: 'date' };
const timeCol: BitableColumn = { id: 'c2', key: 't', name: '时间', type: 'time' };
const dateTimeCol: BitableColumn = { id: 'c3', key: 'dt', name: '日期时间', type: 'dateTime' };

describe('日期时间文本解析', () => {
  test('日期支持 - / . 与中文年月日三种间隔写法', () => {
    expect(normalizeDateInput('2026-8-9')).toBe('2026-08-09');
    expect(normalizeDateInput('2026/8/9')).toBe('2026-08-09');
    expect(normalizeDateInput('2026.8.9')).toBe('2026-08-09');
    expect(normalizeDateInput('2026年8月9日')).toBe('2026-08-09');
  });

  test('时间支持中文时分与冒号写法，缺秒补零', () => {
    expect(normalizeTimeInput('9:5')).toBe('09:05:00');
    expect(normalizeTimeInput('09:05:41')).toBe('09:05:41');
    expect(normalizeTimeInput('9时5分')).toBe('09:05:00');
    expect(normalizeTimeInput('9时5分30秒')).toBe('09:05:30');
  });

  test('12 小时制按上午/下午换算，且上午 12 点为 0 时', () => {
    expect(normalizeTimeInput('下午 2:30')).toBe('14:30:00');
    expect(normalizeTimeInput('上午 9:00')).toBe('09:00:00');
    expect(normalizeTimeInput('上午 12:10')).toBe('00:10:00');
    expect(normalizeTimeInput('下午 12:10')).toBe('12:10:00');
  });

  test('越界的时分秒判为非法，避免把脏数据写进存储', () => {
    expect(normalizeTimeInput('25:00')).toBeNull();
    expect(normalizeTimeInput('12:70')).toBeNull();
  });

  test('日期时间组合文本按空格拆分出两段', () => {
    expect(parseDateTimeInput('2026-08-29 09:00:41')).toEqual({
      date: '2026-08-29',
      time: '09:00:41',
    });
    expect(parseDateTimeInput('2026-08-29')).toEqual({ date: '2026-08-29', time: null });
    expect(parseDateTimeInput('09:00')).toEqual({ date: null, time: '09:00:00' });
  });
});

describe('按格式渲染日期时间', () => {
  test('日期格式覆盖 / - . 与年月日等写法', () => {
    expect(formatDatePart('2026-08-29', 'ymd-dash')).toBe('2026-08-29');
    expect(formatDatePart('2026-08-29', 'ymd-slash')).toBe('2026/08/29');
    expect(formatDatePart('2026-08-29', 'ymd-dot')).toBe('2026.08.29');
    expect(formatDatePart('2026-08-29', 'ymd-cn')).toBe('2026年08月29日');
    expect(formatDatePart('2026-08-29', 'mdy-slash')).toBe('08/29/2026');
    expect(formatDatePart('2026-08-29', 'md-cn')).toBe('08月29日');
  });

  test('时间格式覆盖 : 间隔、时分秒与 12 小时制', () => {
    expect(formatTimePart('09:00:41', 'hm')).toBe('09:00');
    expect(formatTimePart('09:00:41', 'hms')).toBe('09:00:41');
    expect(formatTimePart('09:00:41', 'hm-cn')).toBe('09时00分');
    expect(formatTimePart('09:00:41', 'hms-cn')).toBe('09时00分41秒');
    expect(formatTimePart('09:00:41', 'hm-12')).toBe('上午 09:00');
    expect(formatTimePart('14:30:00', 'hm-12')).toBe('下午 02:30');
  });

  test('日期时间字段把两段各自套用对应格式后拼接', () => {
    const config = { dateFormat: 'ymd-cn' as const, timeFormat: 'hms-cn' as const };
    expect(formatDateTimeValue('2026-08-29 09:00:41', 'dateTime', config)).toBe(
      '2026年08月29日 09时00分41秒',
    );
    // 缺时间段的旧数据只渲染日期部分，不应输出 undefined
    expect(formatDateTimeValue('2026-08-29', 'dateTime', config)).toBe('2026年08月29日');
  });

  test('非法存储值原样返回，避免界面出现空白或报错', () => {
    expect(formatDateTimeValue('不是日期', 'date', resolveDateTimeConfig(dateCol))).toBe('不是日期');
    expect(formatDateTimeValue(null, 'date', resolveDateTimeConfig(dateCol))).toBe('');
  });
});

describe('配置解析与粘贴归一', () => {
  test('列上未配置格式时回落默认值', () => {
    expect(resolveDateTimeConfig(dateCol)).toEqual({ dateFormat: 'ymd-dash', timeFormat: 'hm' });
  });

  test('部分配置只覆盖给定项，其余仍取默认值', () => {
    const partial: BitableColumn = { ...dateCol, dateTime: { timeFormat: 'hms' } };
    expect(resolveDateTimeConfig(partial)).toEqual({ dateFormat: 'ymd-dash', timeFormat: 'hms' });
  });

  test('粘贴到日期列时只取日期段，时间列只取时间段', () => {
    expect(coerceCellValue(dateCol, '2026-08-29 09:00:41').value).toBe('2026-08-29');
    expect(coerceCellValue(timeCol, '2026-08-29 09:00:41').value).toBe('09:00:41');
  });

  test('日期时间列缺哪段补哪段：缺时间补零点，缺日期补今天', () => {
    expect(coerceCellValue(dateTimeCol, '2026-08-29').value).toBe('2026-08-29 00:00:00');
    expect(coerceCellValue(dateTimeCol, '09:00:41').value).toBe(`${todayDateString()} 09:00:41`);
  });

  test('完全无法解析的粘贴内容落为空值', () => {
    expect(coerceCellValue(dateCol, '下周三').value).toBeNull();
    expect(coerceCellValue(timeCol, '随便').value).toBeNull();
    expect(coerceCellValue(dateTimeCol, '随便').value).toBeNull();
  });
});

describe('日期时间的导出与排序', () => {
  test('导出的文本按列上的格式渲染，与界面所见一致', () => {
    const styled: BitableColumn = { ...dateCol, dateTime: { dateFormat: 'ymd-cn' } };
    expect(formatCellValue(styled, '2026-08-29')).toBe('2026年08月29日');

    const timeStyled: BitableColumn = { ...timeCol, dateTime: { timeFormat: 'hms' } };
    expect(formatCellValue(timeStyled, '09:00:41')).toBe('09:00:41');
  });

  test('存储串定长补零，字典序即时间序', () => {
    const rows: BitableRow[] = [
      { id: 'r1', c3: '2026-08-29 09:00:00' },
      { id: 'r2', c3: '2026-01-05 23:59:59' },
      { id: 'r3', c3: '2025-12-31 00:00:00' },
    ];
    const asc = [...rows].sort((a, b) =>
      compareRowsBySortRules(a, b, [dateTimeCol], [{ columnId: 'c3', direction: 'asc' }]),
    );
    expect(asc.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
  });

  test('时间列同样按时间先后排序', () => {
    const rows: BitableRow[] = [
      { id: 'r1', c2: '18:00:00' },
      { id: 'r2', c2: '08:30:00' },
    ];
    const asc = [...rows].sort((a, b) =>
      compareRowsBySortRules(a, b, [timeCol], [{ columnId: 'c2', direction: 'asc' }]),
    );
    expect(asc.map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  test('三类字段都有各自的排序方向文案', () => {
    expect(getSortDirectionLabels('date').asc).toContain('日期');
    expect(getSortDirectionLabels('time').asc).toContain('时间');
    expect(getSortDirectionLabels('dateTime').desc).toContain('时间');
  });
});

describe('外部数据的容错', () => {
  test('未配置格式的日期时间列在解析后补齐完整配置', () => {
    const doc = JSON.stringify({
      schemaVersion: 1,
      title: 't',
      columns: [
        { id: 'c1', key: 'd', name: '日期', type: 'date' },
        { id: 'c2', key: 't', name: '时间', type: 'time' },
        { id: 'c3', key: 'dt', name: '日期时间', type: 'dateTime' },
      ],
      rows: [],
      views: [{ id: 'v1', name: '表格', type: 'grid' }],
    });
    const parsed = parseBitableDocument(doc);
    parsed.columns.forEach((c) => {
      expect(c.dateTime).toEqual({ dateFormat: 'ymd-dash', timeFormat: 'hm' });
    });
  });

  test('非法字段类型回落为单行文本', () => {
    const doc = JSON.stringify({
      schemaVersion: 1,
      title: 't',
      columns: [{ id: 'c1', key: 'x', name: 'X', type: 'notAType' }],
      rows: [],
      views: [{ id: 'v1', name: '表格', type: 'grid' }],
    });
    expect(parseBitableDocument(doc).columns[0].type).toBe('text');
  });
});

describe('当前时刻工具', () => {
  test('今天与此刻都产出定长补零的可排序串', () => {
    expect(todayDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nowTimeString()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
