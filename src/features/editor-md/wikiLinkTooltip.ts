// NoteBoard 双链悬浮提示
// 双链节点视图是原生 DOM（不经 React），这里提供与 Tooltip 组件同样外观（nb-tooltip-content）、
// 同样 100ms 延迟的轻量单例提示，显示目标路径与跳转快捷键。

import { formatShortcut } from '../../core/shortcuts';

/** 与 Tooltip 组件一致的出现延迟 */
const TOOLTIP_DELAY_MS = 100;

let host: HTMLDivElement | null = null;
let timer: number | null = null;
let anchor: HTMLElement | null = null;

function clearTimer(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

/** 隐藏提示（离开、点击、节点销毁时调用） */
export function hideWikiLinkTooltip(): void {
  clearTimer();
  anchor = null;
  host?.remove();
  host = null;
}

/** 延迟显示提示：定位在锚点上方居中，超出视口时贴边 */
export function scheduleWikiLinkTooltip(target: HTMLElement, text: string, shortcut?: string): void {
  hideWikiLinkTooltip();
  anchor = target;
  timer = window.setTimeout(() => {
    timer = null;
    if (anchor !== target || !target.isConnected) return;
    const rect = target.getBoundingClientRect();
    const outer = document.createElement('div');
    outer.style.position = 'fixed';
    outer.style.left = `${Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90)}px`;
    outer.style.top = `${rect.top - 8}px`;
    outer.style.transform = 'translate(-50%, -100%)';
    outer.style.zIndex = '1000001';
    outer.style.pointerEvents = 'none';

    // 外层定位、内层动画：动画会覆盖 transform，不能写在同一节点上
    const content = document.createElement('div');
    content.className = 'nb-tooltip-content';
    content.style.animation = 'nb-tooltip-slide-down-and-fade 120ms cubic-bezier(0.16, 1, 0.3, 1)';
    const label = document.createElement('span');
    label.textContent = text;
    content.appendChild(label);
    if (shortcut) {
      const kbd = document.createElement('kbd');
      kbd.className = 'nb-tooltip-kbd';
      kbd.textContent = formatShortcut(shortcut);
      content.appendChild(kbd);
    }
    outer.appendChild(content);
    document.body.appendChild(outer);
    host = outer;
  }, TOOLTIP_DELAY_MS);
}
