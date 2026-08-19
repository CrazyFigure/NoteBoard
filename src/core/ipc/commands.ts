// NoteBoard IPC 命令封装
// 组件禁止直接调 invoke，只能用这些封装
// 详见 docs/08-数据契约与持久化.md §2

import { invoke } from '@tauri-apps/api/core';
import type {
  DocumentPayload,
  FileTreeNode,
  FontFamily,
  ProbeResult,
  PathExistsResult,
  RegisterResult,
  ReconcileResult,
  Settings,
  WriteResult,
  WindowIntent,
  CreateWindowResponse,
  ConfirmHandoffResult,
  TransferredDocument,
  Eol,
  Encoding,
  UpdateCheckResult,
} from './types';

// ── 窗口 ──

export function windowReady(label: string): Promise<WindowIntent> {
  return invoke<WindowIntent>('window_ready', { label });
}

export function createWindow(intent: WindowIntent): Promise<CreateWindowResponse> {
  return invoke<CreateWindowResponse>('create_window', { intent });
}

export function openInNewWindow(docs: TransferredDocument[]): Promise<CreateWindowResponse> {
  return invoke<CreateWindowResponse>('open_in_new_window', { docs });
}

export function confirmHandoff(label: string): Promise<ConfirmHandoffResult> {
  return invoke<ConfirmHandoffResult>('confirm_handoff', { label });
}

export function focusWindow(label: string): Promise<void> {
  return invoke<void>('focus_window', { label });
}

export function notifyWindowActive(label: string): Promise<void> {
  return invoke<void>('notify_window_active', { label });
}

export function closeWindow(label: string): Promise<void> {
  return invoke<void>('close_window', { label });
}

// ── 文档注册表 ──

export function registerDocument(
  label: string,
  key: string,
  kind: string,
): Promise<RegisterResult> {
  return invoke<RegisterResult>('register_document', { label, key, kind });
}

export function unregisterDocument(label: string, key: string): Promise<void> {
  return invoke<void>('unregister_document', { label, key });
}

export function reconcileDocuments(label: string, keys: string[]): Promise<ReconcileResult> {
  return invoke<ReconcileResult>('reconcile_documents', { label, keys });
}

export function setDocumentDirty(key: string, isDirty: boolean): Promise<void> {
  return invoke<void>('set_document_dirty', { key, isDirty });
}

export function findDocumentOwner(key: string): Promise<{ ownerLabel: string | null }> {
  return invoke<{ ownerLabel: string | null }>('find_document_owner', { key });
}

// ── 文件 I/O ──

export function readDocument(path: string): Promise<DocumentPayload> {
  return invoke<DocumentPayload>('read_document', { path });
}

export function probeDocument(path: string): Promise<ProbeResult> {
  return invoke<ProbeResult>('probe_document', { path });
}

export function writeDocument(
  path: string,
  content: string,
  encoding: Encoding,
  eol: Eol,
): Promise<WriteResult> {
  return invoke<WriteResult>('write_document', { path, content, encoding, eol });
}

// 保存二进制文件（如粘贴或插入的图片数据）
export function saveBinaryFile(
  path: string,
  data: Uint8Array | number[],
): Promise<WriteResult> {
  return invoke<WriteResult>('save_binary_file', {
    path,
    data: Array.from(data),
  });
}

export function readDir(path: string, showHidden: boolean): Promise<FileTreeNode[]> {
  return invoke<FileTreeNode[]>('read_dir', { path, showHidden });
}

export function createFile(
  dir: string,
  name: string,
  template: string,
): Promise<DocumentPayload> {
  return invoke<DocumentPayload>('create_file', { dir, name, template });
}

export function createDir(dir: string, name: string): Promise<void> {
  return invoke<void>('create_dir', { dir, name });
}

export function renamePath(from: string, to: string): Promise<void> {
  return invoke<void>('rename_path', { from, to });
}

export function moveToTrash(path: string): Promise<void> {
  return invoke<void>('move_to_trash', { path });
}

export function pathExists(path: string): Promise<PathExistsResult> {
  return invoke<PathExistsResult>('path_exists', { path });
}

export function revealInExplorer(path: string): Promise<void> {
  return invoke<void>('reveal_in_explorer', { path });
}

export function openWithDefaultApp(path: string): Promise<void> {
  return invoke<void>('open_with_default_app', { path });
}

// ── 监听 ──

export function watchDir(path: string): Promise<void> {
  return invoke<void>('watch_dir', { path });
}

export function unwatchDir(path: string): Promise<void> {
  return invoke<void>('unwatch_dir', { path });
}

// ── 设置与系统 ──

export function loadSettings(): Promise<Settings> {
  return invoke<Settings>('load_settings');
}

export function saveSettings(settings: Settings): Promise<number> {
  return invoke<number>('save_settings', { settings });
}

export function listSystemFonts(): Promise<FontFamily[]> {
  return invoke<FontFamily[]>('list_system_fonts');
}

// ── 会话 ──

export function loadSession(): Promise<unknown | null> {
  return invoke<unknown | null>('load_session');
}

export function saveSession(session: unknown): Promise<void> {
  return invoke<void>('save_session', { session });
}

export function listRecent(): Promise<unknown[]> {
  return invoke<unknown[]>('list_recent');
}

export function pushRecent(path: string, isDir: boolean): Promise<void> {
  return invoke<void>('push_recent', { path, isDir });
}

export function writeDraft(key: string, content: string, kind: string): Promise<void> {
  return invoke<void>('write_draft', { key, content, kind });
}

export function deleteDraft(key: string): Promise<void> {
  return invoke<void>('delete_draft', { key });
}

export function listDrafts(): Promise<unknown[]> {
  return invoke<unknown[]>('list_drafts');
}

// ── 应用更新与外部链接 ──

// 检查 GitHub 最新版本
export function checkForUpdates(): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>('check_for_updates');
}

// 下载更新安装包并在落盘后启动安装器
export function downloadAndInstallUpdate(params: {
  downloadUrl: string;
  assetName: string;
  installerSize?: number | null;
}): Promise<string> {
  return invoke<string>('download_and_install_update', {
    downloadUrl: params.downloadUrl,
    assetName: params.assetName,
    installerSize: params.installerSize ?? null,
  });
}

// 使用系统默认浏览器打开外部超链接
export function openExternalUrl(url: string): Promise<boolean> {
  return invoke<boolean>('open_external_url', { url });
}

