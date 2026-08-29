// NoteBoard 多维表格日期 / 时间 / 日期时间字段编辑器
// 自研日历与时间表盘取代原生 input[type=date]：原生控件弹层无法定制样式，
// 也无法承载三种字段形态与列级的显示格式配置。
// 交互约定：日期选中即提交并关闭；时间逐列调整即时提交；日期时间两者组合，点「完成」或外部点击收起。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { BitableColumn, DateTimeFieldType } from './bitableTypes';
import {
  formatDateTimeValue,
  nowTimeString,
  resolveDateTimeConfig,
  todayDateString,
} from './bitableUtils';
import { FloatingPanel, getAnchorRect, type AnchorRect } from './BitableFloating';
import { Calendar, Check, ChevronLeft, ChevronRight, Clock, X } from 'lucide-react';

/** 星期表头，周日起始（与 Date.getDay() 一致） */
const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 时间列单行高度，用于滚动定位到当前选中项 */
const TIME_ITEM_HEIGHT = 28;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 由年月日拼出存储格式 YYYY-MM-DD */
function toDateString(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

interface DayCell {
  /** 存储格式日期串 */
  date: string;
  day: number;
  /** 是否属于当前展示的月份（前后补齐的相邻月日期需要淡化） */
  inCurrentMonth: boolean;
}

/**
 * 生成指定月份的日历矩阵（固定 6 行 × 7 列）
 * 固定行数是为了切换月份时面板高度不跳变，否则表头下方的浮层会一抖一抖。
 */
function buildMonthMatrix(year: number, month: number): DayCell[] {
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const cells: DayCell[] = [];

  for (let i = 0; i < 42; i += 1) {
    const cursor = new Date(year, month, 1 - startOffset + i);
    cells.push({
      date: toDateString(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()),
      day: cursor.getDate(),
      inCurrentMonth: cursor.getMonth() === month,
    });
  }
  return cells;
}

/** 解析存储串中的日期部分为年/月，非法时回落到今天 */
function parseYearMonth(value: string | null): { year: number; month: number } {
  const matched = value ? /^(\d{4})-(\d{2})-/.exec(value) : null;
  if (matched) return { year: Number(matched[1]), month: Number(matched[2]) - 1 };
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

/** 拆分时间存储串为时/分/秒数字，缺省补 0 */
function parseTimeParts(value: string | null): { h: number; m: number; s: number } {
  const matched = value ? /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(value) : null;
  if (!matched) {
    const now = new Date();
    return { h: now.getHours(), m: now.getMinutes(), s: 0 };
  }
  return { h: Number(matched[1]), m: Number(matched[2]), s: Number(matched[3] ?? 0) };
}

/** 时间列：时 / 分 / 秒三列中按需展示的一列 */
function TimeColumn({
  values,
  selected,
  onSelect,
  label,
}: {
  values: number[];
  selected: number;
  onSelect: (v: number) => void;
  label: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // 打开面板时把选中项滚到可视中部：48 项全部撑开会挤爆浮层，只能滚动取用
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const idx = values.indexOf(selected);
    if (idx < 0) return;
    el.scrollTop = idx * TIME_ITEM_HEIGHT - el.clientHeight / 2 + TIME_ITEM_HEIGHT / 2;
  }, [values, selected]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <div style={{ fontSize: 10, textAlign: 'center', color: 'var(--editor-text-muted, #94a3b8)' }}>
        {label}
      </div>
      <div
        ref={listRef}
        className="nb-bitable-scroll"
        style={{
          height: 168,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: '0 2px',
        }}
      >
        {values.map((v) => {
          const isSelected = v === selected;
          return (
            <button
              key={v}
              type="button"
              // 选中态与 hover/active 态全部走 CSS 类，避免用 JS 逐个维护 hover 背景
              className={`nb-bitable-time-item${isSelected ? ' is-selected' : ''}`}
              onClick={() => onSelect(v)}
            >
              {pad2(v)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const MONTH_NAMES = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];

interface DatePanelProps {
  value: string | null;
  onPick: (date: string) => void;
}

/** 日历面板：月翻页 + 年月快速选择 + 6×7 日期格 + 今天快捷 */
function DatePanel({ value, onPick }: DatePanelProps) {
  const initial = parseYearMonth(value);
  const [year, setYear] = useState(initial.year);
  const [month, setMonth] = useState(initial.month);
  // 视图模式：'days' 日期网格 | 'months' 月份网格 | 'years' 年份网格
  const [viewMode, setViewMode] = useState<'days' | 'months' | 'years'>('days');
  // 年份选择页的起始年份窗口（12 年一页）
  const [yearWindow, setYearWindow] = useState(() => Math.floor(initial.year / 12) * 12);
  const today = todayDateString();

  const cells = useMemo(() => buildMonthMatrix(year, month), [year, month]);

  const shiftMonth = (delta: number) => {
    const next = new Date(year, month + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth());
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* 头部导航与年月切换入口 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        {viewMode === 'days' && (
          <>
            <button
              type="button"
              className="nb-bitable-btn-ghost nb-bitable-cal-nav"
              title="上一月"
              onClick={() => shiftMonth(-1)}
            >
              <ChevronLeft size={14} />
            </button>
            {/* 年月可点击切换到对应网格选择器 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button
                type="button"
                className="nb-bitable-cal-title-btn"
                title="选择年份"
                onClick={() => {
                  setYearWindow(Math.floor(year / 12) * 12);
                  setViewMode('years');
                }}
              >
                {year} 年
              </button>
              <button
                type="button"
                className="nb-bitable-cal-title-btn"
                title="选择月份"
                onClick={() => setViewMode('months')}
              >
                {month + 1} 月
              </button>
            </div>
            <button
              type="button"
              className="nb-bitable-btn-ghost nb-bitable-cal-nav"
              title="下一月"
              onClick={() => shiftMonth(1)}
            >
              <ChevronRight size={14} />
            </button>
          </>
        )}

        {viewMode === 'months' && (
          <>
            <button
              type="button"
              className="nb-bitable-btn-ghost nb-bitable-cal-nav"
              title="上一年"
              onClick={() => setYear((y) => y - 1)}
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              className="nb-bitable-cal-title-btn"
              title="选择年份"
              onClick={() => {
                setYearWindow(Math.floor(year / 12) * 12);
                setViewMode('years');
              }}
            >
              {year} 年
            </button>
            <button
              type="button"
              className="nb-bitable-btn-ghost nb-bitable-cal-nav"
              title="下一年"
              onClick={() => setYear((y) => y + 1)}
            >
              <ChevronRight size={14} />
            </button>
          </>
        )}

        {viewMode === 'years' && (
          <>
            <button
              type="button"
              className="nb-bitable-btn-ghost nb-bitable-cal-nav"
              title="前 12 年"
              onClick={() => setYearWindow((w) => w - 12)}
            >
              <ChevronLeft size={14} />
            </button>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>
              {yearWindow} 年 - {yearWindow + 11} 年
            </div>
            <button
              type="button"
              className="nb-bitable-btn-ghost nb-bitable-cal-nav"
              title="后 12 年"
              onClick={() => setYearWindow((w) => w + 12)}
            >
              <ChevronRight size={14} />
            </button>
          </>
        )}
      </div>

      {/* 日期网格视图 */}
      {viewMode === 'days' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {WEEK_LABELS.map((w) => (
              <div
                key={w}
                style={{
                  textAlign: 'center',
                  fontSize: 10,
                  padding: '2px 0',
                  color: 'var(--editor-text-muted, #94a3b8)',
                }}
              >
                {w}
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {cells.map((cell) => {
              const isSelected = cell.date === value;
              const isToday = cell.date === today;
              return (
                <button
                  key={cell.date}
                  type="button"
                  title={cell.date}
                  className={[
                    'nb-bitable-date-cell',
                    isSelected ? 'is-selected' : '',
                    isToday ? 'is-today' : '',
                    cell.inCurrentMonth ? '' : 'is-outside',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => onPick(cell.date)}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* 月份网格视图 (3×4) */}
      {viewMode === 'months' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 6,
            padding: '4px 0',
            minHeight: 182,
          }}
        >
          {MONTH_NAMES.map((mName, mIdx) => {
            const isSelected = initial.year === year && initial.month === mIdx;
            const now = new Date();
            const isCurrent = now.getFullYear() === year && now.getMonth() === mIdx;
            return (
              <button
                key={mName}
                type="button"
                className={[
                  'nb-bitable-month-cell',
                  isSelected ? 'is-selected' : '',
                  isCurrent ? 'is-current' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  setMonth(mIdx);
                  setViewMode('days');
                }}
              >
                {mName}
              </button>
            );
          })}
        </div>
      )}

      {/* 年份网格视图 (3×4) */}
      {viewMode === 'years' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 6,
            padding: '4px 0',
            minHeight: 182,
          }}
        >
          {Array.from({ length: 12 }, (_, i) => yearWindow + i).map((y) => {
            const isSelected = y === year;
            const isCurrent = y === new Date().getFullYear();
            return (
              <button
                key={y}
                type="button"
                className={[
                  'nb-bitable-year-cell',
                  isSelected ? 'is-selected' : '',
                  isCurrent ? 'is-current' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  setYear(y);
                  setViewMode('months');
                }}
              >
                {y}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface TimePanelProps {
  value: string | null;
  /** 是否展示秒列：时间格式为「时:分」时秒无意义，藏起来让面板更紧凑 */
  withSeconds: boolean;
  onPick: (time: string) => void;
}

/** 时间表盘：时 / 分 / 秒三列滚动选择 */
function TimePanel({ value, withSeconds, onPick }: TimePanelProps) {
  const parts = parseTimeParts(value);
  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);
  const minutes = useMemo(() => Array.from({ length: 60 }, (_, i) => i), []);
  const seconds = useMemo(() => Array.from({ length: 60 }, (_, i) => i), []);

  const emit = (patch: Partial<{ h: number; m: number; s: number }>) => {
    const next = { ...parts, ...patch };
    onPick(`${pad2(next.h)}:${pad2(next.m)}:${pad2(next.s)}`);
  };

  return (
    <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
      <TimeColumn label="时" values={hours} selected={parts.h} onSelect={(h) => emit({ h })} />
      <TimeColumn label="分" values={minutes} selected={parts.m} onSelect={(m) => emit({ m })} />
      {withSeconds && (
        <TimeColumn label="秒" values={seconds} selected={parts.s} onSelect={(s) => emit({ s })} />
      )}
    </div>
  );
}

interface DateTimeFieldEditorProps {
  column: BitableColumn;
  value: unknown;
  onChange: (next: string | null) => void;
  /** cell：表格单元格，紧凑且无边框；form：记录详情侧边栏，带输入框外观 */
  variant?: 'cell' | 'form';
}

/**
 * 日期时间字段的触发器与选择浮层
 * 三种形态共用一套面板组件，仅按字段类型决定「显示日历 / 显示时间 / 两者都显示」。
 */
export function DateTimeFieldEditor({
  column,
  value,
  onChange,
  variant = 'cell',
}: DateTimeFieldEditorProps) {
  const type = column.type as DateTimeFieldType;
  const config = resolveDateTimeConfig(column);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const raw = value === undefined || value === null || value === '' ? null : String(value);
  // 展示文本按列格式渲染，保证界面所见与复制到剪贴板的内容一致
  const displayText = raw ? formatDateTimeValue(raw, type, config) : '';
  const showSeconds = config.timeFormat === 'hms' || config.timeFormat === 'hms-cn';

  const togglePanel = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    // 浮层的外部点击监听会放行触发器自身的点击，故这里必须自己完成 toggle，
    // 否则已打开时再点触发器只会被忽略，看起来像「点了没反应」
    if (anchor) {
      setAnchor(null);
      return;
    }
    const rect = getAnchorRect(e.currentTarget);
    if (rect) setAnchor(rect);
  };

  // 拆出日期段与时间段：dateTime 存储为 'YYYY-MM-DD HH:mm:ss'
  const datePart = raw ? (raw.split(/[\sT]+/)[0] ?? null) : null;
  const timePart = raw ? (raw.split(/[\sT]+/)[1] ?? null) : null;

  /** 日期段变化：date 直接成值，dateTime 与原有时间（缺省零点）拼接 */
  const handlePickDate = (date: string) => {
    if (type === 'date') {
      onChange(date);
      setAnchor(null);
      return;
    }
    onChange(`${date} ${timePart || '00:00:00'}`);
  };

  /** 时间段变化：time 直接成值，dateTime 与原有日期（缺省今天）拼接 */
  const handlePickTime = (time: string) => {
    if (type === 'time') {
      onChange(time);
      return;
    }
    onChange(`${datePart || todayDateString()} ${time}`);
  };

  /** 快捷填入：日期取今天、时间取此刻，两者都有的字段取完整时间戳 */
  const handleFillNow = () => {
    if (type === 'date') onChange(todayDateString());
    else if (type === 'time') onChange(nowTimeString());
    else onChange(`${todayDateString()} ${nowTimeString()}`);
  };

  const isForm = variant === 'form';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={displayText || '点击选择'}
        onClick={togglePanel}
        className="nb-bitable-date-trigger"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          width: '100%',
          height: isForm ? 34 : '100%',
          boxSizing: 'border-box',
          padding: isForm ? '6px 8px' : '2px 6px',
          border: isForm ? '1px solid var(--editor-border, #cbd5e1)' : '1px solid transparent',
          borderRadius: isForm ? 6 : 4,
          background: isForm ? 'var(--editor-bg, #ffffff)' : 'transparent',
          color: displayText ? 'var(--editor-text, #1e293b)' : 'var(--editor-text-muted, #94a3b8)',
          fontSize: 12,
          fontFamily: 'inherit',
          cursor: 'pointer',
          overflow: 'hidden',
        }}
      >
        {type === 'time' ? <Clock size={12} /> : <Calendar size={12} />}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: 'left',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayText || (isForm ? '点击选择' : '-')}
        </span>
        {/* 已有值时给一个就地清除入口，省去打开面板再点清除 */}
        {raw && (
          <span
            role="button"
            tabIndex={-1}
            title="清除"
            className="nb-bitable-btn-ghost"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
            style={{ padding: 0, display: 'inline-flex', opacity: 0.55, flexShrink: 0, marginLeft: 'auto' }}
          >
            <X size={11} />
          </span>
        )}
      </button>

      {anchor && triggerRef.current && (
        <FloatingPanel
          anchor={anchor}
          trigger={triggerRef.current}
          width={type === 'dateTime' ? 356 : type === 'date' ? 228 : 170}
          gap={6}
          onClose={() => setAnchor(null)}
        >
          {type === 'dateTime' ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <DatePanel value={datePart} onPick={handlePickDate} />
              </div>
              <div
                style={{
                  width: 1,
                  alignSelf: 'stretch',
                  background: 'var(--editor-border, #f1f5f9)',
                }}
              />
              <div style={{ flexShrink: 0 }}>
                <TimePanel value={timePart} withSeconds={showSeconds} onPick={handlePickTime} />
              </div>
            </div>
          ) : type === 'date' ? (
            <DatePanel value={datePart} onPick={handlePickDate} />
          ) : (
            <TimePanel value={timePart} withSeconds={showSeconds} onPick={handlePickTime} />
          )}

          {/* 底部快捷操作：与上方选择区隔开一条分隔线 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              paddingTop: 6,
              marginTop: 2,
              borderTop: '1px solid var(--editor-border, #f1f5f9)',
            }}
          >
            <button
              type="button"
              className="nb-bitable-btn-secondary"
              onClick={handleFillNow}
              style={{ padding: '4px 8px', fontSize: 11 }}
            >
              {type === 'date' ? '今天' : type === 'time' ? '现在' : '此刻'}
            </button>
            <button
              type="button"
              className="nb-bitable-btn-secondary"
              onClick={() => {
                onChange(null);
                setAnchor(null);
              }}
              style={{ padding: '4px 8px', fontSize: 11 }}
            >
              清除
            </button>
            {/* 日期时间需要连续调整日期与时间，给一个明确的收起入口而不是依赖外部点击 */}
            {type === 'dateTime' && (
              <button
                type="button"
                className="nb-bitable-btn-primary"
                onClick={() => setAnchor(null)}
                style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 11, gap: 4 }}
              >
                <Check size={12} />
                <span>完成</span>
              </button>
            )}
          </div>
        </FloatingPanel>
      )}
    </>
  );
}
