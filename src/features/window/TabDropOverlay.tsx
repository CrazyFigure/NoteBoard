// 接收窗口使用边缘高亮和标签插入线提示落点；覆盖层不拦截系统拖放或正常点击。
import { createPortal } from 'react-dom';
import { GitMerge } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTabDragFeedback } from './tabDragFeedback';
import { nativeTabInsertionAnchor } from './tabDropTarget';
import './tabDragFeedback.css';

export function TabDropOverlay() {
  const { info, point } = useTabDragFeedback();
  const bar = point ? document.querySelector<HTMLElement>('[role="tablist"]') : null;
  const bounds = bar?.getBoundingClientRect();
  const before = point ? nativeTabInsertionAnchor(point, info?.key) : null;
  const anchor = before ? [...bar?.querySelectorAll<HTMLElement>('[data-tab-key]') ?? []]
    .find((element) => element.dataset.tabKey === before)?.getBoundingClientRect() : null;
  const visible = Boolean(info && point);
  const x = anchor?.left ?? bounds?.right ?? 40;
  return createPortal(<div className={`nb-tab-drop-feedback${visible ? ' is-visible' : ''}`} aria-hidden="true">
    <div className="nb-tab-drop-outline" />
    <div className="nb-tab-drop-hint"><GitMerge size={14} /><span>{info?.sourceLabel === getCurrentWindow().label ? '松开以放回标签' : '松开以合并标签'}</span></div>
    {bounds && <div className="nb-tab-drop-marker" style={{ left: Math.max(bounds.left, Math.min(x, bounds.right)) - 1,
      top: bounds.top + 6, height: Math.max(16, bounds.height - 12) }} />}
  </div>, document.body);
}
