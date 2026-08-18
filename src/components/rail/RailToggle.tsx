// NoteBoard RailToggle
// 折叠把手：14×48px、垂直居中、悬浮隐藏（0 → 0.35 → 1）
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
  const [opacity, setOpacity] = useState(0);
  const [bg, setBg] = useState('transparent');
  const [iconColor, setIconColor] = useState('var(--rail-fg)');
  const hotZoneRef = useRef<HTMLDivElement>(null);
  const [isFocused, setIsFocused] = useState(false);

  // 悬浮隐藏交互
  useEffect(() => {
    if (!show) return;
    const hotZone = hotZoneRef.current;
    if (!hotZone) return;

    const handleEnter = () => {
      setOpacity(0.35);
      setBg('var(--rail-bg)');
      setIconColor('var(--rail-fg)');
    };
    const handleLeave = () => {
      if (!isFocused) setOpacity(0);
      setBg('transparent');
    };
    const handleMove = (e: MouseEvent) => {
      const rect = hotZone.getBoundingClientRect();
      const inZone =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (inZone) {
        if (opacity === 0) {
          setOpacity(0.35);
          setBg('var(--rail-bg)');
          setIconColor('var(--rail-fg)');
        }
      } else {
        if (!isFocused && opacity < 1) {
          setOpacity(0);
          setBg('transparent');
        }
      }
    };

    // 全局鼠标移动监听（100px 热区检测）
    document.addEventListener('mousemove', handleMove);
    hotZone.addEventListener('mouseenter', handleEnter);
    hotZone.addEventListener('mouseleave', handleLeave);

    return () => {
      document.removeEventListener('mousemove', handleMove);
      hotZone.removeEventListener('mouseenter', handleEnter);
      hotZone.removeEventListener('mouseleave', handleLeave);
    };
  }, [show, opacity, isFocused]);

  if (!show) return null;

  // 方向语义：展开时左把手 ◀（收起），右把手 ▶（收起）
  // 收起时左把手 ▶（展开），右把手 ◀（展开）
  const isLeft = side === 'left';
  const arrowPointsLeft = isLeft ? visible : !visible;
  const icon = arrowPointsLeft ? (
    <ChevronLeft size={12} color={iconColor} />
  ) : (
    <ChevronRight size={12} color={iconColor} />
  );

  // 把手位置
  const positionStyle: React.CSSProperties = isLeft
    ? { left: 0, borderRadius: '0 6px 6px 0' }
    : { right: 0, borderRadius: '6px 0 0 6px' };

  return (
    <>
      {/* 不可见热区 100×120px */}
      <div
        ref={hotZoneRef}
        style={{
          position: 'absolute',
          top: '50%',
          ...(isLeft ? { left: 0 } : { right: 0 }),
          transform: 'translateY(-50%)',
          width: 100,
          height: 120,
          zIndex: 20,
          pointerEvents: 'none',
        }}
      />
      {/* 把手本体 */}
      <button
        style={{
          position: 'absolute',
          top: '50%',
          transform: 'translateY(-50%)',
          width: 14,
          height: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: bg,
          border: opacity > 0 ? `1px solid var(--editor-border)` : 'none',
          opacity: isFocused ? 1 : opacity,
          transition: 'opacity var(--transition-normal), background var(--transition-fast)',
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
        onFocus={() => {
          setIsFocused(true);
          setOpacity(1);
          setBg('var(--rail-hover-bg)');
          setIconColor('var(--editor-text)');
        }}
        onBlur={() => {
          setIsFocused(false);
          setOpacity(0);
          setBg('transparent');
          setIconColor('var(--rail-fg)');
        }}
        aria-label={ariaLabel}
        aria-expanded={visible}
      >
        {icon}
      </button>
    </>
  );
}
