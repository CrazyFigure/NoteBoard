// NoteBoard 移动端界面状态
// 单 Activity 栈式导航：首页（文件 / 收藏 / 已打开）→ 编辑页；设置复用 layoutStore 的设置弹窗（移动端全屏展示）。
// 抽屉、操作面板、对话框统一登记到覆盖层栈，Android 返回键按"最上层覆盖层 → 设置 → 编辑页 → 首页"逐级关闭。

import { create } from 'zustand';
import type { FileTreeNode, PlatformInfo } from '../core/ipc/types';

/** 页面 */
export type MobilePage = 'home' | 'editor';
/** 首页分段 */
export type HomeSection = 'files' | 'favorites' | 'open';
/** 存储位置：应用私有工作区 / 手机存储（需所有文件访问权限） */
export type StorageLocation = 'workspace' | 'device';

/** 可被返回键关闭的覆盖层 */
interface OverlayEntry {
  id: string;
  close: () => void;
}

interface MobileState {
  platform: PlatformInfo | null;
  page: MobilePage;
  homeSection: HomeSection;
  location: StorageLocation;
  /** 当前存储位置的根目录 */
  locationRoot: string;
  /** 当前浏览的文件夹 */
  currentFolder: string;
  entries: FileTreeNode[];
  loading: boolean;
  listError: string | null;
  overlays: OverlayEntry[];

  setPlatform: (platform: PlatformInfo) => void;
  setPage: (page: MobilePage) => void;
  setHomeSection: (section: HomeSection) => void;
  setLocation: (location: StorageLocation, root: string) => void;
  setCurrentFolder: (folder: string) => void;
  setEntries: (entries: FileTreeNode[]) => void;
  setLoading: (loading: boolean) => void;
  setListError: (error: string | null) => void;
  pushOverlay: (id: string, close: () => void) => void;
  removeOverlay: (id: string) => void;
}

export const useMobileStore = create<MobileState>((set) => ({
  platform: null,
  page: 'home',
  homeSection: 'files',
  location: 'workspace',
  locationRoot: '',
  currentFolder: '',
  entries: [],
  loading: false,
  listError: null,
  overlays: [],

  setPlatform: (platform) => set({ platform }),
  setPage: (page) => set({ page }),
  setHomeSection: (homeSection) => set({ homeSection }),
  setLocation: (location, root) => set({ location, locationRoot: root, currentFolder: root, entries: [] }),
  setCurrentFolder: (currentFolder) => set({ currentFolder }),
  setEntries: (entries) => set({ entries }),
  setLoading: (loading) => set({ loading }),
  setListError: (listError) => set({ listError }),
  pushOverlay: (id, close) =>
    set((state) => ({
      overlays: [...state.overlays.filter((entry) => entry.id !== id), { id, close }],
    })),
  removeOverlay: (id) =>
    set((state) => ({ overlays: state.overlays.filter((entry) => entry.id !== id) })),
}));

// ── 本地记忆（每设备偏好，读写失败时静默回退默认值）──

const LOCATION_KEY = 'nb-mobile-location';
const FOLDER_KEY = 'nb-mobile-folder';

/** 读取上次使用的存储位置与文件夹 */
export function readRememberedLocation(): { location: StorageLocation; folder: string | null } {
  try {
    const location = window.localStorage.getItem(LOCATION_KEY) === 'device' ? 'device' : 'workspace';
    return { location, folder: window.localStorage.getItem(FOLDER_KEY) };
  } catch {
    return { location: 'workspace', folder: null };
  }
}

/** 记住当前存储位置与文件夹 */
export function rememberLocation(location: StorageLocation, folder: string): void {
  try {
    window.localStorage.setItem(LOCATION_KEY, location);
    window.localStorage.setItem(FOLDER_KEY, folder);
  } catch {
    // 存储不可用（隐私模式等）时忽略
  }
}
