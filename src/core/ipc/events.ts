// NoteBoard 事件封装
// 组件只用这些，不直接 listen
// 详见 docs/08-数据契约与持久化.md §3

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ExternalChangePayload, Settings } from './types';

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
