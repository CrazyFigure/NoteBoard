// NoteBoard 沉浸阅读窗口控件（各格式共用）
// 外壳隐藏后由它接管窗口操作：鼠标移到右上角展开胶囊（最小化 / 全屏 / 退出），顶部细条用于拖动窗口
// 平台差异：网页没有最小化与拖动，macOS 全屏时没有最小化，移动端只有退出；无悬停的触屏设备胶囊常驻（低透明度）

import React, { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogOut, Maximize, Minimize, Minus } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { TitleBarDragRegion } from '../../components/titlebar/TitleBarDragRegion';
import { IS_MOBILE_UI, IS_WEB } from '../../core/platform';
import {
  canMinimizeReadingWindow,
  canToggleReadingFullscreen,
  toggleReadingFullscreen,
  useWindowFullscreen,
} from './readingMode';

/** 进入阅读时胶囊短暂显示多久（毫秒），提示窗口控件收在右上角 */
const ENTRY_HINT_DURATION = 1800;

interface ReadingWindowControlsProps {
  onExit: () => void;
  /** 阅读进度百分比；没有可见滚动容器时不显示 */
  percent?: number | null;
  /** 退出提示是否显示 Esc 快捷键（所在格式未接管 Esc 时关闭） */
  escHint?: boolean;
  /** 是否显示顶部拖动细条（保留工具栏的格式改由工具栏空白处拖动） */
  dragStrip?: boolean;
  /** 热区与胶囊层级低于格式自带的浮动工具栏，工具栏展开时不遮挡其按钮 */
  belowToolbar?: boolean;
}

interface CapsuleButtonProps {
  label: string;
  shortcut?: string;
  className: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}

function CapsuleButton({ label, shortcut, className, onClick, children }: CapsuleButtonProps) {
  const [pressed, setPressed] = useState(false);
  return (
    <Tooltip content={label} shortcut={shortcut} side="bottom" align="end" sideOffset={8}>
      <button
        type="button"
        className={className}
        data-pressed={pressed ? 'true' : 'false'}
        aria-label={label}
        onMouseDown={() => setPressed(true)}
        onMouseUp={() => setPressed(false)}
        onMouseLeave={() => setPressed(false)}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function ReadingWindowControls({ onExit, percent = null, escHint = true, dragStrip = true, belowToolbar = false }: ReadingWindowControlsProps) {
  const [hinting, setHinting] = useState(true);
  const [hovered, setHovered] = useState(false);
  const isFullscreen = useWindowFullscreen(true);

  useEffect(() => {
    const timer = setTimeout(() => setHinting(false), ENTRY_HINT_DURATION);
    return () => clearTimeout(timer);
  }, []);

  // 最小化或切走窗口时收不到 pointerleave，失焦时主动收起，避免恢复后胶囊常驻；
  // 焦点进入 iframe（如 Draw.io 加载完成）同样触发 blur，此时窗口仍有焦点，不算离开
  useEffect(() => {
    const collapse = () => {
      if (!document.hasFocus()) setHovered(false);
    };
    window.addEventListener('blur', collapse);
    return () => window.removeEventListener('blur', collapse);
  }, []);

  // 同时监听 pointermove：热区挂载到静止指针下方时（入口按钮常在右上角）不会产生 pointerenter，
  // 只靠进入事件的话胶囊淡出后移动鼠标也唤不回来；触屏按下不算悬停，否则胶囊在点按中途变化，浏览器不再合成 click
  const handleHover = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') setHovered(true);
  };

  // 最小化前主动释放按钮焦点，避免窗口恢复焦点时 Radix 再次打开 Tooltip
  const handleMinimize = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.blur();
    void getCurrentWindow().minimize();
  };

  const fullscreenLabel = isFullscreen ? '退出全屏' : '全屏';
  // 全屏窗口无法移动，网页与移动端不拥有原生窗口
  const showDragStrip = dragStrip && !IS_WEB && !IS_MOBILE_UI && !isFullscreen;

  return (
    <>
      {showDragStrip && (
        <div className="nb-reading-drag">
          <TitleBarDragRegion />
        </div>
      )}

      {/* 展开期间铺满窗口：跨进程 iframe 上方父页面收不到指针事件，离开热区时须落在实体元素上才能收起 */}
      {hovered && <div className="nb-reading-hover-shield" aria-hidden="true" />}

      {/* 右上角热区：iframe 内的指针移动不会冒泡到窗口，必须用实体元素感知悬停 */}
      <div
        className="nb-reading-corner"
        data-below-toolbar={belowToolbar ? 'true' : undefined}
        onPointerEnter={handleHover}
        onPointerMove={handleHover}
        onPointerLeave={() => setHovered(false)}
      >
        <div className="nb-reading-capsule" data-visible={hinting || hovered ? 'true' : 'false'}>
          {percent !== null && (
            <>
              <span className="nb-reading-percent">{percent}%</span>
              <span className="nb-reading-divider" aria-hidden="true" />
            </>
          )}
          {canMinimizeReadingWindow(isFullscreen) && (
            <CapsuleButton label="最小化" className="nb-reading-icon-btn" onClick={handleMinimize}>
              <Minus size={15} />
            </CapsuleButton>
          )}
          {canToggleReadingFullscreen() && (
            <CapsuleButton label={fullscreenLabel} className="nb-reading-icon-btn" onClick={() => void toggleReadingFullscreen()}>
              {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            </CapsuleButton>
          )}
          <CapsuleButton label="退出沉浸阅读" shortcut={escHint ? 'Esc' : undefined} className="nb-reading-exit" onClick={() => onExit()}>
            <LogOut size={14} strokeWidth={2.2} />
            <span>退出阅读</span>
          </CapsuleButton>
        </div>
      </div>
    </>
  );
}
