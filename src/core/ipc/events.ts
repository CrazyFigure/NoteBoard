// NoteBoard 事件封装
// 组件只用这些，不直接 listen
// 详见 docs/08-数据契约与持久化.md §3

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';
import type { DownloadProgress, ExternalChangePayload, FontPackStatus, Settings } from './types';

// ── 事件名常量 ──

export const EVENTS = {
  OPEN_FILES: 'nb://open-files',
  FOCUS_TAB: 'nb://focus-tab',
  EXTERNAL_CHANGE: 'nb://external-change',
  EXPLORER_REFRESH: 'nb://explorer-refresh',
  EXPLORER_RESCAN: 'nb://explorer-rescan',
  SETTINGS_CHANGED: 'nb://settings-changed',
  BEFORE_QUIT: 'nb://before-quit',
  HANDOFF_COMPLETE: 'nb://handoff-complete',
  CLOSE_REQUESTED: 'nb://close-requested',
  FONT_PACK_DOWNLOAD_PROGRESS: 'noteboard-font-pack-download-progress',
  FONT_PACK_CHANGED: 'noteboard-font-pack-changed',
} as const;

// ── 监听封装 ──

export function onOpenFiles(cb: (p: { paths: string[] }) => void): Promise<UnlistenFn> {
  return listen<{ paths: string[] }>(EVENTS.OPEN_FILES, (e) => cb(e.payload));
}

export function onFocusTab(cb: (p: { key: string }) => void): Promise<UnlistenFn> {
  return listen<{ key: string }>(EVENTS.FOCUS_TAB, (e) => cb(e.payload));
}

export function onExternalChange(cb: (p: ExternalChangePayload) => void): Promise<UnlistenFn> {
  return listen<ExternalChangePayload>(EVENTS.EXTERNAL_CHANGE, (e) => cb(e.payload));
}

export function onExplorerRefresh(cb: (p: { dir: string }) => void): Promise<UnlistenFn> {
  return listen<{ dir: string }>(EVENTS.EXPLORER_REFRESH, (e) => cb(e.payload));
}

export function onExplorerRescan(cb: (p: { root: string }) => void): Promise<UnlistenFn> {
  return listen<{ root: string }>(EVENTS.EXPLORER_RESCAN, (e) => cb(e.payload));
}

export function onSettingsChanged(cb: (s: Settings) => void): Promise<UnlistenFn> {
  return listen<Settings>(EVENTS.SETTINGS_CHANGED, (e) => cb(e.payload));
}

export function onBeforeQuit(cb: () => void): Promise<UnlistenFn> {
  return listen<Record<string, never>>(EVENTS.BEFORE_QUIT, () => cb());
}

export function onHandoffComplete(
  cb: (p: { targetLabel: string; keys: string[] }) => void,
): Promise<UnlistenFn> {
  return listen<{ targetLabel: string; keys: string[] }>(EVENTS.HANDOFF_COMPLETE, (e) => cb(e.payload));
}

export function onCloseRequested(cb: (label: string) => void): Promise<UnlistenFn> {
  return listen<string>(EVENTS.CLOSE_REQUESTED, (e) => cb(e.payload));
}

/** 监听字体包流式下载进度。 */
export function onFontPackDownloadProgress(cb: (progress: DownloadProgress) => void): Promise<UnlistenFn> {
  return listen<DownloadProgress>(EVENTS.FONT_PACK_DOWNLOAD_PROGRESS, (e) => cb(e.payload));
}

/** 多窗口同步字体包安装、修复和删除结果。 */
export function onFontPackChanged(cb: (status: FontPackStatus) => void): Promise<UnlistenFn> {
  return listen<FontPackStatus>(EVENTS.FONT_PACK_CHANGED, (e) => cb(e.payload));
}

// ── 系统文件拖拽监听 ──

/** 监听系统文件拖拽事件（enter / over / drop / leave） */
export function onDragDrop(cb: (e: DragDropEvent) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((event) => cb(event.payload));
}

export type { DragDropEvent };
