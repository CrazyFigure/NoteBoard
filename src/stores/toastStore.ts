// NoteBoard 全局轻量悬浮提示 Store
// 支持信息、警告、错误等提示并在超时后自动淡出
// 详见 docs/07-UI布局与交互规范.md

import { create } from 'zustand';

export interface ToastItem {
  id: string;
  message: string;
  type?: 'info' | 'warning' | 'error' | 'success';
  duration?: number;
  /** 分组键：同一分组只保留最新一条（例如连续的同步结果提示） */
  key?: string;
}

interface ToastStore {
  toasts: ToastItem[];
  // 显示 Toast
  showToast: (message: string, type?: ToastItem['type'], duration?: number, key?: string) => void;
  // 移除 Toast
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  showToast: (message, type = 'info', duration = 3500, key) => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // 添加到列表；带分组键时先移除同组旧提示，只展示最新一条
    set((state) => ({
      toasts: [
        ...(key ? state.toasts.filter((t) => t.key !== key) : state.toasts),
        { id, message, type, duration, key },
      ],
    }));

    // 超时自动清除
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, duration);
    }
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}));

// 便捷全局调用函数
export const showToast = (
  message: string,
  type?: ToastItem['type'],
  duration?: number,
  key?: string,
) => {
  useToastStore.getState().showToast(message, type, duration, key);
};
