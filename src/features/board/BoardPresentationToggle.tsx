// NoteBoard 画板全屏演示悬浮按钮
// 左上角菜单附近热区负责“靠近显示”，按钮本体提供悬停、按压和键盘焦点反馈

import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

interface BoardPresentationToggleProps {
  /** 当前是否已经进入纯净全屏演示模式 */
  enabled: boolean;
  /** 切换演示模式；只允许修改窗口与布局状态，不能触发文档变更 */
  onToggle: () => void;
}

/**
 * 渲染画板左上角菜单旁的隐形感应热区与全屏切换按钮。
 * 普通与全屏模式都固定显示在三横线菜单右侧，避免覆盖 Excalidraw 靠近时恢复的菜单按钮。
 */
export function BoardPresentationToggle({ enabled, onToggle }: BoardPresentationToggleProps) {
  const [inHotZone, setInHotZone] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const hotZoneRef = useRef<HTMLDivElement>(null);

  // 监听全局指针位置，使不可点击的透明热区不会拦截画板自身操作
  useEffect(() => {
    const hotZone = hotZoneRef.current;
    if (!hotZone) return;

    const handlePointerMove = (event: PointerEvent) => {
      const rect = hotZone.getBoundingClientRect();
      setInHotZone(
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom,
      );
    };

    document.addEventListener('pointermove', handlePointerMove);
    return () => document.removeEventListener('pointermove', handlePointerMove);
  }, []);

  const isHighlighted = isHovered || isFocused;
  const isVisible = isHighlighted || inHotZone;
  const title = enabled ? '退出全屏演示 (Esc)' : '全屏演示画板';
  const Icon = enabled ? Minimize2 : Maximize2;

  return (
    <>
      {/* 左上角 112×96 感应区覆盖菜单附近，只负责测距，不接管任何画布指针事件 */}
      <div
        ref={hotZoneRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 112,
          height: 96,
          zIndex: 29,
          pointerEvents: 'none',
        }}
      />

      <button
        type="button"
        title={title}
        aria-label={title}
        aria-pressed={enabled}
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
        style={{
          position: 'absolute',
          // 与 Excalidraw 左上角菜单保持同一 16px 顶边和 36px 总尺寸
          top: 16,
          left: 62,
          zIndex: 30,
          width: 36,
          height: 36,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          borderRadius: 10,
          border: isHighlighted
            ? '1px solid var(--editor-border-focus)'
            : isVisible
              ? '1px solid var(--editor-border)'
              : '1px solid transparent',
          background: isPressed
            ? 'var(--toolbar-active)'
            : isHighlighted
              ? 'var(--editor-surface)'
              : 'var(--editor-bg)',
          color: isHighlighted
            ? 'var(--accent-strong)'
            : 'var(--editor-text-secondary)',
          boxShadow: isHighlighted
            ? '0 6px 18px rgba(0, 0, 0, 0.18)'
            : isVisible
              ? '0 3px 12px rgba(0, 0, 0, 0.10)'
              : 'none',
          opacity: isHighlighted ? 1 : inHotZone ? 0.86 : 0,
          transform: isPressed
            ? 'translateY(0) scale(0.92)'
            : isVisible
              ? 'translateY(0) scale(1)'
              : 'translateY(-8px) scale(0.94)',
          cursor: 'pointer',
          pointerEvents: isVisible ? 'auto' : 'none',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          outline: isFocused ? '2px solid var(--editor-border-focus)' : 'none',
          outlineOffset: 2,
          transition:
            'opacity var(--transition-normal), transform var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast)',
        }}
      >
        <Icon size={17} strokeWidth={2.1} />
      </button>
    </>
  );
}
