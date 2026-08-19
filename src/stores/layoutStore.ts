// NoteBoard layoutStore
// 面板可见性与宽度（每窗口一份，Rust 落盘）
// 详见 docs/05-ADR/ADR-010-状态管理与跨窗口同步.md §2
// 详见 docs/07-UI布局与交互规范.md §1.1

import { create } from 'zustand';

// 面板宽度约束
const EXPLORER_MIN = 180;
const EXPLORER_MAX = 480;
const EXPLORER_DEFAULT = 260;

const OUTLINE_MIN = 200;
const OUTLINE_MAX = 480;
// 默认大纲宽度设置为最小宽度 OUTLINE_MIN
const OUTLINE_DEFAULT = OUTLINE_MIN;

interface LayoutStore {
  explorerVisible: boolean;
  explorerWidth: number;
  outlineVisible: boolean;
  outlineWidth: number;
  statusBarVisible: boolean;
  settingsModalVisible: boolean;
  /** 是否正在向窗口内拖拽文件 */
  isDraggingFile: boolean;

  // ── 操作 ──
  toggleExplorer: () => void;
  toggleOutline: () => void;
  toggleSettingsModal: () => void;
  setExplorerVisible: (visible: boolean) => void;
  setOutlineVisible: (visible: boolean) => void;
  setExplorerWidth: (width: number) => void;
  setOutlineWidth: (width: number) => void;
  setStatusBarVisible: (visible: boolean) => void;
  setSettingsModalVisible: (visible: boolean) => void;
  setIsDraggingFile: (dragging: boolean) => void;

  // ── 持久化 ──
  toLayout: () => {
    explorerVisible: boolean;
    explorerWidth: number;
    outlineVisible: boolean;
    outlineWidth: number;
  };
  restoreFrom: (layout: {
    explorerVisible: boolean;
    explorerWidth: number;
    outlineVisible: boolean;
    outlineWidth: number;
  }) => void;
}

/** 钳制到约束范围 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  explorerVisible: true,
  explorerWidth: EXPLORER_DEFAULT,
  outlineVisible: true,
  outlineWidth: OUTLINE_DEFAULT,
  statusBarVisible: true,
  settingsModalVisible: false,
  isDraggingFile: false,

  toggleExplorer: () => set((s) => ({ explorerVisible: !s.explorerVisible })),
  toggleOutline: () => set((s) => ({ outlineVisible: !s.outlineVisible })),
  toggleSettingsModal: () => set((s) => ({ settingsModalVisible: !s.settingsModalVisible })),
  setExplorerVisible: (visible) => set({ explorerVisible: visible }),
  setOutlineVisible: (visible) => set({ outlineVisible: visible }),
  setExplorerWidth: (width) =>
    set({ explorerWidth: clamp(width, EXPLORER_MIN, EXPLORER_MAX) }),
  setOutlineWidth: (width) =>
    set({ outlineWidth: clamp(width, OUTLINE_MIN, OUTLINE_MAX) }),
  setStatusBarVisible: (visible) => set({ statusBarVisible: visible }),
  setSettingsModalVisible: (visible) => set({ settingsModalVisible: visible }),
  setIsDraggingFile: (dragging) => set({ isDraggingFile: dragging }),

  toLayout: () => {
    const s = get();
    return {
      explorerVisible: s.explorerVisible,
      explorerWidth: s.explorerWidth,
      outlineVisible: s.outlineVisible,
      outlineWidth: s.outlineWidth,
    };
  },

  restoreFrom: (layout) => {
    set({
      explorerVisible: layout.explorerVisible,
      explorerWidth: clamp(layout.explorerWidth, EXPLORER_MIN, EXPLORER_MAX),
      outlineVisible: layout.outlineVisible,
      outlineWidth: clamp(layout.outlineWidth, OUTLINE_MIN, OUTLINE_MAX),
    });
  },
}));

export { EXPLORER_MIN, EXPLORER_MAX, OUTLINE_MIN, OUTLINE_MAX };
