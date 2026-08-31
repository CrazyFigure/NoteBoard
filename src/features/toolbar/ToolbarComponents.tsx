// NoteBoard 顶部操作栏基础 UI 组件集
// 包含：基础按钮、下拉菜单容器、多级子菜单项、调色盘、分割线等
// 严格遵循 Hover、Active、Pressed 状态反馈与主题 Token

import React, { useState, useEffect, useRef, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Check } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';

// ── 基础工具栏按钮 ──

export interface ToolbarButtonProps {
  icon?: ReactNode;
  label?: string;
  title?: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  danger?: boolean;
  hasDropdown?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * 顶部操作栏单按钮组件
 * 具备 Hover 底色、Active 高亮、Pressed 微缩动效与 Tooltip 提示
 */
export function ToolbarButton({
  icon,
  label,
  title,
  shortcut,
  active,
  disabled,
  onClick,
  danger,
  hasDropdown,
  style,
}: ToolbarButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  // 动态计算背景色与文字颜色
  let background = 'transparent';
  let color = 'var(--editor-text-secondary, var(--editor-text))';
  let border = '1px solid transparent';

  if (disabled) {
    color = 'var(--editor-text-muted, #9ca3af)';
  } else if (active) {
    background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.15))';
    color = 'var(--accent-500, #3b82f6)';
    border = '1px solid var(--editor-border-focus, rgba(59, 130, 246, 0.3))';
  } else if (pressed) {
    background = 'var(--toolbar-active, rgba(0, 0, 0, 0.12))';
  } else if (hovered) {
    if (danger) {
      background = 'rgba(239, 68, 68, 0.12)';
      color = '#ef4444';
    } else {
      background = 'var(--toolbar-hover, rgba(0, 0, 0, 0.06))';
      color = 'var(--editor-text)';
    }
  }

  return (
    <Tooltip content={title} shortcut={shortcut} disabled={disabled || !title} side="bottom" sideOffset={6}>
      <button
        type="button"
        aria-label={title || label}
        disabled={disabled}
        onMouseDown={(e) => {
          if (!disabled) {
            e.preventDefault();
            setPressed(true);
          }
        }}
        onMouseUp={() => setPressed(false)}
        onClick={(e) => {
          if (!disabled && onClick) {
            onClick(e);
          }
        }}
        onMouseEnter={() => !disabled && setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          setPressed(false);
        }}
        style={{
          height: 28,
          minWidth: label ? undefined : 28,
          padding: label ? '0 8px' : '0 6px',
          border,
          background,
          color,
          opacity: disabled ? 0.38 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: 12,
          fontFamily: 'var(--ui-font-family, inherit)',
          borderRadius: 5,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          transform: !disabled && pressed ? 'scale(0.93)' : !disabled && hovered ? 'scale(1.04)' : 'scale(1)',
          transition: 'all var(--transition-fast, 150ms ease)',
          userSelect: 'none',
          flexShrink: 0,
          ...style,
        }}
      >
        {icon && <span style={{ display: 'flex', alignItems: 'center', fontSize: 14 }}>{icon}</span>}
        {label && <span style={{ fontWeight: active ? 600 : 450, whiteSpace: 'nowrap' }}>{label}</span>}
        {hasDropdown && (
          <ChevronDown
            size={12}
            strokeWidth={2}
            style={{
              opacity: 0.7,
              marginLeft: label ? 2 : -2,
              transition: 'transform var(--transition-fast)',
            }}
          />
        )}
      </button>
    </Tooltip>
  );
}

// ── 垂直分割线 ──

export function ToolbarDivider() {
  return (
    <div
      style={{
        width: 1,
        height: 16,
        background: 'var(--editor-border, rgba(0,0,0,0.12))',
        margin: '0 3px',
        flexShrink: 0,
        alignSelf: 'center',
      }}
    />
  );
}

// ── 下拉菜单容器 ──

export interface ToolbarDropdownProps {
  trigger: ReactNode;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  align?: 'left' | 'right';
  style?: React.CSSProperties;
}

export function ToolbarDropdown({
  trigger,
  isOpen,
  onOpenChange,
  children,
  align,
  style,
}: ToolbarDropdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [effectiveAlign, setEffectiveAlign] = useState<'left' | 'right'>(align ?? 'left');

  // 计算下拉菜单对齐方式，防止超出编辑区右边界
  useEffect(() => {
    if (!isOpen || !containerRef.current) return;
    if (align) {
      setEffectiveAlign(align);
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    const editorPanel = containerRef.current.closest('#nb-editor') || document.body;
    const panelRight = editorPanel.getBoundingClientRect().right;
    // 如果向右展开可能会超出编辑区右边缘，则向左靠齐
    if (rect.left + 190 > panelRight) {
      setEffectiveAlign('right');
    } else {
      setEffectiveAlign('left');
    }
  }, [isOpen, align]);

  // 监听外部点击自动关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [isOpen, onOpenChange]);

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <div onClick={() => onOpenChange(!isOpen)} style={{ display: 'inline-flex' }}>
        {trigger}
      </div>

      {isOpen && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            ...(effectiveAlign === 'left' ? { left: 0 } : { right: 0 }),
            zIndex: 120,
            minWidth: 160,
            background: 'var(--editor-surface, #ffffff)',
            border: '1px solid var(--editor-border, #e5e7eb)',
            borderRadius: 7,
            padding: '4px',
            boxShadow: '0 6px 20px rgba(0, 0, 0, 0.16)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            animation: 'nb-fade-in 120ms ease-out',
            ...style,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// ── 下拉菜单项与多级子菜单 ──

export interface ToolbarDropdownItemProps {
  icon?: ReactNode;
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
  /** 若包含二级/三级子菜单，传入子菜单组件 */
  submenu?: ReactNode;
  /** 点击后是否自动关闭当前下拉菜单 */
  closeOnClick?: boolean;
}

export function ToolbarDropdownItem({
  icon,
  label,
  shortcut,
  active,
  disabled,
  danger,
  onClick,
  submenu,
}: ToolbarDropdownItemProps) {
  const [hovered, setHovered] = useState(false);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [flipLeft, setFlipLeft] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasSubmenu = Boolean(submenu);

  let background = 'transparent';
  let color = 'var(--editor-text)';

  if (disabled) {
    color = 'var(--editor-text-muted, #9ca3af)';
  } else if (active) {
    background = 'var(--editor-selection-background, rgba(59, 130, 246, 0.15))';
    color = 'var(--accent-500, #3b82f6)';
  } else if (hovered || submenuOpen) {
    if (danger) {
      background = 'rgba(239, 68, 68, 0.12)';
      color = '#ef4444';
    } else {
      background = 'var(--toolbar-hover, rgba(0, 0, 0, 0.06))';
    }
  }

  // 计算子菜单展开方向：基于编辑区容器 (#nb-editor) 右边界而非整个视口
  const updateSubmenuPosition = () => {
    if (!itemRef.current) return;
    const rect = itemRef.current.getBoundingClientRect();
    const editorPanel = itemRef.current.closest('#nb-editor') || document.body;
    const panelRight = editorPanel.getBoundingClientRect().right;
    const spaceRight = panelRight - rect.right;
    // 右侧剩余空间小于 170px 时，自动向左侧展开二级子菜单，杜绝被右侧大纲栏或面板边框裁剪
    setFlipLeft(spaceRight < 170);
  };

  // 鼠标悬停进入
  const handleMouseEnter = () => {
    if (disabled) return;
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setHovered(true);
    if (hasSubmenu) {
      updateSubmenuPosition();
      setSubmenuOpen(true);
    }
  };

  // 鼠标悬停离开（120ms 防抖缓冲，防止划向子菜单时瞬间关闭）
  const handleMouseLeave = () => {
    setHovered(false);
    if (hasSubmenu) {
      closeTimeoutRef.current = setTimeout(() => {
        setSubmenuOpen(false);
      }, 120);
    }
  };

  // 统一点击处理：含子菜单时点击切换展开状态，叶子项点击执行并冒泡
  const handleClick = (e: React.MouseEvent) => {
    if (disabled) return;
    if (hasSubmenu) {
      e.stopPropagation();
      updateSubmenuPosition();
      setSubmenuOpen((prev) => !prev);
    } else if (onClick) {
      onClick();
    }
  };

  return (
    <div
      ref={itemRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '5px 8px',
        borderRadius: 5,
        background,
        color,
        fontSize: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
        userSelect: 'none',
        transition: 'background var(--transition-fast)',
        whiteSpace: 'nowrap',
      }}
    >
      {/* 左侧图标与标题 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
        {icon && <span style={{ display: 'flex', alignItems: 'center', fontSize: 14 }}>{icon}</span>}
        <span style={{ fontWeight: active ? 600 : 450 }}>{label}</span>
      </div>

      {/* 右侧指示：当前选中 Check、快捷键或子菜单箭头 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 12 }}>
        {active && !hasSubmenu && <Check size={13} strokeWidth={2.5} color="var(--accent-500, #3b82f6)" />}
        {shortcut && (
          <span style={{ fontSize: 11, color: 'var(--editor-text-muted, #9ca3af)', opacity: 0.8 }}>
            {shortcut}
          </span>
        )}
        {hasSubmenu && (
          <ChevronRight
            size={13}
            strokeWidth={2}
            style={{
              opacity: 0.6,
              transform: submenuOpen ? (flipLeft ? 'rotate(180deg)' : 'rotate(0deg)') : 'none',
              transition: 'transform var(--transition-fast)',
            }}
          />
        )}
      </div>

      {/* 二级 / 三级悬浮子菜单 */}
      {hasSubmenu && submenuOpen && (
        <div
          onMouseEnter={() => {
            if (closeTimeoutRef.current) {
              clearTimeout(closeTimeoutRef.current);
              closeTimeoutRef.current = null;
            }
            setSubmenuOpen(true);
          }}
          onMouseLeave={handleMouseLeave}
          style={{
            position: 'absolute',
            top: -4,
            ...(flipLeft
              ? { right: 'calc(100% + 2px)' }
              : { left: 'calc(100% + 2px)' }),
            zIndex: 140,
            minWidth: 160,
            background: 'var(--editor-surface, #ffffff)',
            border: '1px solid var(--editor-border, #e5e7eb)',
            borderRadius: 7,
            padding: '4px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
            backdropFilter: 'blur(12px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            animation: 'nb-fade-in 100ms ease-out',
          }}
        >
          {/* 透明悬停连桥：覆盖父子菜单间隙，确保鼠标移动不会产生盲区 */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              ...(flipLeft ? { right: -6, width: 8 } : { left: -6, width: 8 }),
              pointerEvents: 'auto',
            }}
          />
          {submenu}
        </div>
      )}
    </div>
  );
}

// ── 高亮调色盘组件 ──

export const HIGHLIGHT_COLORS = [
  { name: '柠檬黄', color: '#fef08a', border: '#facc15' },
  { name: '清新绿', color: '#bbf7d0', border: '#4ade80' },
  { name: '天空蓝', color: '#bfdbfe', border: '#60a5fa' },
  { name: '浅紫', color: '#e9d5ff', border: '#c084fc' },
  { name: '蜜桃粉', color: '#fbcfe8', border: '#f472b6' },
  { name: '暖阳橙', color: '#fed7aa', border: '#fb923c' },
  { name: '珊瑚红', color: '#fecaca', border: '#f87171' },
  { name: '湖水青', color: '#a5f3fc', border: '#22d3ee' },
];

export interface HighlightColorPickerProps {
  onSelectColor: (color: string) => void;
  onRemoveHighlight: () => void;
}

export function HighlightColorPicker({
  onSelectColor,
  onRemoveHighlight,
}: HighlightColorPickerProps) {
  return (
    <div style={{ padding: '6px 4px', width: 176 }}>
      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginBottom: 6, paddingLeft: 4 }}>
        选择高亮背景颜色
      </div>
      {/* 8 色调色盘色块网格 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 6,
          marginBottom: 8,
        }}
      >
        {HIGHLIGHT_COLORS.map((item) => (
          <Tooltip key={item.color} content={item.name} side="top" sideOffset={4}>
            <button
              type="button"
              onClick={() => onSelectColor(item.color)}
              style={{
                width: 32,
                height: 24,
                borderRadius: 4,
                background: item.color,
                border: `1px solid ${item.border}`,
                cursor: 'pointer',
                transition: 'transform var(--transition-fast), box-shadow var(--transition-fast)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'scale(1.15)';
                e.currentTarget.style.boxShadow = '0 2px 6px rgba(0,0,0,0.2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'scale(1)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
          </Tooltip>
        ))}
      </div>
      {/* 清除高亮按钮 */}
      <button
        type="button"
        onClick={onRemoveHighlight}
        style={{
          width: '100%',
          padding: '4px 6px',
          borderRadius: 4,
          border: '1px dashed var(--editor-border)',
          background: 'transparent',
          color: 'var(--editor-text-secondary)',
          fontSize: 11,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          transition: 'all var(--transition-fast)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--toolbar-hover)';
          e.currentTarget.style.color = '#ef4444';
          e.currentTarget.style.borderColor = '#ef4444';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--editor-text-secondary)';
          e.currentTarget.style.borderColor = 'var(--editor-border)';
        }}
      >
        清除文本高亮
      </button>
    </div>
  );
}
