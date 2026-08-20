// NoteBoard 顶部悬浮恢复操作栏胶囊按钮
// 当顶部操作栏被收起后，鼠标靠近编辑区顶部热区（0~36px）时平滑显现
// 点击后展开恢复操作栏，不触发任何文档变更

import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';

interface FloatingExpandHandleProps {
  onExpand: () => void;
}

export function FloatingExpandHandle({ onExpand }: FloatingExpandHandleProps) {
  // 是否处于顶部热区内
  const [inHotZone, setInHotZone] = useState(false);
  // 是否直接悬停在胶囊按钮本体上
  const [isHovered, setIsHovered] = useState(false);
  // 是否处于按压状态
  const [isPressed, setIsPressed] = useState(false);
  const hotZoneRef = useRef<HTMLDivElement>(null);

  // 顶部热区检测：鼠标移动靠近顶部 36px 区域时唤出
  useEffect(() => {
    const hotZone = hotZoneRef.current;
    if (!hotZone) return;

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
  }, []);

  const isHighlighted = isHovered;
  const isVisible = isHighlighted || inHotZone;

  // 视觉样式计算（默认 0，靠近热区 0.85，悬停 1）
  const opacity = isHighlighted ? 1 : inHotZone ? 0.85 : 0;
  const transform = isHighlighted
    ? 'translateX(-50%) translateY(0) scale(1.04)'
    : inHotZone
    ? 'translateX(-50%) translateY(0) scale(1)'
    : 'translateX(-50%) translateY(-10px) scale(0.95)';

  return (
    <>
      {/* 顶部感应热区（整个编辑区顶部 36px 宽度） */}
      <div
        ref={hotZoneRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 36,
          zIndex: 26,
          pointerEvents: 'none',
        }}
      />

      {/* 悬浮恢复胶囊本体 */}
      <button
        type="button"
        title="展开顶部操作栏"
        aria-label="展开顶部操作栏"
        onClick={onExpand}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          setIsPressed(false);
        }}
        onMouseDown={() => setIsPressed(true)}
        onMouseUp={() => setIsPressed(false)}
        style={{
          position: 'absolute',
          top: 6,
          left: '50%',
          transform: `${transform} ${isPressed ? 'scale(0.94)' : ''}`,
          zIndex: 27,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 10px',
          borderRadius: 14,
          background: isHighlighted
            ? 'var(--editor-surface, #ffffff)'
            : 'var(--editor-bg, #f9fafb)',
          border: isHighlighted
            ? '1px solid var(--editor-border-focus, #3b82f6)'
            : inHotZone
            ? '1px solid var(--editor-border, #e5e7eb)'
            : '1px solid transparent',
          boxShadow: isHighlighted
            ? '0 4px 14px rgba(0, 0, 0, 0.16)'
            : inHotZone
            ? '0 2px 8px rgba(0, 0, 0, 0.08)'
            : 'none',
          color: isHighlighted
            ? 'var(--accent-500, #3b82f6)'
            : 'var(--editor-text-secondary, #6b7280)',
          fontSize: 11,
          fontFamily: 'var(--ui-font-family, inherit)',
          cursor: 'pointer',
          userSelect: 'none',
          opacity,
          pointerEvents: isVisible ? 'auto' : 'none',
          backdropFilter: 'blur(8px)',
          transition:
            'opacity var(--transition-normal), transform var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast), color var(--transition-fast)',
        }}
      >
        <ChevronDown size={13} strokeWidth={2.2} />
        <span style={{ fontWeight: 500 }}>展开操作栏</span>
      </button>
    </>
  );
}
