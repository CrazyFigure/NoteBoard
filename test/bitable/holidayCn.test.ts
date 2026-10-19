// @vitest-environment jsdom
// NoteBoard 中国大陆节假日数据单元测试
// 覆盖本地缓存命中、未发布年份、获取失败冷却与往年缓存永不过期，确保不会频繁联网

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadHolidayYear } from '@/features/bitable/holidayCn';

const okResponse = (days: Array<{ name: string; date: string; isOffDay: boolean }>) =>
  ({ ok: true, status: 200, json: async () => ({ days }) }) as Response;

describe('节假日数据缓存', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('已发布年份只联网一次，之后命中本地缓存', async () => {
    fetchMock.mockResolvedValue(okResponse([{ name: '国庆节', date: '2096-10-01', isOffDay: true }]));
    const first = await loadHolidayYear(2096);
    const second = await loadHolidayYear(2096);
    expect(first.published).toBe(true);
    expect(second.days).toEqual([['2096-10-01', true]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('查不到安排（404 或空列表）视为未发布，同样缓存不重复请求', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
    const result = await loadHolidayYear(2097);
    expect(result).toEqual({ published: false, days: [] });
    await loadHolidayYear(2097);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('获取失败后冷却期内不再联网', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(loadHolidayYear(2098)).rejects.toThrow();
    const callsAfterFirst = fetchMock.mock.calls.length;
    await expect(loadHolidayYear(2098)).rejects.toThrow();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  test('往年缓存即使很久以前写入也不再联网', async () => {
    localStorage.setItem(
      'nb-holiday-cn-2020',
      JSON.stringify({ published: true, days: [['2020-01-01', true]], fetchedAt: 0 }),
    );
    const result = await loadHolidayYear(2020);
    expect(result.days).toEqual([['2020-01-01', true]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
