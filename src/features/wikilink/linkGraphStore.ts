// NoteBoard 全屏关系图谱开关
// 由 LinkGraphHost 统一渲染（桌面与移动端外壳各挂载一份），任何位置都可以打开。

import { create } from 'zustand';

interface LinkGraphOverlayState {
  open: boolean;
  /** 打开时默认显示的范围：全部笔记 / 以当前笔记为中心 */
  initialScope: 'global' | 'local';
  show: (scope?: 'global' | 'local') => void;
  close: () => void;
}

export const useLinkGraphStore = create<LinkGraphOverlayState>((set) => ({
  open: false,
  initialScope: 'global',
  show: (scope = 'global') => set({ open: true, initialScope: scope }),
  close: () => set({ open: false }),
}));
