// NoteBoard 思维导图展示样式切换控件
// 提供「布局」与「配色主题」两个轻量下拉，实时切换导图排布与配色。
// 详见 docs/09-开发路线图.md

import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
} from 'lucide-react';
import type { MindmapLayout } from './mindmapTypes';
import { MINDMAP_LAYOUTS, MINDMAP_THEMES } from './mindmapTheme';
import { Tooltip } from '../../components/Tooltip';

/**
 * 思维导图布局结构示意图组件（图形化展示思维导图发散方向与层级骨架）
 * 包含：向右逻辑图、向左逻辑图、双向平衡图、向下组织图
 */
function MindmapLayoutDiagram({
  layout,
  size = 18,
}: {
  layout: MindmapLayout;
  size?: number;
}) {
  const height = Math.round(size * 0.8);

  switch (layout) {
    case 'right':
      // 向右逻辑图示意：左侧根节点，向右弧形发散 3 个分支
      return (
        <svg
          width={size}
          height={height}
          viewBox="0 0 20 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ display: 'block', flexShrink: 0 }}
        >
          {/* 根节点 */}
          <rect x="2" y="5" width="4.5" height="6" rx="1.5" fill="currentColor" />
          {/* 分支连线 */}
          <path
            d="M 6.5 8 C 8.5 8, 9.5 3.5, 12 3.5 M 6.5 8 L 12 8 M 6.5 8 C 8.5 8, 9.5 12.5, 12 12.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          {/* 子节点 */}
          <rect x="12" y="2" width="6" height="3" rx="1" fill="currentColor" opacity={0.75} />
          <rect x="12" y="6.5" width="6" height="3" rx="1" fill="currentColor" opacity={0.75} />
          <rect x="12" y="11" width="6" height="3" rx="1" fill="currentColor" opacity={0.75} />
        </svg>
      );

    case 'left':
      // 向左逻辑图示意：右侧根节点，向左弧形发散 3 个分支
      return (
        <svg
          width={size}
          height={height}
          viewBox="0 0 20 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ display: 'block', flexShrink: 0 }}
        >
          {/* 根节点 */}
          <rect x="13.5" y="5" width="4.5" height="6" rx="1.5" fill="currentColor" />
          {/* 分支连线 */}
          <path
            d="M 13.5 8 C 11.5 8, 10.5 3.5, 8 3.5 M 13.5 8 L 8 8 M 13.5 8 C 11.5 8, 10.5 12.5, 8 12.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          {/* 子节点 */}
          <rect x="2" y="2" width="6" height="3" rx="1" fill="currentColor" opacity={0.75} />
          <rect x="2" y="6.5" width="6" height="3" rx="1" fill="currentColor" opacity={0.75} />
          <rect x="2" y="11" width="6" height="3" rx="1" fill="currentColor" opacity={0.75} />
        </svg>
      );

    case 'balanced':
      // 双向平衡图示意：中心根节点，左右各发散 2 个分支
      return (
        <svg
          width={size}
          height={height}
          viewBox="0 0 20 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ display: 'block', flexShrink: 0 }}
        >
          {/* 中心根节点 */}
          <rect x="7.5" y="5" width="5" height="6" rx="1.5" fill="currentColor" />
          {/* 左侧分支 */}
          <path
            d="M 7.5 8 C 6.5 8, 6 4, 5 4 M 7.5 8 C 6.5 8, 6 12, 5 12"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <rect x="1" y="2.5" width="4" height="3" rx="1" fill="currentColor" opacity={0.75} />
          <rect x="1" y="10.5" width="4" height="3" rx="1" fill="currentColor" opacity={0.75} />
          {/* 右侧分支 */}
          <path
            d="M 12.5 8 C 13.5 8, 14 4, 15 4 M 12.5 8 C 13.5 8, 14 12, 15 12"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <rect x="15" y="2.5" width="4" height="3" rx="1" fill="currentColor" opacity={0.75} />
          <rect x="15" y="10.5" width="4" height="3" rx="1" fill="currentColor" opacity={0.75} />
        </svg>
      );

    case 'tree':
      // 向下组织架构图示意：顶部根节点，向下折线层级发散 3 个分支
      return (
        <svg
          width={size}
          height={height}
          viewBox="0 0 20 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ display: 'block', flexShrink: 0 }}
        >
          {/* 顶部根节点 */}
          <rect x="7" y="1.5" width="6" height="4.5" rx="1.5" fill="currentColor" />
          {/* 组织架构层级连线 */}
          <path
            d="M 10 6 L 10 9 M 3.75 9 L 16.25 9 M 3.75 9 L 3.75 11.5 M 10 9 L 10 11.5 M 16.25 9 L 16.25 11.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* 底部子节点 */}
          <rect x="1.5" y="11.5" width="4.5" height="3" rx="1" fill="currentColor" opacity={0.75} />
          <rect x="7.75" y="11.5" width="4.5" height="3" rx="1" fill="currentColor" opacity={0.75} />
          <rect x="14" y="11.5" width="4.5" height="3" rx="1" fill="currentColor" opacity={0.75} />
        </svg>
      );
  }
}

interface MindmapStyleControlsProps {
  layout: MindmapLayout;
  themeId: string;
  onLayoutChange: (layout: MindmapLayout) => void;
  onThemeChange: (themeId: string) => void;
}

/** 通用下拉浮层容器（点击外部自动收起） */
function Dropdown({
  trigger,
  children,
  open,
  onOpenChange,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** 下拉菜单项组件（具备即时 Hover / Active 反馈） */
function DropdownItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className="nb-mindmap-style-item"
      data-active={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function MindmapStyleControls({
  layout,
  themeId,
  onLayoutChange,
  onThemeChange,
}: MindmapStyleControlsProps) {
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);

  const activeLayout = MINDMAP_LAYOUTS.find((l) => l.id === layout) ?? MINDMAP_LAYOUTS[0];
  const activeTheme = MINDMAP_THEMES.find((t) => t.id === themeId) ?? MINDMAP_THEMES[0];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 4 }}>
      {/* 布局切换：采用结构示意图替代纯文字，大幅精简操作栏宽度 */}
      <Dropdown
        open={layoutOpen}
        onOpenChange={setLayoutOpen}
        trigger={
          <Tooltip content={`布局：${activeLayout.name}`} side="bottom" sideOffset={4}>
            <span
              className="nb-mindmap-style-trigger"
              data-active={layoutOpen}
            >
              <MindmapLayoutDiagram layout={activeLayout.id} size={18} />
              <ChevronDown size={11} style={{ opacity: 0.6 }} />
            </span>
          </Tooltip>
        }
      >
        {MINDMAP_LAYOUTS.map((item) => (
          <DropdownItem
            key={item.id}
            active={item.id === layout}
            onClick={() => {
              onLayoutChange(item.id);
              setLayoutOpen(false);
            }}
          >
            <MindmapLayoutDiagram layout={item.id} size={18} />
            <span style={{ flex: 1 }}>{item.name}</span>
            {item.id === layout && <Check size={12} />}
          </DropdownItem>
        ))}
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
