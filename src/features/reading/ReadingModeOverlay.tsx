// NoteBoard 沉浸阅读浮层（各格式共用）
// 顶部细进度条 + 右上角窗口控件（见 ReadingWindowControls），Esc 同样可退出
// 只有存在可见滚动容器（Markdown / 代码）时才显示进度，画布类格式只显示窗口控件

import React, { useEffect, useState } from 'react';
import { useReadingEscape } from './readingMode';
import { ReadingWindowControls } from './ReadingWindowControls';

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

  // Esc 退出：让弹窗与输入框优先处理自己的 Esc
  useReadingEscape(true, onExit);

  return (
    <>
      {/* 顶部阅读进度条 */}
      {progress !== null && (
        <div className="nb-reading-progress" aria-hidden="true">
          <div className="nb-reading-progress-bar" style={{ transform: `scaleX(${progress})` }} />
        </div>
      )}

      {/* 右上角窗口控件与顶部拖动条 */}
      <ReadingWindowControls onExit={onExit} percent={progress === null ? null : Math.round(progress * 100)} />
    </>
  );
}
