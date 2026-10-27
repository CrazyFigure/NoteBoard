// NoteBoard 极窄模式标题栏按钮
// 极窄模式切换按钮（常规模式位于主题与设置之间）、自动贴边与窗口置顶钉子（仅极窄模式显示）
// 交互反馈与标题栏其余按钮保持一致：Hover 底色 + 微放大、按下微缩

import { FoldHorizontal, Magnet, Pin, UnfoldHorizontal } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import { useLayoutStore } from '../../stores/layoutStore';
import { requestCompactMode, toggleEdgeDock, toggleWindowPinned } from '../../features/window/compactMode';

interface TitleBarIconButtonProps {
  label: string;
  width: number;
  active?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}

/** 标题栏图标按钮：激活态使用强调色，便于一眼看出当前窗口已置顶 */
function TitleBarIconButton({ label, width, active = false, onClick, children }: TitleBarIconButtonProps) {
  const restColor = active ? 'var(--accent-strong)' : 'var(--editor-text-secondary)';
  const hoverColor = active ? 'var(--accent-strong)' : 'var(--editor-text)';
  return (
    <Tooltip content={label} side="bottom" sideOffset={6}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        style={{
          width,
          height: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          background: 'transparent',
          color: restColor,
          cursor: 'pointer',
          flexShrink: 0,
          transition: 'all var(--transition-fast)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--toolbar-hover)';
          e.currentTarget.style.color = hoverColor;
          e.currentTarget.style.transform = 'scale(1.05)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = restColor;
          e.currentTarget.style.transform = 'scale(1)';
        }}
        onMouseDown={(e) => {
          e.currentTarget.style.background = 'var(--toolbar-active)';
          e.currentTarget.style.transform = 'scale(0.92)';
        }}
        onMouseUp={(e) => {
          e.currentTarget.style.background = 'var(--toolbar-hover)';
          e.currentTarget.style.transform = 'scale(1.05)';
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** 进入 / 退出极窄模式 */
export function CompactModeToggle({ width = 36 }: { width?: number }) {
  const compactMode = useLayoutStore((s) => s.compactMode);
  return (
    <TitleBarIconButton
      label={compactMode ? '退出极窄模式' : '极窄模式'}
      width={width}
      onClick={(e) => {
        // 窗口尺寸变化后按钮可能不在指针下，释放焦点避免 Tooltip 残留
        e.currentTarget.blur();
        void requestCompactMode(!compactMode);
      }}
    >
      {compactMode ? <UnfoldHorizontal size={15} /> : <FoldHorizontal size={15} />}
    </TitleBarIconButton>
  );
}

/** 自动贴边：开启后窗口不能拖出桌面，贴边后鼠标离开即滑出屏幕、碰边滑回 */
export function EdgeDockButton({ width = 36 }: { width?: number }) {
  const enabled = useLayoutStore((s) => s.edgeDockEnabled);
  return (
    <TitleBarIconButton
      label={enabled ? '关闭自动贴边' : '自动贴边'}
      width={width}
      active={enabled}
      onClick={() => void toggleEdgeDock()}
    >
      <Magnet
        size={14}
        style={{
          // 开启时磁铁转向侧边，暗示吸附方向
          transform: enabled ? 'rotate(-90deg)' : 'rotate(0deg)',
          transition: 'transform var(--transition-fast)',
        }}
      />
    </TitleBarIconButton>
  );
}

/** 窗口置顶钉子：置顶时钉子竖直并高亮，未置顶时斜放 */
export function PinWindowButton({ width = 36 }: { width?: number }) {
  const pinned = useLayoutStore((s) => s.windowPinned);
  return (
    <TitleBarIconButton
      label={pinned ? '取消置顶' : '置顶窗口'}
      width={width}
      active={pinned}
      onClick={() => void toggleWindowPinned()}
    >
      <Pin
        size={14}
        fill={pinned ? 'currentColor' : 'none'}
        style={{
          transform: pinned ? 'rotate(0deg)' : 'rotate(45deg)',
          transition: 'transform var(--transition-fast)',
        }}
      />
    </TitleBarIconButton>
  );
}
