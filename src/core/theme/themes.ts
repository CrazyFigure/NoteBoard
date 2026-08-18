// NoteBoard 主题注册表
// 三套主题元信息（中文名、明暗分组、预览三色）
// 详见 docs/06-主题与设计规范.md §3/4/5

import type { ThemeId } from '../ipc/types';

export interface ThemeMeta {
  id: ThemeId;
  /** 中文显示名 */
  displayName: string;
  /** 明暗分组（Excalidraw 用） */
  scheme: 'light' | 'dark';
  /** 预览三色：[背景, 身份色, 指示色] */
  preview: [string, string, string];
  /** Excalidraw 的 theme prop */
  excalidrawTheme: 'light' | 'dark';
}

export const THEMES: Record<ThemeId, ThemeMeta> = {
  'chen-guang': {
    id: 'chen-guang',
    displayName: '晨光',
    scheme: 'light',
    preview: ['#ffffff', '#3b82f6', '#2563eb'],
    excalidrawTheme: 'light',
  },
  'hu-po': {
    id: 'hu-po',
    displayName: '琥珀',
    scheme: 'light',
    preview: ['#FAF9F5', '#D97757', '#C4623E'],
    excalidrawTheme: 'light',
  },
  'mo-ye': {
    id: 'mo-ye',
    displayName: '墨夜',
    scheme: 'dark',
    preview: ['#0f172a', '#60a5fa', '#60a5fa'],
    excalidrawTheme: 'dark',
  },
};

/** 获取主题元信息 */
export function getThemeMeta(id: ThemeId): ThemeMeta {
  return THEMES[id];
}

/** 获取全部主题列表（用于设置界面渲染） */
export function getAllThemes(): ThemeMeta[] {
  return Object.values(THEMES);
}
