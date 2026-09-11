// NoteBoard 思维导图展示样式切换控件
// 提供「布局」与「配色主题」两个轻量下拉，实时切换导图排布与配色。
// 详见 docs/09-开发路线图.md

import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowLeft,
  ArrowLeftRight,
  ArrowDown,
  Palette,
  Check,
  ChevronDown,
} from 'lucide-react';
import type { MindmapLayout } from './mindmapTypes';
import { MINDMAP_LAYOUTS, MINDMAP_THEMES } from './mindmapTheme';
import { Tooltip } from '../../components/Tooltip';

const LAYOUT_ICONS: Record<MindmapLayout, React.ReactNode> = {
  right: <ArrowRight size={13} />,
  left: <ArrowLeft size={13} />,
  balanced: <ArrowLeftRight size={13} />,
  tree: <ArrowDown size={13} />,
};

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
            minWidth: 190,
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

/** 下拉项通用样式 */
function itemStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '6px 8px',
    borderRadius: 6,
    border: 'none',
    background: active ? 'var(--toolbar-active, rgba(59, 130, 246, 0.12))' : 'transparent',
    color: active ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text, #1e293b)',
    cursor: 'pointer',
    fontSize: 12,
    textAlign: 'left',
    fontWeight: active ? 600 : 400,
  };
}

const triggerStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  padding: '4px 8px',
  borderRadius: 5,
  border: '1px solid var(--editor-border, #e2e8f0)',
  background: 'var(--editor-bg, #ffffff)',
  color: active ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text, #1e293b)',
  fontSize: 12,
  whiteSpace: 'nowrap',
});

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
      {/* 布局切换 */}
      <Dropdown
        open={layoutOpen}
        onOpenChange={setLayoutOpen}
        trigger={
          <Tooltip content="切换思维导图布局" side="bottom" sideOffset={4}>
            <span style={triggerStyle(layoutOpen)}>
              {LAYOUT_ICONS[activeLayout.id]}
              <span>{activeLayout.name}</span>
              <ChevronDown size={12} style={{ opacity: 0.6 }} />
            </span>
          </Tooltip>
        }
      >
        {MINDMAP_LAYOUTS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitemradio"
            aria-checked={item.id === layout}
            onClick={() => {
              onLayoutChange(item.id);
              setLayoutOpen(false);
            }}
            style={itemStyle(item.id === layout)}
          >
            {LAYOUT_ICONS[item.id]}
            <span style={{ flex: 1 }}>{item.name}</span>
            {item.id === layout && <Check size={12} />}
          </button>
        ))}
      </Dropdown>

      {/* 配色主题切换 */}
      <Dropdown
        open={themeOpen}
        onOpenChange={setThemeOpen}
        trigger={
          <Tooltip content="切换导图配色主题" side="bottom" sideOffset={4}>
            <span style={triggerStyle(themeOpen)}>
              <Palette size={13} />
              <span>{activeTheme.name}</span>
              <span style={{ display: 'flex', gap: 2 }}>
                {activeTheme.branchColors.slice(0, 4).map((color, idx) => (
                  <span
                    key={idx}
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: '50%',
                      background: color,
                      display: 'inline-block',
                    }}
                  />
                ))}
              </span>
              <ChevronDown size={12} style={{ opacity: 0.6 }} />
            </span>
          </Tooltip>
        }
      >
        {MINDMAP_THEMES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitemradio"
            aria-checked={item.id === themeId}
            onClick={() => {
              onThemeChange(item.id);
              setThemeOpen(false);
            }}
            style={itemStyle(item.id === themeId)}
          >
            <span style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
              {item.branchColors.map((color, idx) => (
                <span
                  key={idx}
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: color,
                    display: 'inline-block',
                  }}
                />
              ))}
            </span>
            <span style={{ flex: 1 }}>{item.name}</span>
            {item.id === themeId && <Check size={12} />}
          </button>
        ))}
      </Dropdown>
    </div>
  );
}
