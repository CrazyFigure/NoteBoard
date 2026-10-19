// NoteBoard 思维导图展示样式切换控件
// 提供「布局」与「配色主题」两个轻量下拉，实时切换导图排布与配色。
// 布局下拉为缩略图卡片网格（9 种结构），底部附连线样式选择（跟随主题 / 曲线 / 直线 / 折线）。
// 详见 docs/09-开发路线图.md

import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Palette,
} from 'lucide-react';
import type { MindmapEdgeStyle, MindmapLayout } from './mindmapTypes';
import { MINDMAP_EDGE_STYLES, MINDMAP_LAYOUTS, MINDMAP_THEMES } from './mindmapTheme';
import { Tooltip } from '../../components/Tooltip';

/** 示意图元素：矩形节点（role 为 'root' 或一级分支序号）与连线 */
interface DiagramRect {
  x: number;
  y: number;
  w: number;
  h: number;
  role: 'root' | number;
}

interface DiagramPath {
  d: string;
  /** 一级分支序号；'axis' 为主轴 / 脊柱 */
  role: number | 'axis';
  filled?: boolean;
}

interface DiagramSpec {
  rects: DiagramRect[];
  paths: DiagramPath[];
}

/** 示意图画布尺寸（viewBox） */
const DIAGRAM_W = 60;
const DIAGRAM_H = 40;

/** 按坐标对逐个变换 path 中的数字（示意图 path 只含成对的绝对坐标） */
function transformPath(d: string, fn: (x: number, y: number) => [number, number]): string {
  const nums = d.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const mapped: string[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const [x, y] = fn(Number(nums[i]), Number(nums[i + 1]));
    mapped.push(String(x), String(y));
  }
  let idx = 0;
  return d.replace(/-?\d+(?:\.\d+)?/g, () => mapped[idx++] ?? '0');
}

/** 水平镜像 */
function mirrorX(spec: DiagramSpec): DiagramSpec {
  return {
    rects: spec.rects.map((r) => ({ ...r, x: DIAGRAM_W - r.x - r.w })),
    paths: spec.paths.map((p) => ({ ...p, d: transformPath(p.d, (x, y) => [DIAGRAM_W - x, y]) })),
  };
}

/** 垂直镜像 */
function mirrorY(spec: DiagramSpec): DiagramSpec {
  return {
    rects: spec.rects.map((r) => ({ ...r, y: DIAGRAM_H - r.y - r.h })),
    paths: spec.paths.map((p) => ({ ...p, d: transformPath(p.d, (x, y) => [x, DIAGRAM_H - y]) })),
  };
}

const RIGHT_SPEC: DiagramSpec = {
  rects: [
    { x: 3, y: 16, w: 13, h: 8, role: 'root' },
    { x: 38, y: 4, w: 18, h: 6, role: 0 },
    { x: 38, y: 17, w: 18, h: 6, role: 1 },
    { x: 38, y: 30, w: 18, h: 6, role: 2 },
  ],
  paths: [
    { d: 'M 16 20 C 27 20 27 7 38 7', role: 0 },
    { d: 'M 16 20 L 38 20', role: 1 },
    { d: 'M 16 20 C 27 20 27 33 38 33', role: 2 },
  ],
};

const TREE_SPEC: DiagramSpec = {
  rects: [
    { x: 22, y: 3, w: 16, h: 8, role: 'root' },
    { x: 3, y: 28, w: 16, h: 7, role: 0 },
    { x: 22, y: 28, w: 16, h: 7, role: 1 },
    { x: 41, y: 28, w: 16, h: 7, role: 2 },
  ],
  paths: [
    { d: 'M 30 11 L 30 19.5 L 11 19.5 L 11 28', role: 0 },
    { d: 'M 30 11 L 30 28', role: 1 },
    { d: 'M 30 11 L 30 19.5 L 49 19.5 L 49 28', role: 2 },
  ],
};

const INDENT_SPEC: DiagramSpec = {
  rects: [
    { x: 3, y: 2, w: 22, h: 7, role: 'root' },
    { x: 13, y: 14, w: 22, h: 6, role: 0 },
    { x: 23, y: 23, w: 20, h: 5, role: 0 },
    { x: 13, y: 31, w: 22, h: 6, role: 1 },
  ],
  paths: [
    { d: 'M 8 9 L 8 17 L 13 17', role: 0 },
    { d: 'M 18 20 L 18 25.5 L 23 25.5', role: 0 },
    { d: 'M 8 9 L 8 34 L 13 34', role: 1 },
  ],
};

/** 各布局的结构示意 */
const DIAGRAM_SPECS: Record<MindmapLayout, DiagramSpec> = {
  right: RIGHT_SPEC,
  left: mirrorX(RIGHT_SPEC),
  balanced: {
    rects: [
      { x: 23, y: 16, w: 14, h: 8, role: 'root' },
      { x: 45, y: 6, w: 13, h: 6, role: 0 },
      { x: 2, y: 6, w: 13, h: 6, role: 1 },
      { x: 45, y: 28, w: 13, h: 6, role: 2 },
      { x: 2, y: 28, w: 13, h: 6, role: 3 },
    ],
    paths: [
      { d: 'M 37 20 C 41 20 41 9 45 9', role: 0 },
      { d: 'M 23 20 C 19 20 19 9 15 9', role: 1 },
      { d: 'M 37 20 C 41 20 41 31 45 31', role: 2 },
      { d: 'M 23 20 C 19 20 19 31 15 31', role: 3 },
    ],
  },
  tree: TREE_SPEC,
  'tree-up': mirrorY(TREE_SPEC),
  'indent-right': INDENT_SPEC,
  'indent-left': mirrorX(INDENT_SPEC),
  timeline: {
    rects: [
      { x: 2, y: 16, w: 12, h: 8, role: 'root' },
      { x: 18, y: 17, w: 9, h: 6, role: 0 },
      { x: 32, y: 17, w: 9, h: 6, role: 1 },
      { x: 46, y: 17, w: 8, h: 6, role: 2 },
      { x: 22, y: 5, w: 12, h: 5, role: 0 },
      { x: 36, y: 31, w: 12, h: 5, role: 1 },
      { x: 49, y: 5, w: 9, h: 5, role: 2 },
    ],
    paths: [
      { d: 'M 14 20 L 55 20', role: 'axis' },
      { d: 'M 58.5 20 L 54.5 17.5 L 54.5 22.5 Z', role: 'axis', filled: true },
      { d: 'M 20 17 L 20 7.5 L 22 7.5', role: 0 },
      { d: 'M 34 23 L 34 33.5 L 36 33.5', role: 1 },
      { d: 'M 47.5 17 L 47.5 7.5 L 49 7.5', role: 2 },
    ],
  },
  fishbone: {
    rects: [
      { x: 46, y: 16, w: 12, h: 8, role: 'root' },
      { x: 25, y: 3, w: 14, h: 5, role: 0 },
      { x: 14, y: 32, w: 14, h: 5, role: 1 },
      { x: 3, y: 3, w: 14, h: 5, role: 2 },
    ],
    paths: [
      { d: 'M 3 20 L 46 20', role: 'axis' },
      { d: 'M 38 20 L 32 8', role: 0 },
      { d: 'M 27 20 L 21 32', role: 1 },
      { d: 'M 16 20 L 10 8', role: 2 },
    ],
  },
};

/**
 * 思维导图布局结构示意图（图形化展示发散方向与层级骨架）
 * @param colors 分支配色；缺省时整体使用 currentColor
 */
export function MindmapLayoutDiagram({
  layout,
  width = 22,
  colors,
  strokeWidth = 2.6,
}: {
  layout: MindmapLayout;
  width?: number;
  colors?: string[];
  strokeWidth?: number;
}) {
  const spec = DIAGRAM_SPECS[layout] ?? RIGHT_SPEC;
  const height = Math.round((width * DIAGRAM_H) / DIAGRAM_W);
  const colorOf = (role: number | 'root' | 'axis') => {
    if (role === 'root' || role === 'axis' || !colors || colors.length === 0) return 'currentColor';
    return colors[role % colors.length];
  };

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${DIAGRAM_W} ${DIAGRAM_H}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden
    >
      {spec.paths.map((p, idx) => (
        <path
          key={`p-${idx}`}
          d={p.d}
          stroke={colorOf(p.role)}
          fill={p.filled ? colorOf(p.role) : 'none'}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={p.role === 'axis' ? 0.5 : 0.9}
        />
      ))}
      {spec.rects.map((r, idx) => (
        <rect
          key={`r-${idx}`}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          rx={r.role === 'root' ? 2.4 : 1.8}
          fill={colorOf(r.role)}
          opacity={r.role === 'root' ? 1 : colors ? 0.9 : 0.7}
        />
      ))}
    </svg>
  );
}

/** 连线样式小图示 */
function EdgeStyleIcon({ edgeStyle }: { edgeStyle: MindmapEdgeStyle }) {
  const d =
    edgeStyle === 'straight'
      ? 'M 2 13 L 14 3'
      : edgeStyle === 'elbow'
        ? 'M 2 13 L 8 13 L 8 3 L 14 3'
        : 'M 2 13 C 8 13 8 3 14 3';
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <path d={d} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface MindmapStyleControlsProps {
  layout: MindmapLayout;
  themeId: string;
  /** 文档显式选择的连线样式；undefined 表示跟随主题 */
  edgeStyle?: MindmapEdgeStyle;
  onLayoutChange: (layout: MindmapLayout) => void;
  onThemeChange: (themeId: string) => void;
  onEdgeStyleChange: (edgeStyle: MindmapEdgeStyle | undefined) => void;
}

/** 通用下拉浮层容器（点击外部自动收起） */
export function Dropdown({
  trigger,
  children,
  open,
  onOpenChange,
  menuStyle,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 覆盖浮层容器样式（如面板宽度） */
  menuStyle?: React.CSSProperties;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open, onOpenChange]);

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <div onClick={() => onOpenChange(!open)} style={{ cursor: 'pointer' }}>
        {trigger}
      </div>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 160,
            padding: 4,
            background: 'var(--editor-surface, #ffffff)',
            border: '1px solid var(--editor-border, #e2e8f0)',
            borderRadius: 8,
            boxShadow: '0 12px 28px rgba(0, 0, 0, 0.16)',
            zIndex: 100002,
            ...menuStyle,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** 下拉菜单项组件（具备即时 Hover / Active 反馈）；不传 active 时作为普通动作项 */
export function DropdownItem({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const isRadio = active !== undefined;
  return (
    <button
      type="button"
      role={isRadio ? 'menuitemradio' : 'menuitem'}
      aria-checked={isRadio ? active : undefined}
      className="nb-mindmap-style-item"
      data-active={Boolean(active)}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** 面板分组小标题 */
const PANEL_LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--editor-text-muted, #94a3b8)',
  padding: '2px 4px 6px',
};

export function MindmapStyleControls({
  layout,
  themeId,
  edgeStyle,
  onLayoutChange,
  onThemeChange,
  onEdgeStyleChange,
}: MindmapStyleControlsProps) {
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);

  const activeLayout = MINDMAP_LAYOUTS.find((l) => l.id === layout) ?? MINDMAP_LAYOUTS[0];
  const activeTheme = MINDMAP_THEMES.find((t) => t.id === themeId) ?? MINDMAP_THEMES[0];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 4 }}>
      {/* 布局切换：缩略图卡片网格 + 连线样式 */}
      <Dropdown
        open={layoutOpen}
        onOpenChange={setLayoutOpen}
        menuStyle={{ width: 320, padding: 8 }}
        trigger={
          <Tooltip content={`布局：${activeLayout.name}`} side="bottom" sideOffset={4}>
            <span
              className="nb-mindmap-style-trigger"
              data-active={layoutOpen}
            >
              <MindmapLayoutDiagram layout={activeLayout.id} width={22} />
              <ChevronDown size={11} style={{ opacity: 0.6 }} />
            </span>
          </Tooltip>
        }
      >
        <div style={PANEL_LABEL_STYLE}>结构</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          {MINDMAP_LAYOUTS.map((item) => (
            <Tooltip key={item.id} content={item.description} side="bottom" sideOffset={4}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={item.id === layout}
                className="nb-mindmap-layout-card"
                data-active={item.id === layout}
                onClick={() => {
                  onLayoutChange(item.id);
                  setLayoutOpen(false);
                }}
              >
                <MindmapLayoutDiagram
                  layout={item.id}
                  width={66}
                  colors={activeTheme.branchColors}
                  strokeWidth={1.8}
                />
                <span>{item.name}</span>
              </button>
            </Tooltip>
          ))}
        </div>

        <div style={{ ...PANEL_LABEL_STYLE, paddingTop: 12 }}>连线</div>
        <div
          role="radiogroup"
          aria-label="连线样式"
          style={{
            display: 'flex',
            gap: 2,
            padding: 2,
            borderRadius: 7,
            background: 'var(--editor-bg, #f1f5f9)',
            border: '1px solid var(--editor-border, #e2e8f0)',
          }}
        >
          <button
            type="button"
            role="radio"
            aria-checked={!edgeStyle}
            className="nb-mindmap-edge-option"
            data-active={!edgeStyle}
            onClick={() => onEdgeStyleChange(undefined)}
          >
            <Palette size={12} />
            <span>跟随主题</span>
          </button>
          {MINDMAP_EDGE_STYLES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={edgeStyle === item.id}
              className="nb-mindmap-edge-option"
              data-active={edgeStyle === item.id}
              onClick={() => onEdgeStyleChange(item.id)}
            >
              <EdgeStyleIcon edgeStyle={item.id} />
              <span>{item.name}</span>
            </button>
          ))}
        </div>
      </Dropdown>

      {/* 配色主题切换：顶部选中的选项精简为 3 个色块，减少宽度预留操作栏空间 */}
      <Dropdown
        open={themeOpen}
        onOpenChange={setThemeOpen}
        trigger={
          <Tooltip content={`配色：${activeTheme.name}`} side="bottom" sideOffset={4}>
            <span
              className="nb-mindmap-style-trigger"
              data-active={themeOpen}
            >
              <span style={{ display: 'flex', gap: 2.5, alignItems: 'center' }}>
                {activeTheme.branchColors.slice(0, 3).map((color, idx) => (
                  <span
                    key={idx}
                    style={{
                      width: 8,
                      height: 11,
                      borderRadius: 2,
                      background: color,
                      display: 'inline-block',
                      boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.08)',
                    }}
                  />
                ))}
              </span>
              <ChevronDown size={11} style={{ opacity: 0.6 }} />
            </span>
          </Tooltip>
        }
      >
        {MINDMAP_THEMES.map((item) => (
          <DropdownItem
            key={item.id}
            active={item.id === themeId}
            onClick={() => {
              onThemeChange(item.id);
              setThemeOpen(false);
            }}
          >
            <span style={{ display: 'flex', gap: 2.5, flexShrink: 0 }}>
              {item.branchColors.slice(0, 5).map((color, idx) => (
                <span
                  key={idx}
                  style={{
                    width: 8,
                    height: 11,
                    borderRadius: 2,
                    background: color,
                    display: 'inline-block',
                    boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.08)',
                  }}
                />
              ))}
            </span>
            <span style={{ flex: 1 }}>{item.name}</span>
            {item.id === themeId && <Check size={12} />}
          </DropdownItem>
        ))}
      </Dropdown>
    </div>
  );
}
