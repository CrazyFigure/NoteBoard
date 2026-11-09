// 画板字体按钮的中英文说明提示
// Excalidraw 的字体按钮只带原生 title，且看不出中文会用什么字体显示（只有 Excalifont 的中文回退到小赖）。
// 这里在画板根节点上做事件委托：悬停字体按钮时移除原生 title，改为显示统一样式的 Tooltip。
import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { IS_WEB } from '../../core/platform';
import { useBoardFontPackStore } from '../../stores/boardFontPackStore';

/** 与全局 Tooltip 保持一致的显示延迟 */
const SHOW_DELAY_MS = 100;

/** 快捷字体按钮（属性面板中的三个图标）与“更多字体”按钮、字体列表项 */
const FONT_TARGET_SELECTOR = '[data-testid^="font-family-"], .dropdown-menu.fonts button[value]';

/** 快捷字体按钮的 data-testid 与字体 ID 对应关系（见 Excalidraw FontPicker 的 DEFAULT_FONTS） */
const QUICK_PICK_FONT_IDS: Record<string, number> = {
  'font-family-hand-drawn': 5,
  'font-family-normal': 6,
  'font-family-code': 8,
};

/** Excalidraw 0.18 的字体 ID → 显示名 */
const FONT_NAMES: Record<number, string> = {
  1: 'Virgil（旧版）',
  2: 'Helvetica（旧版）',
  3: 'Cascadia（旧版）',
  5: '手绘 Excalifont',
  6: '普通 Nunito',
  7: 'Lilita One',
  8: '代码 Comic Shanns',
};

const EXCALIFONT_ID = 5;

/** 生成字体说明：只有 Excalifont 的中文回退到小赖，其它字体的中文由系统字体显示 */
export function describeBoardFont(fontId: number, handwritingReady: boolean): string | null {
  const name = FONT_NAMES[fontId];
  if (!name) return null;
  if (fontId !== EXCALIFONT_ID) return `${name} · 中文显示为系统字体`;
  return handwritingReady ? `${name} · 中文显示为小赖手写体` : `${name} · 中文需先在 设置 › 插件 下载小赖`;
}

/** 解析悬停目标对应的提示文本 */
function resolveTargetText(target: HTMLElement, handwritingReady: boolean): string | null {
  const testId = target.dataset.testid;
  if (testId === 'font-family-show-fonts') return '更多字体';
  const fontId = testId ? QUICK_PICK_FONT_IDS[testId] : Number(target.getAttribute('value'));
  return fontId ? describeBoardFont(fontId, handwritingReady) : null;
}

interface TipState {
  text: string;
  /** 列表项提示放在右侧，避免遮住下一项；快捷按钮放在下方 */
  side: 'right' | 'bottom';
  x: number;
  y: number;
}

export function BoardFontTooltip({ rootRef }: { rootRef: RefObject<HTMLElement | null> }) {
  const status = useBoardFontPackStore((s) => s.status);
  const ensureStatus = useBoardFontPackStore((s) => s.ensureStatus);
  useEffect(() => { void ensureStatus(); }, [ensureStatus]);
  const handwritingReady = IS_WEB || status?.state === 'ready';
  // 事件回调里读取最新状态，避免状态变化时重新绑定监听
  const readyRef = useRef(handwritingReady);
  readyRef.current = handwritingReady;

  const [tip, setTip] = useState<TipState | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let timer: number | null = null;
    let anchor: HTMLElement | null = null;

    const hide = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      anchor = null;
      setTip(null);
    };

    const handleOver = (event: PointerEvent) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>(FONT_TARGET_SELECTOR);
      if (!target || target === anchor) return;
      hide();
      const text = resolveTargetText(target, readyRef.current);
      if (!text) return;
      // 移除原生 title，防止与自定义提示重复；图标按钮把原文本留作无障碍名称
      const nativeTitle = target.getAttribute('title');
      if (nativeTitle) {
        if (!target.getAttribute('aria-label')) target.setAttribute('aria-label', nativeTitle);
        target.removeAttribute('title');
      }
      anchor = target;
      timer = window.setTimeout(() => {
        timer = null;
        if (!target.isConnected) return;
        const rect = target.getBoundingClientRect();
        const inList = !target.dataset.testid;
        setTip(inList
          ? { text, side: 'right', x: rect.right + 8, y: rect.top + rect.height / 2 }
          : { text, side: 'bottom', x: rect.left + rect.width / 2, y: rect.bottom + 6 });
      }, SHOW_DELAY_MS);
    };

    const handleOut = (event: PointerEvent) => {
      if (!anchor) return;
      const next = event.relatedTarget as Node | null;
      if (next && anchor.contains(next)) return;
      hide();
    };

    root.addEventListener('pointerover', handleOver);
    root.addEventListener('pointerout', handleOut);
    // 点击选中、滚动列表或键盘操作后，锚点可能被移除或移位，直接收起
    root.addEventListener('pointerdown', hide, true);
    root.addEventListener('wheel', hide, { capture: true, passive: true });
    root.addEventListener('keydown', hide, true);
    return () => {
      hide();
      root.removeEventListener('pointerover', handleOver);
      root.removeEventListener('pointerout', handleOut);
      root.removeEventListener('pointerdown', hide, true);
      root.removeEventListener('wheel', hide, true);
      root.removeEventListener('keydown', hide, true);
    };
  }, [rootRef]);

  if (!tip) return null;
  const isRight = tip.side === 'right';
  // 下方提示按视口横向夹紧，防止贴边按钮的提示溢出窗口
  const left = isRight ? tip.x : Math.min(Math.max(tip.x, 120), window.innerWidth - 120);

  return createPortal(
    // 外层负责定位，内层承载动画：keyframes 会覆盖 transform，不能写在同一节点上
    <div
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        transform: isRight
          ? `translate3d(${left}px, ${tip.y}px, 0) translateY(-50%)`
          : `translate3d(${left}px, ${tip.y}px, 0) translateX(-50%)`,
        zIndex: 1000001,
        pointerEvents: 'none',
      }}
    >
      <div
        className="nb-tooltip-content"
        style={{
          position: 'relative',
          whiteSpace: 'nowrap',
          animation: `${isRight ? 'nb-tooltip-slide-left-and-fade' : 'nb-tooltip-slide-up-and-fade'} 120ms cubic-bezier(0.16, 1, 0.3, 1)`,
        }}
      >
        <span>{tip.text}</span>
        {/* 指向锚点的小三角：右侧提示朝左，下方提示朝上 */}
        <span
          style={{
            position: 'absolute',
            width: 6,
            height: 6,
            background: 'var(--editor-surface)',
            ...(isRight
              ? { left: -3.5, top: '50%', transform: 'translateY(-50%) rotate(45deg)', borderLeft: '1px solid var(--editor-border)', borderBottom: '1px solid var(--editor-border)' }
              : { top: -3.5, left: '50%', transform: 'translateX(-50%) rotate(45deg)', borderLeft: '1px solid var(--editor-border)', borderTop: '1px solid var(--editor-border)' }),
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
