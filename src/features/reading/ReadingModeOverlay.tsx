// NoteBoard 沉浸阅读浮层（各格式共用）
// 顶部细进度条 + 右上角退出胶囊：指针静止时淡出，移动或悬停时恢复，Esc 同样可退出
// 只有存在可见滚动容器（Markdown / 代码）时才显示进度，画布类格式只显示退出按钮

import React, { useEffect, useRef, useState } from 'react';
import { Minimize2 } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { useReadingEscape } from './readingMode';

/** 指针静止多久后胶囊淡出（毫秒） */
const IDLE_DIM_DELAY = 1800;
/** 参与进度计算的滚动容器：可视化内核与源码 CodeMirror */
const SCROLLER_SELECTOR = '.nb-md-visual-scroller, .cm-scroller';

interface ReadingModeOverlayProps {
  /** 编辑器根节点，从中查找当前可见的滚动容器；不传则不显示进度 */
  rootRef?: React.RefObject<HTMLDivElement | null>;
  onExit: () => void;
}

/** 当前可见滚动容器的阅读进度（0~1）；没有可见滚动容器时为 null */
function readProgress(root: HTMLElement | null | undefined): number | null {
  if (!root) return null;
  const scrollers = Array.from(root.querySelectorAll<HTMLElement>(SCROLLER_SELECTOR));
  // display:none 的内核 offsetParent 为空，取实际可见的那一个
  const el = scrollers.find((node) => node.offsetParent !== null);
  if (!el) return null;
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 1;
}

export function ReadingModeOverlay({ rootRef, onExit }: ReadingModeOverlayProps) {
  const [progress, setProgress] = useState<number | null>(null);
  const [awake, setAwake] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 跟踪滚动进度：scroll 不冒泡，在根节点捕获阶段统一监听
  useEffect(() => {
    const root = rootRef?.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setProgress(readProgress(root)));
    };
    const handleScroll = (event: Event) => {
      // 代码块、表格等内部横向滚动不计入阅读进度
      if ((event.target as HTMLElement | null)?.matches?.(SCROLLER_SELECTOR)) update();
    };
    update();
    root.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', update);
    // 进入阅读时可能刚切换到可视化，内容填充后再校正一次
    const settleTimer = setTimeout(update, 300);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settleTimer);
      root.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', update);
    };
  }, [rootRef]);

  // 指针移动时唤醒胶囊，静止后淡出，减少对正文的干扰
  useEffect(() => {
    const wake = () => {
      setAwake(true);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => setAwake(false), IDLE_DIM_DELAY);
    };
    wake();
    window.addEventListener('pointermove', wake);
    return () => {
      window.removeEventListener('pointermove', wake);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  // Esc 退出：让弹窗与输入框优先处理自己的 Esc
  useReadingEscape(true, onExit);

  const visible = awake || hovered;

  return (
    <>
      {/* 顶部阅读进度条 */}
      {progress !== null && (
        <div className="nb-reading-progress" aria-hidden="true">
          <div className="nb-reading-progress-bar" style={{ transform: `scaleX(${progress})` }} />
        </div>
      )}

      {/* 右上角退出胶囊：淡出时保留低透明度，始终可被找到 */}
      <div
        className="nb-reading-capsule"
        data-visible={visible ? 'true' : 'false'}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          setPressed(false);
        }}
      >
        {progress !== null && (
          <>
            <span className="nb-reading-percent">{Math.round(progress * 100)}%</span>
            <span className="nb-reading-divider" aria-hidden="true" />
          </>
        )}
        <Tooltip content="退出沉浸阅读" shortcut="Esc" side="bottom" align="end" sideOffset={8}>
          <button
            type="button"
            className="nb-reading-exit"
            data-pressed={pressed ? 'true' : 'false'}
            aria-label="退出沉浸阅读"
            onMouseDown={() => setPressed(true)}
            onMouseUp={() => setPressed(false)}
            onClick={onExit}
          >
            <Minimize2 size={14} strokeWidth={2.2} />
            <span>退出阅读</span>
          </button>
        </Tooltip>
      </div>
    </>
  );
}
