// 拖动反馈只包含标签名称与落点；不广播正文，也不参与文档保存或会话恢复。
import { useSyncExternalStore } from 'react';
import type { NativeTabDragInfo } from '../../core/ipc/types';

interface TabDragFeedbackState {
  info: NativeTabDragInfo | null;
  point: { x: number; y: number } | null;
  arrivingKey: string | null;
}
let state: TabDragFeedbackState = { info: null, point: null, arrivingKey: null };
const subscribers = new Set<() => void>();
let arrivalTimer: ReturnType<typeof setTimeout> | null = null;

/** 发布不可变快照，React 能按字段跳过仅坐标变化引发的整栏重渲染。 */
function publish(next: TabDragFeedbackState): void { state = next; subscribers.forEach((notify) => notify()); }
function subscribe(notify: () => void): () => void { subscribers.add(notify); return () => subscribers.delete(notify); }

/** 开始/结束原生拖放时同步所有窗口的源标签状态。 */
export function setNativeTabDragInfo(info: NativeTabDragInfo | null): void {
  publish({ ...state, info, point: info ? state.point : null });
}

/** 只记录当前窗口的悬停位置，离开窗口即撤掉合并提示。 */
export function setNativeTabDragPoint(point: { x: number; y: number } | null): void {
  publish({ ...state, point });
}

/** 新接收的标签做一次短入场动画，不改变标签尺寸和排列。 */
export function markTabArriving(key: string): void {
  if (arrivalTimer) clearTimeout(arrivalTimer);
  publish({ ...state, arrivingKey: key });
  arrivalTimer = setTimeout(() => {
    arrivalTimer = null;
    publish({ ...state, arrivingKey: null });
  }, 220);
}

/** 卸载窗口时释放本模块新建的定时器和反馈，避免热重载残留。 */
export function resetTabDragFeedback(): void {
  if (arrivalTimer) clearTimeout(arrivalTimer);
  arrivalTimer = null;
  publish({ info: null, point: null, arrivingKey: null });
}

export function useTabDragFeedback() { return useSyncExternalStore(subscribe, () => state); }
export function useNativeDraggedTabKey() { return useSyncExternalStore(subscribe, () => state.info?.key ?? null); }
export function useArrivingTabKey() { return useSyncExternalStore(subscribe, () => state.arrivingKey); }
