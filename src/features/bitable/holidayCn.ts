// NoteBoard 中国大陆法定节假日数据 (Holiday CN)
// 数据来自开源项目 NateScarlet/holiday-cn（按国务院办公厅放假通知整理，含调休上班日），
// 经 jsDelivr CDN 拉取，失败时回退 GitHub 原始地址；按年份缓存到 localStorage，离线时沿用旧缓存。

import { useEffect, useMemo, useState } from 'react';
import { dateToDayIndex } from './bitableUtils';

/** 天序号 → 是否放假（true：法定假日放假；false：调休上班） */
export type HolidayMap = Map<number, boolean>;

/** 单年数据：published 为 false 表示该年安排尚未发布 */
interface HolidayYear {
  published: boolean;
  /** [日期, 是否放假] */
  days: Array<[string, boolean]>;
}

interface HolidayCacheEntry extends HolidayYear {
  fetchedAt: number;
}

const SOURCES = [
  (year: number) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  (year: number) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
];
const CACHE_PREFIX = 'nb-holiday-cn-';
const DAY_MS = 24 * 3600 * 1000;
/** 已发布年份极少修订，缓存一个月；未发布年份每周复查一次，以便年底通知发布后生效 */
const PUBLISHED_TTL = 30 * DAY_MS;
const UNPUBLISHED_TTL = 7 * DAY_MS;
/** 获取失败后的冷却时间：期间不再联网，避免断网时每次打开甘特图都重试 */
const FAILURE_COOLDOWN = 3600 * 1000;
const FETCH_TIMEOUT = 8000;

/** 进行中的请求：同一年份多处同时取数时只发一次 */
const inflight = new Map<number, Promise<HolidayYear>>();
/** 各年份最近一次获取失败的时间（仅本次运行内有效） */
const failedAt = new Map<number, number>();

/** 缓存是否仍有效：往年安排已成定局，缓存后永不过期（含查不到安排的年份） */
function isCacheFresh(year: number, entry: HolidayCacheEntry): boolean {
  if (year < new Date().getFullYear()) return true;
  const ttl = entry.published ? PUBLISHED_TTL : UNPUBLISHED_TTL;
  return Date.now() - entry.fetchedAt < ttl;
}

function readCache(year: number): HolidayCacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + year);
    return raw ? (JSON.parse(raw) as HolidayCacheEntry) : null;
  } catch {
    return null;
  }
}

function writeCache(year: number, data: HolidayYear) {
  try {
    localStorage.setItem(CACHE_PREFIX + year, JSON.stringify({ ...data, fetchedAt: Date.now() }));
  } catch {
    // 存储不可用时仅失去缓存，不影响本次结果
  }
}

/** 依次尝试各数据源；404 视为「尚未发布」，其余错误继续换源 */
async function fetchYear(year: number): Promise<HolidayYear> {
  let lastError: unknown = null;
  for (const source of SOURCES) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const response = await fetch(source(year), { signal: controller.signal });
      if (response.status === 404) return { published: false, days: [] };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as { days?: Array<{ date: string; isOffDay: boolean }> };
      const days = (json.days || [])
        .filter((d) => typeof d.date === 'string' && typeof d.isOffDay === 'boolean')
        .map((d) => [d.date, d.isOffDay] as [string, boolean]);
      return { published: days.length > 0, days };
    } catch (error) {
      lastError = error;
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('节假日数据获取失败');
}

/**
 * 取某年安排：缓存有效直接用；过期则重新拉取，拉取失败时退回旧缓存
 * 失败冷却期内不联网：有旧缓存用旧缓存，没有则直接报错（调用方按每周休息日兜底）。
 */
export function loadHolidayYear(year: number): Promise<HolidayYear> {
  const cached = readCache(year);
  if (cached && isCacheFresh(year, cached)) return Promise.resolve(cached);

  const lastFailure = failedAt.get(year);
  if (lastFailure !== undefined && Date.now() - lastFailure < FAILURE_COOLDOWN) {
    return cached ? Promise.resolve(cached) : Promise.reject(new Error('节假日数据暂不可用'));
  }

  const pending = inflight.get(year);
  if (pending) return pending;

  const task = fetchYear(year)
    .then((data) => {
      failedAt.delete(year);
      writeCache(year, data);
      return data;
    })
    .catch((error) => {
      failedAt.set(year, Date.now());
      if (cached) return cached;
      throw error;
    })
    .finally(() => inflight.delete(year));
  inflight.set(year, task);
  return task;
}

/** 节假日加载状态：missingYears 为安排尚未发布的年份 */
export interface CnHolidayState {
  holidays: HolidayMap;
  status: 'idle' | 'loading' | 'ready' | 'error';
  missingYears: number[];
}

/**
 * 按年份区间加载节假日（仅在 enabled 时联网）
 * 返回合并后的「天序号 → 是否放假」表，供甘特图判断休息日。
 */
export function useCnHolidays(enabled: boolean, fromYear: number, toYear: number): CnHolidayState {
  const [state, setState] = useState<CnHolidayState>({ holidays: new Map(), status: 'idle', missingYears: [] });

  useEffect(() => {
    if (!enabled) {
      setState({ holidays: new Map(), status: 'idle', missingYears: [] });
      return;
    }
    let cancelled = false;
    const years: number[] = [];
    for (let y = fromYear; y <= toYear; y += 1) years.push(y);
    setState((prev) => ({ ...prev, status: 'loading' }));

    Promise.allSettled(years.map((y) => loadHolidayYear(y))).then((results) => {
      if (cancelled) return;
      const holidays: HolidayMap = new Map();
      const missingYears: number[] = [];
      let failed = false;
      results.forEach((result, idx) => {
        if (result.status === 'rejected') {
          failed = true;
          return;
        }
        if (!result.value.published) missingYears.push(years[idx]);
        result.value.days.forEach(([date, isOffDay]) => {
          const day = dateToDayIndex(date);
          if (day !== null) holidays.set(day, isOffDay);
        });
      });
      setState({ holidays, status: failed ? 'error' : 'ready', missingYears });
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, fromYear, toYear]);

  // 关闭时始终返回空表，避免沿用上一次的节假日
  return useMemo(
    () => (enabled ? state : { holidays: new Map(), status: 'idle', missingYears: [] }),
    [enabled, state],
  );
}
