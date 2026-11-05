// 在视图仍挂载时捕获位置，关闭后仅清理会话内快照，持久阅读记录独立保留。
import { getEditorCapabilities } from '../../core/editor/editorRegistry';
import { useWindowStore } from '../../stores/windowStore';
import { flushReadingPositions, saveReadingPosition } from './readingPosition';

/** 能力接口只同步读取选区与滚动位置，不触发正文 flush。 */
export function captureReadingPosition(docKey: string): void {
  // Home 隐藏编辑区后浏览器可能把 scrollTop 报为 0，应保留隐藏前捕获的位置。
  const owner = [...document.querySelectorAll<HTMLElement>('[data-reading-document]')]
    .find((element) => element.dataset.readingDocument === docKey);
  if (owner?.checkVisibility && !owner.checkVisibility()) return;
  saveReadingPosition(docKey, getEditorCapabilities(docKey)?.captureViewState?.());
}

/** 最终关闭与失焦时记录活动视图；后台实例的位置已在切走时捕获。 */
export function captureCurrentReadingPosition(): void {
  const key = useWindowStore.getState().activeKey;
  if (key) captureReadingPosition(key);
  flushReadingPositions();
}

/** 捕获真实编辑区的滚动与标签切换，并在退出浏览器/原生窗口之前同步落盘。 */
export function startReadingPositionTracker(): () => void {
  const unsubscribe = useWindowStore.subscribe((state, previous) => {
    if (previous.activeKey && state.activeKey !== previous.activeKey) captureReadingPosition(previous.activeKey);
    // 非活动标签已在切走时记录；关闭后台标签不再从隐藏的内核重复读取。
  });
  const handleScroll = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches('.cm-scroller, .nb-md-visual-scroller')) return;
    if (target.checkVisibility && !target.checkVisibility()) return;
    // 保活实例隐藏时可能因布局产生滚动事件，只接受当前文件所在的编辑区。
    const owner = target.closest<HTMLElement>('[data-reading-document]');
    const key = useWindowStore.getState().activeKey;
    if (key && owner?.dataset.readingDocument === key) captureReadingPosition(key);
  };
  const handleVisibility = () => {
    if (document.visibilityState === 'hidden') captureCurrentReadingPosition();
  };
  document.addEventListener('scroll', handleScroll, true);
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('blur', captureCurrentReadingPosition);
  window.addEventListener('pagehide', captureCurrentReadingPosition);
  return () => {
    captureCurrentReadingPosition();
    unsubscribe();
    document.removeEventListener('scroll', handleScroll, true);
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('blur', captureCurrentReadingPosition);
    window.removeEventListener('pagehide', captureCurrentReadingPosition);
  };
}
