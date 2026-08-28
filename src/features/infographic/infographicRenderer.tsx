// NoteBoard Infographic 现代化高颜值信息图渲染器
// 自适应主题色彩，支持指标看板、时间线、步骤流程、转化漏斗、对比矩阵、四象限与统计图表

import React from 'react';
import type {
  InfographicData,
  InfographicItem,
  ComparisonGroup,
  QuadrantItem,
} from './infographicTypes';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Check,
  X,
  Sparkles,
  ArrowRight,
} from 'lucide-react';

interface InfographicRendererProps {
  data: InfographicData;
}

/** 预置主题色彩色板（支持浅色与暗黑模式自适应） */
const COLOR_MAP: Record<string, { bg: string; border: string; text: string; lightBg: string }> = {
  blue: { bg: '#3b82f6', border: '#93c5fd', text: '#2563eb', lightBg: 'rgba(59, 130, 246, 0.08)' },
  emerald: { bg: '#10b981', border: '#a7f3d0', text: '#059669', lightBg: 'rgba(16, 185, 129, 0.08)' },
  green: { bg: '#22c55e', border: '#bbf7d0', text: '#16a34a', lightBg: 'rgba(34, 197, 94, 0.08)' },
  purple: { bg: '#8b5cf6', border: '#ddd6fe', text: '#7c3aed', lightBg: 'rgba(139, 92, 246, 0.08)' },
  amber: { bg: '#f59e0b', border: '#fde68a', text: '#d97706', lightBg: 'rgba(245, 158, 11, 0.08)' },
  red: { bg: '#ef4444', border: '#fecaca', text: '#dc2626', lightBg: 'rgba(239, 68, 68, 0.08)' },
  cyan: { bg: '#06b6d4', border: '#a5f3fc', text: '#0891b2', lightBg: 'rgba(6, 182, 212, 0.08)' },
  gray: { bg: '#64748b', border: '#cbd5e1', text: '#475569', lightBg: 'rgba(100, 116, 139, 0.08)' },
};

function getColor(colorName?: string) {
  if (!colorName) return COLOR_MAP.blue;
  return COLOR_MAP[colorName.toLowerCase()] || COLOR_MAP.blue;
}

/**
 * 1. 指标看板组件 (Metric Cards)
 */
function MetricCardsView({ items }: { items: InfographicItem[] }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 14,
        width: '100%',
      }}
    >
      {items.map((item, idx) => {
        const c = getColor(item.color);
        return (
          <div
            key={idx}
            style={{
              padding: '16px 18px',
              borderRadius: 10,
              background: 'var(--editor-surface, #ffffff)',
              border: '1px solid var(--editor-border, #e2e8f0)',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.03)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              position: 'relative',
              overflow: 'hidden',
              transition: 'all 0.2s ease',
            }}
          >
            {/* 顶端色彩装饰条 */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: 3,
                background: `linear-gradient(90deg, ${c.bg}, ${c.border})`,
              }}
            />

            {/* 标签标题与趋势指示 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: 'var(--editor-text-muted, #64748b)', fontWeight: 500 }}>
                {item.label || item.title || '指标'}
              </span>
              {item.change && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    padding: '2px 7px',
                    borderRadius: 12,
                    fontSize: 11,
                    fontWeight: 600,
                    background: item.trend === 'down' ? 'rgba(239, 68, 68, 0.12)' : 'rgba(16, 185, 129, 0.12)',
                    color: item.trend === 'down' ? '#dc2626' : '#16a34a',
                  }}
                >
                  {item.trend === 'up' && <TrendingUp size={11} />}
                  {item.trend === 'down' && <TrendingDown size={11} />}
                  {item.trend === 'neutral' && <Minus size={11} />}
                  <span>{item.change}</span>
                </div>
              )}
            </div>

            {/* 核心数值展示 */}
            <div
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: 'var(--editor-text, #0f172a)',
                letterSpacing: '-0.02em',
                lineHeight: 1.2,
              }}
            >
              {item.value ?? '-'}
            </div>

            {/* 补充说明文本 */}
            {(item.desc || item.description) && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--editor-text-muted, #94a3b8)',
                  lineHeight: 1.4,
                  marginTop: 2,
                }}
              >
                {item.desc || item.description}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 2. 时间线组件 (Timeline)
 */
function TimelineView({ items }: { items: InfographicItem[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: '10px 0', width: '100%' }}>
      {items.map((item, idx) => {
        const c = getColor(item.color);
        const isLast = idx === items.length - 1;
        const isDone = item.status === 'done';
        const isActive = item.status === 'active';

        return (
          <div key={idx} style={{ display: 'flex', gap: 16, position: 'relative' }}>
            {/* 时间线轴与圆点 */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 24 }}>
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: isDone ? c.bg : isActive ? 'var(--editor-surface, #ffffff)' : 'var(--editor-border, #cbd5e1)',
                  border: `3px solid ${c.bg}`,
                  boxShadow: isActive ? `0 0 0 4px ${c.lightBg}` : 'none',
                  zIndex: 2,
                }}
              />
              {!isLast && (
                <div
                  style={{
                    width: 2,
                    flex: 1,
                    minHeight: 44,
                    background: isDone ? c.bg : 'var(--editor-border, #e2e8f0)',
                    margin: '4px 0',
                  }}
                />
              )}
            </div>

            {/* 阶段卡片内容 */}
            <div
              style={{
                flex: 1,
                padding: '0 0 20px 0',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {item.label && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: c.lightBg,
                      color: c.text,
                    }}
                  >
                    {item.label}
                  </span>
                )}
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>
                  {item.title || item.name}
                </span>
              </div>
              {(item.desc || item.description) && (
                <div style={{ fontSize: 12, color: 'var(--editor-text-muted, #64748b)', lineHeight: 1.5 }}>
                  {item.desc || item.description}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 3. 业务步骤组件 (Process Steps)
 */
function ProcessStepsView({ items }: { items: InfographicItem[] }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12,
        width: '100%',
        alignItems: 'stretch',
      }}
    >
      {items.map((item, idx) => {
        const c = getColor(item.color);
        return (
          <div
            key={idx}
            style={{
              padding: '14px 16px',
              borderRadius: 8,
              background: 'var(--editor-surface, #ffffff)',
              border: '1px solid var(--editor-border, #e2e8f0)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              position: 'relative',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  background: c.bg,
                  color: '#ffffff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {idx + 1}
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>
                {item.title || item.label}
              </span>
            </div>
            {(item.desc || item.description) && (
              <div style={{ fontSize: 11, color: 'var(--editor-text-muted, #64748b)', lineHeight: 1.45 }}>
                {item.desc || item.description}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 4. 转化漏斗组件 (Funnel)
 */
function FunnelView({ items }: { items: InfographicItem[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 580, margin: '0 auto' }}>
      {items.map((item, idx) => {
        const c = getColor(item.color);
        // 按阶梯收窄宽度展示漏斗感
        const widthPct = Math.max(45, 100 - idx * 14);

        return (
          <div
            key={idx}
            style={{
              width: `${widthPct}%`,
              margin: '0 auto',
              padding: '10px 16px',
              borderRadius: 8,
              background: `linear-gradient(135deg, ${c.bg}, ${c.border})`,
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)',
              transition: 'transform 0.15s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, opacity: 0.85 }}>0{idx + 1}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{item.label || item.title}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{item.value}</span>
              {item.change && (
                <span style={{ fontSize: 11, opacity: 0.9, background: 'rgba(255, 255, 255, 0.2)', padding: '1px 6px', borderRadius: 10 }}>
                  {item.change}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 5. 方案对比表 (Comparison)
 */
function ComparisonView({ groups }: { groups: ComparisonGroup[] }) {
  if (!groups || groups.length === 0) return null;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${groups.length}, 1fr)`,
        gap: 14,
        width: '100%',
      }}
    >
      {groups.map((group, idx) => {
        const isHighlight = Boolean(group.highlight);
        const c = getColor(group.color);

        return (
          <div
            key={idx}
            style={{
              borderRadius: 10,
              border: isHighlight ? `2px solid ${c.bg}` : '1px solid var(--editor-border, #e2e8f0)',
              background: 'var(--editor-surface, #ffffff)',
              boxShadow: isHighlight ? `0 4px 16px ${c.lightBg}` : '0 2px 6px rgba(0,0,0,0.02)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* 组头 */}
            <div
              style={{
                padding: '14px 16px',
                borderBottom: '1px solid var(--editor-border, #e2e8f0)',
                background: isHighlight ? c.lightBg : 'var(--editor-bg, #f8fafc)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--editor-text, #1e293b)' }}>
                  {group.name}
                </span>
                {isHighlight && <Sparkles size={13} color={c.text} />}
              </div>
              {group.badge && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: c.bg,
                    color: '#ffffff',
                  }}
                >
                  {group.badge}
                </span>
              )}
            </div>

            {/* 特性项目列表 */}
            <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(group.features || []).map((feat, fIdx) => (
                <div
                  key={fIdx}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 8,
                    fontSize: 12,
                    borderBottom: fIdx < group.features.length - 1 ? '1px dashed var(--editor-border, #f1f5f9)' : 'none',
                    paddingBottom: 8,
                  }}
                >
                  <span style={{ color: 'var(--editor-text-muted, #64748b)' }}>{feat.name}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 500 }}>
                    {feat.included === true && <Check size={14} color="#16a34a" />}
                    {feat.included === false && <X size={14} color="#dc2626" />}
                    {feat.value !== undefined && feat.value !== true && feat.value !== false && (
                      <span style={{ color: 'var(--editor-text, #1e293b)' }}>{String(feat.value)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 6. 四象限矩阵 (Quadrant Matrix)
 */
function QuadrantView({ data }: { data: InfographicData }) {
  const points = data.points || [];
  const q = data.quadrants || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      {/* 轴标签指示 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--editor-text-muted, #64748b)' }}>
        <span>⬆ {data.quadrantYLabel || '纵轴 (高)'}</span>
        <span>{data.quadrantXLabel || '横轴 (低 → 高)'} ➡</span>
      </div>

      {/* 四象限网格底板 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gridTemplateRows: '1fr 1fr',
          gap: 8,
          minHeight: 280,
          position: 'relative',
        }}
      >
        {/* Q2 左上 */}
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: 'var(--editor-surface, #ffffff)',
            border: '1px solid var(--editor-border, #e2e8f0)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6' }}>
            {q.q2?.title || '第二象限 (左上)'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--editor-text-muted, #94a3b8)' }}>{q.q2?.desc}</span>
        </div>

        {/* Q1 右上 */}
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: 'rgba(16, 185, 129, 0.05)',
            border: '1px solid rgba(16, 185, 129, 0.25)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: '#10b981' }}>
            {q.q1?.title || '第一象限 (右上)'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--editor-text-muted, #94a3b8)' }}>{q.q1?.desc}</span>
        </div>

        {/* Q3 左下 */}
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: 'var(--editor-bg, #f8fafc)',
            border: '1px solid var(--editor-border, #e2e8f0)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: '#64748b' }}>
            {q.q3?.title || '第三象限 (左下)'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--editor-text-muted, #94a3b8)' }}>{q.q3?.desc}</span>
        </div>

        {/* Q4 右下 */}
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: 'var(--editor-surface, #ffffff)',
            border: '1px solid var(--editor-border, #e2e8f0)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b' }}>
            {q.q4?.title || '第四象限 (右下)'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--editor-text-muted, #94a3b8)' }}>{q.q4?.desc}</span>
        </div>
      </div>

      {/* 散点要素清单标签 */}
      {points.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {points.map((p: QuadrantItem, idx: number) => {
            const c = getColor(p.color);
            return (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 9px',
                  borderRadius: 12,
                  background: c.lightBg,
                  border: `1px solid ${c.border}`,
                  fontSize: 11,
                  color: c.text,
                  fontWeight: 500,
                }}
              >
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: c.bg }} />
                <span>{p.name}</span>
                {p.desc && <span style={{ opacity: 0.75, fontSize: 10 }}>({p.desc})</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 7. 轻量 SVG 统计图表 (Chart)
 */
function ChartView({ data }: { data: InfographicData }) {
  const chart = data.chart;
  if (!chart || !chart.categories || chart.categories.length === 0) return null;

  const categories = chart.categories;
  const series = chart.series || [];
  const maxVal = Math.max(
    1,
    ...series.flatMap((s) => s.data || []),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: '100%' }}>
      {/* 柱状图列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {categories.map((cat, catIdx) => (
          <div key={catIdx} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ fontWeight: 500, color: 'var(--editor-text, #1e293b)' }}>{cat}</span>
            </div>
            {series.map((s, sIdx) => {
              const val = s.data[catIdx] ?? 0;
              const pct = Math.min(100, Math.round((val / maxVal) * 100));
              const c = getColor(s.color || (sIdx === 0 ? 'blue' : 'emerald'));

              return (
                <div key={sIdx} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div
                    style={{
                      flex: 1,
                      height: 16,
                      borderRadius: 4,
                      background: 'var(--editor-bg, #f1f5f9)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        borderRadius: 4,
                        background: `linear-gradient(90deg, ${c.bg}, ${c.border})`,
                        transition: 'width 0.4s ease',
                      }}
                    />
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 600, minWidth: 40, textAlign: 'right', color: 'var(--editor-text, #334155)' }}>
                    {val}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* 系列图例 */}
      {series.length > 1 && (
        <div style={{ display: 'flex', gap: 14, justifyContent: 'center', fontSize: 11 }}>
          {series.map((s, sIdx) => {
            const c = getColor(s.color || (sIdx === 0 ? 'blue' : 'emerald'));
            return (
              <div key={sIdx} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: c.bg }} />
                <span style={{ color: 'var(--editor-text-muted, #64748b)' }}>{s.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 主渲染器组件
 */
export function InfographicRenderer({ data }: InfographicRendererProps) {
  const items = data.data || data.items || [];

  return (
    <div
      className="nb-infographic-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        width: '100%',
        padding: '16px 20px',
        borderRadius: 10,
        background: 'var(--editor-bg, #f8fafc)',
        border: '1px solid var(--editor-border, #e2e8f0)',
      }}
    >
      {/* 标题 */}
      {data.title && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--editor-text, #0f172a)' }}>
              {data.title}
            </span>
          </div>
        </div>
      )}

      {/* 分发渲染对应类型的信息图 */}
      {data.type === 'metric-cards' && <MetricCardsView items={items} />}
      {data.type === 'timeline' && <TimelineView items={items} />}
      {data.type === 'process' && <ProcessStepsView items={items} />}
      {data.type === 'funnel' && <FunnelView items={items} />}
      {data.type === 'comparison' && <ComparisonView groups={data.groups || []} />}
      {data.type === 'quadrant' && <QuadrantView data={data} />}
      {data.type === 'chart' && <ChartView data={data} />}
      {data.type === 'list' && <ProcessStepsView items={items} />}
    </div>
  );
}
