// NoteBoard 统一 Tooltip 悬浮提示组件
// 基于 @radix-ui/react-tooltip 封装，自适应晨光/琥珀/墨夜主题，支持自定义延迟与微动效
// 详见 docs/07-UI布局与交互规范.md

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as RadixTooltip from '@radix-ui/react-tooltip';

export interface TooltipProps {
  /** 提示文本或节点 */
  content: React.ReactNode;
  /** 可选：快捷键文本，以微型按键徽标形式在右侧展示 */
  shortcut?: string;
  /** 触发元素 */
  children: React.ReactNode;
  /** 弹出方向，默认 'bottom' */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** 对齐方式，默认 'center' */
  align?: 'start' | 'center' | 'end';
  /** 与触发源的间距，默认 6px */
  sideOffset?: number;
  /** 是否将属性直接合并至子节点（默认 true） */
  asChild?: boolean;
  /** 是否禁用 Tooltip */
  disabled?: boolean;
  /** 显式指定延迟时间（毫秒），默认 100ms */
  delayDuration?: number;
  /**
   * 跟随鼠标指针显示
   * 适合「触发元素本身很宽 / 很高」的场景（如甘特图条形可能横跨上千像素）：
   * 锚定元素中心的提示会离指针非常远。该模式不包裹子元素、只克隆并追加事件，
   * 因此不会因为 disabled 切换而重建 DOM —— 这点很关键，否则会打断双击等连续手势。
   */
  followCursor?: boolean;
}

/**
 * Tooltip 根 Provider，提供统一的延迟配置（100ms）与邻近快速触发体验
 */
export function TooltipProvider({
  children,
  delayDuration = 100,
  skipDelayDuration = 300,
}: {
  children: React.ReactNode;
  delayDuration?: number;
  skipDelayDuration?: number;
}) {
  return (
    <RadixTooltip.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      disableHoverableContent
    >
      {children}
    </RadixTooltip.Provider>
  );
}

/**
 * 鼠标跟随提示
 * 仅克隆子元素并追加指针事件，不额外包裹节点 —— 触发元素的 DOM 保持稳定，
 * 双击、拖拽等需要「同一元素连续事件」的手势不会被重建打断。
 */
function FollowCursorTooltip({
  content,
  shortcut,
  children,
  delayDuration,
  disabled,
}: {
  content: React.ReactNode;
  shortcut?: string;
  children: React.ReactNode;
  delayDuration: number;
  disabled: boolean;
}) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 卸载时清理未触发的延迟计时，避免对已卸载组件 setState
  useEffect(() => clearTimer, [clearTimer]);

  useEffect(() => {
    if (disabled) {
      clearTimer();
      setPoint(null);
    }
  }, [disabled, clearTimer]);

  // 泛型参数用于确保 cloneElement 时追加的事件属性类型合法
  const child = React.isValidElement<Record<string, unknown>>(children) ? children : null;
  const originalProps = (child?.props ?? {}) as {
    onMouseEnter?: (e: React.MouseEvent) => void;
    onMouseMove?: (e: React.MouseEvent) => void;
    onMouseLeave?: (e: React.MouseEvent) => void;
  };

  const handleMouseEnter = (e: React.MouseEvent) => {
    originalProps.onMouseEnter?.(e);
    if (disabled) return;
    clearTimer();
    const { clientX, clientY } = e;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setPoint({ x: clientX, y: clientY });
    }, delayDuration);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    originalProps.onMouseMove?.(e);
    // 已显示时实时跟随指针；尚未显示则不重置延迟计时，保证 100ms 后按时出现
    setPoint((prev) => (prev ? { x: e.clientX, y: e.clientY } : prev));
  };

  const handleMouseLeave = (e: React.MouseEvent) => {
    originalProps.onMouseLeave?.(e);
    clearTimer();
    setPoint(null);
  };

  if (!child) return <>{children}</>;

  const hasContent = Boolean(content) || Boolean(shortcut);
  const clampedX = point ? Math.min(Math.max(point.x, 90), window.innerWidth - 90) : 0;

  return (
    <>
      {React.cloneElement(child, {
        onMouseEnter: handleMouseEnter,
        onMouseMove: handleMouseMove,
        onMouseLeave: handleMouseLeave,
      })}
      {point &&
        hasContent &&
        createPortal(
          // 外层负责定位，内层承载动画：动画 keyframes 会覆盖 transform，写在同一个节点上会让定位失效
          <div
            style={{
              position: 'fixed',
              left: clampedX,
              top: point.y - 14,
              transform: 'translate(-50%, -100%)',
              zIndex: 1000001,
              pointerEvents: 'none',
            }}
          >
            <div
              className="nb-tooltip-content"
              style={{
                position: 'relative',
                animation: 'nb-tooltip-slide-down-and-fade 120ms cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              {typeof content === 'string' ? <span>{content}</span> : content}
              {shortcut && <kbd className="nb-tooltip-kbd">{shortcut}</kbd>}
              <span
                style={{
                  position: 'absolute',
                  bottom: -3.5,
                  left: '50%',
                  width: 6,
                  height: 6,
                  transform: 'translateX(-50%) rotate(45deg)',
                  background: 'var(--editor-surface)',
                  borderRight: '1px solid var(--editor-border)',
                  borderBottom: '1px solid var(--editor-border)',
                }}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 通用 Tooltip 组件
 */
export function Tooltip({
  content,
  shortcut,
  children,
  side = 'bottom',
  align = 'center',
  sideOffset = 6,
  asChild = true,
  disabled = false,
  delayDuration = 100,
  followCursor = false,
}: TooltipProps) {
  // 跟随指针模式必须始终使用同一组件形态，否则 disabled 切换会重建子元素 DOM
  if (followCursor) {
    return (
      <FollowCursorTooltip
        content={content}
        shortcut={shortcut}
        delayDuration={delayDuration}
        disabled={disabled}
      >
        {children}
      </FollowCursorTooltip>
    );
  }

  // 无内容或显式禁用时，直接返回子节点
  if (disabled || (!content && !shortcut)) {
    return <>{children}</>;
  }

  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild={asChild}>
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          className="nb-tooltip-content"
        >
          {typeof content === 'string' ? <span>{content}</span> : content}
          {shortcut && (
            <kbd className="nb-tooltip-kbd">
              {shortcut}
            </kbd>
          )}
          <RadixTooltip.Arrow className="nb-tooltip-arrow" width={8} height={4} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
