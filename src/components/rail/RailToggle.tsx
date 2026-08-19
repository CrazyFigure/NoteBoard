// NoteBoard RailToggle
// 折叠把手：20×56px、垂直居中、悬浮隐藏（0 → 0.75 → 1）
// 详见 docs/07-UI布局与交互规范.md §4

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface RailToggleProps {
  side: 'left' | 'right';
  visible: boolean;
  onToggle: () => void;
  /** 是否渲染（右把手仅 Markdown 显示） */
  show?: boolean;
  /** aria-label */
  ariaLabel: string;
}

export function RailToggle({ side, visible, onToggle, show = true, ariaLabel }: RailToggleProps) {
  // 是否处于热区内
  const [inHotZone, setInHotZone] = useState(false);
  // 是否直接悬停在按钮本体上
  const [isHovered, setIsHovered] = useState(false);
  // 是否处于按压状态
  const [isPressed, setIsPressed] = useState(false);
  // 是否获得键盘焦点
  const [isFocused, setIsFocused] = useState(false);
  const hotZoneRef = useRef<HTMLDivElement>(null);

  // 悬浮热区检测与隐藏交互
  useEffect(() => {
    if (!show) return;
    const hotZone = hotZoneRef.current;
    if (!hotZone) return;

    // 鼠标在页面移动时检测是否进入把手热区
    const handleMouseMove = (e: MouseEvent) => {
      const rect = hotZone.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      setInHotZone(inside);
    };

    document.addEventListener('mousemove', handleMouseMove);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, [show]);

  if (!show) return null;

  // 方向语义：展开时左把手 ◀（收起），右把手 ▶（收起）
  // 收起时左把手 ▶（展开），右把手 ◀（展开）
  const isLeft = side === 'left';
  const arrowPointsLeft = isLeft ? visible : !visible;

  // 活跃状态判断：悬停或聚焦时全亮高显，热区内半显，默认隐藏
  const isHighlighted = isHovered || isFocused;
  const isVisible = isHighlighted || inHotZone;

  // 动态视觉样式计算
  const opacity = isHighlighted ? 1 : inHotZone ? 0.75 : 0;
  const background = isPressed
    ? 'var(--toolbar-active)'
    : isHighlighted
    ? 'var(--rail-hover-bg)'
    : inHotZone
    ? 'var(--rail-bg)'
    : 'transparent';
  const iconColor = isHighlighted
    ? 'var(--editor-text)'
    : 'var(--rail-fg)';
  const border = isHighlighted
    ? '1px solid var(--editor-border-focus)'
    : inHotZone
    ? '1px solid var(--editor-border)'
    : 'none';
  const boxShadow = isHighlighted
    ? '0 3px 10px rgba(0, 0, 0, 0.16)'
    : inHotZone
    ? '0 2px 6px rgba(0, 0, 0, 0.08)'
    : 'none';

  // 图标：尺寸增大至 16px，线条更清晰
  const icon = arrowPointsLeft ? (
    <ChevronLeft size={16} strokeWidth={2.2} color={iconColor} />
  ) : (
    <ChevronRight size={16} strokeWidth={2.2} color={iconColor} />
  );

  // 把手位置及圆角样式
  const positionStyle: React.CSSProperties = isLeft
    ? { left: 0, borderRadius: '0 8px 8px 0' }
    : { right: 0, borderRadius: '8px 0 0 8px' };

  return (
    <>
      {/* 不可见热区 100×140px，便于鼠标靠近即可唤出 */}
      <div
        ref={hotZoneRef}
        style={{
          position: 'absolute',
          top: '50%',
          ...(isLeft ? { left: 0 } : { right: 0 }),
          transform: 'translateY(-50%)',
          width: 100,
          height: 140,
          zIndex: 20,
          pointerEvents: 'none',
        }}
      />
      {/* 把手本体：尺寸调整为 20×56px，视觉更饱满易点击 */}
      <button
        style={{
          position: 'absolute',
          top: '50%',
          transform: `translateY(-50%) ${isPressed ? 'scale(0.92)' : isHovered ? 'scale(1.05)' : 'scale(1)'}`,
          width: 20,
          height: 56,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background,
          border,
          boxShadow,
          opacity,
          transition: 'opacity var(--transition-normal), background var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast)',
          zIndex: 21,
          cursor: 'pointer',
          pointerEvents: 'auto',
          padding: 0,
          ...(isFocused && {
            outline: '2px solid var(--editor-border-focus)',
            outlineOffset: 2,
          }),
          ...positionStyle,
        }}
        onClick={onToggle}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          setIsPressed(false);
        }}
        onMouseDown={() => setIsPressed(true)}
        onMouseUp={() => setIsPressed(false)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => {
          setIsFocused(false);
          setIsPressed(false);
        }}
        aria-label={ariaLabel}
        aria-expanded={visible}
      >
        {icon}
      </button>
    </>
  );
}
