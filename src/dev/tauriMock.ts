// NoteBoard 浏览器预览用 Tauri IPC 模拟（仅开发服务器 + URL 带 ?mock=1 时加载）
// 用途：在普通浏览器 / 无头浏览器中预览与走查界面（尤其是移动端布局），无需编译 Rust 与安卓工程。
// 提供内存文件系统与启动链路所需的最小命令集；未覆盖的命令返回 null 并打印提示。

import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { createDefaultBitableDocument, serializeBitableDocument } from '../features/bitable/bitableConverter';

interface MockFile {
  content: string;
  mtime: number;
}

const WORKSPACE = '/data/user/0/com.crazyfigure.noteboard/workspace';
const EXTERNAL_ROOT = '/storage/emulated/0';

const now = Date.now();
const files = new Map<string, MockFile>();
const dirs = new Set<string>([WORKSPACE, `${WORKSPACE}/项目笔记`, `${WORKSPACE}/读书`, `${WORKSPACE}/.nb-trash`, EXTERNAL_ROOT, `${EXTERNAL_ROOT}/Documents`]);

function seed(path: string, content: string, ageMinutes: number): void {
  files.set(path, { content, mtime: now - ageMinutes * 60_000 });
}

seed(`${WORKSPACE}/欢迎使用 NoteBoard.md`, '# 欢迎使用 NoteBoard\n\n这是你的笔记工作区。\n\n- 点击右下角 **＋** 新建\n- 长按文件查看更多操作\n\n> [!TIP]\n> 从其它应用分享文件到 NoteBoard 即可编辑。\n', 3);
seed(`${WORKSPACE}/周报.md`, '* 本周完成\n* 下周计划\n\n_重点_：移动端适配\n', 60 * 30);
seed(`${WORKSPACE}/购物清单.txt`, '牛奶\n面包\n鸡蛋\n', 60 * 24 * 40);
seed(`${WORKSPACE}/架构草图.excalidraw`, '', 60 * 5);
seed(`${WORKSPACE}/项目笔记/需求.md`, '# 需求\n\n## 背景\n\n## 目标\n', 90);
seed(`${WORKSPACE}/读书/摘录.md`, '# 摘录\n', 2000);
seed(`${WORKSPACE}/任务看板.bitable`, serializeBitableDocument(createDefaultBitableDocument('任务看板')), 30);

/** 同步配置样例（保存后在内存中保留，便于预览交互） */
const emptyGit = { baseUrl: '', owner: '', repo: '', branch: '', token: '', remoteDir: '' };
const mockProvider = {
  kind: 'webdav',
  webdav: { url: 'https://dav.jianguoyun.com/dav/', username: 'me@example.com', password: 'app-password', userAgent: '', remoteDir: 'NoteBoard' },
  s3: { endpoint: '', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', prefix: '', pathStyle: false },
  github: { ...emptyGit },
  gitee: { ...emptyGit },
  gitlab: { ...emptyGit },
};
let mockSyncConfig: Record<string, unknown> = {
  version: 1,
  deviceId: 'mock-device',
  sync: {
    enabled: true, rootDir: WORKSPACE, deviceName: '我的电脑', provider: mockProvider,
    syncOnSave: true, intervalEnabled: true, intervalMinutes: 30, syncOnStartup: true, notifyNoChange: false,
    trashEnabled: true, trashDays: 30,
  },
  backup: { autoEnabled: true, intervalHours: 24, keepCount: 10, target: 'local', localDir: 'D:/Backup/NoteBoard', provider: { ...mockProvider, kind: 'github' } },
};

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function kindOf(name: string): string | null {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (['excalidraw', 'board', 'canvas'].includes(ext)) return 'board';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['mindmap', 'xmind'].includes(ext)) return 'mindmap';
  if (['bitable', 'table'].includes(ext)) return 'bitable';
  if (['drawio', 'dio'].includes(ext)) return 'drawio';
  return 'code';
}

function languageOf(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md') return 'markdown';
  if (ext === 'json' || ext === 'excalidraw') return 'json';
  if (ext === 'sql') return 'sql';
  return 'plaintext';
}

function listDir(path: string) {
  const children: unknown[] = [];
  for (const dir of dirs) {
    if (dir !== path && parentOf(dir) === path) {
      children.push({ path: dir, name: nameOf(dir), isDir: true, kind: null, size: null, mtime: null, isHidden: false, isSymlink: false });
    }
  }
  for (const [filePath, file] of files) {
    if (parentOf(filePath) === path) {
      const name = nameOf(filePath);
      children.push({ path: filePath, name, isDir: false, kind: kindOf(name), size: file.content.length, mtime: Math.floor(file.mtime / 1000), isHidden: false, isSymlink: false });
    }
  }
  return children;
}

function payloadOf(path: string) {
  const file = files.get(path);
  const name = nameOf(path);
  return {
    key: path,
    displayName: name,
    dirPath: parentOf(path),
    kind: kindOf(name),
    language: languageOf(name),
    content: file?.content ?? '',
    encoding: 'utf8',
    eol: 'lf',
    size: file?.content.length ?? 0,
    mtime: Math.floor((file?.mtime ?? now) / 1000),
    readonly: false,
  };
}

let listenerId = 0;

/** 安装模拟（必须在应用首次 invoke 之前调用） */
export function installTauriMock(): void {
  mockWindows('nb-main');
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    switch (cmd) {
      // ── 事件与插件 ──
      case 'plugin:event|listen':
      case 'plugin:app|register_listener':
        listenerId += 1;
        return listenerId;
      case 'plugin:event|unlisten':
      case 'plugin:event|emit':
      case 'plugin:event|emit_to':
      case 'plugin:app|remove_listener':
        return null;
      // ── 启动握手 ──
      case 'window_listeners_ready':
        return { protocolVersion: 1, consumerId: 'mock', startupMode: 'empty', transferId: null, queueVersion: 0 };
      case 'window_shell_ready':
      case 'ack_open_request':
      case 'set_document_dirty':
      case 'unregister_document':
      case 'save_settings':
      case 'save_favorites':
      case 'save_session':
      case 'clear_session':
      case 'push_recent':
      case 'record_web_spans':
      case 'delete_staged_file':
        return null;
      case 'list_open_requests':
      case 'stash_documents':
      case 'list_system_fonts':
      case 'take_incoming_files':
      case 'reconcile_documents':
        return [];
      case 'load_settings':
        throw new Error('mock：使用默认设置');
      case 'load_favorites':
        return { schemaVersion: 1, roots: [] };
      case 'load_session':
        return null;
      case 'is_perf_spans_enabled':
        return false;
      case 'get_font_pack_status':
      case 'refresh_font_pack_status':
        return { id: 'mock', version: '0', state: 'ready', installedSizeBytes: 0, downloadSizeBytes: 0, downloadUrl: '', faces: [] };
      case 'check_for_updates':
        throw new Error('mock：离线');
      case 'get_default_staging_directory':
      case 'ensure_staging_directory':
        return `${WORKSPACE}/../staging`;
      // ── 平台 ──
      case 'get_platform_info':
        return { platform: 'android', isMobile: true, defaultWorkspace: WORKSPACE, externalRoot: EXTERNAL_ROOT, allFilesAccess: false };
      case 'ensure_default_workspace':
        return WORKSPACE;
      case 'request_all_files_access':
      case 'move_app_to_background':
      case 'set_system_bar_style':
      case 'share_file':
        return null;
      // ── 多端同步与备份（界面预览用样例数据） ──
      case 'sync_get_config':
      case 'sync_save_config':
        if (cmd === 'sync_save_config') mockSyncConfig = args.config as typeof mockSyncConfig;
        return mockSyncConfig;
      case 'sync_get_status':
        return {
          syncing: false,
          backingUp: false,
          lastSync: {
            at: now - 4 * 60_000, durationMs: 1800, trigger: 'interval', ok: true,
            upload: { added: 1, modified: 2, deleted: 0 }, download: { added: 0, modified: 1, deleted: 1 },
            merged: 1, conflicts: 0, errors: [], message: '同步完成 · 本机→云端：新增 1、修改 2 · 云端→本机：修改 1、删除 1 · 按行合并 1 个',
          },
          lastBackup: { at: now - 26 * 3600_000, ok: true, trigger: 'auto', name: 'NoteBoard-backup-mock.zip', size: 2_400_000, fileCount: 42, removedOld: 0, message: '备份完成：42 个文件（2.3 MB）' },
          nextSyncAt: now + 26 * 60_000,
          nextBackupAt: now + 3600_000,
        };
      case 'sync_test_connection':
        return '连接成功，远端已有同步数据，开启同步后将与本机双向合并';
      case 'sync_now':
      case 'backup_now':
      case 'sync_trash_delete':
        return null;
      case 'sync_trash_empty':
        return 2;
      case 'sync_trash_list':
        return [
          { id: '.nb-trash/旧方案', name: '旧方案', isDir: true, origPath: '项目笔记/旧方案', trashedAt: now - 3 * 86_400_000, expiresAt: now + 27 * 86_400_000, size: 52_000, fileCount: 6 },
          { id: '.nb-trash/草稿.md', name: '草稿.md', isDir: false, origPath: '草稿.md', trashedAt: now - 28 * 86_400_000, expiresAt: now + 1.5 * 86_400_000, size: 1_200, fileCount: 1 },
        ];
      case 'sync_trash_restore':
        return `${WORKSPACE}/草稿 (1).md`;
      case 'backup_list':
        return [
          { name: 'NoteBoard-backup-20261010-090000-mock_PC-12345678.zip', size: 2_400_000, createdAt: now - 26 * 3600_000, device: 'mock_PC', isOwn: true },
          { name: 'NoteBoard-backup-20261009-090000-安卓设备-abcdef12.zip', size: 2_300_000, createdAt: now - 50 * 3600_000, device: '安卓设备', isOwn: false },
        ];
      case 'backup_restore':
        return '已恢复备份：写回 3 个文件，1 个备份之外的文件已移入回收站';
      case 'backup_delete':
        return null;
      // ── 文件系统 ──
      case 'read_dir':
        return listDir(String(args.path));
      case 'register_document':
        return { type: 'ok' };
      case 'find_document_owner':
        return null;
      case 'prepare_document': {
        const path = String(args.path);
        if (dirs.has(path)) return { type: 'directory', path };
        return { type: 'text', payload: payloadOf(path) };
      }
      case 'read_document':
        return payloadOf(String(args.path));
      case 'probe_document': {
        const path = String(args.path);
        return { exists: files.has(path), mtime: Math.floor((files.get(path)?.mtime ?? now) / 1000), size: files.get(path)?.content.length ?? 0 };
      }
      case 'path_exists': {
        const path = String(args.path);
        return { exists: files.has(path) || dirs.has(path), isDir: dirs.has(path) };
      }
      case 'write_document': {
        const path = String(args.path);
        files.set(path, { content: String(args.content ?? ''), mtime: Date.now() });
        return { ok: true, mtime: Math.floor(Date.now() / 1000), size: String(args.content ?? '').length, error: null };
      }
      case 'create_dir':
        dirs.add(`${String(args.dir)}/${String(args.name)}`);
        return null;
      case 'rename_path': {
        const from = String(args.from);
        const to = String(args.to);
        const file = files.get(from);
        if (file) {
          files.delete(from);
          files.set(to, file);
        } else if (dirs.has(from)) {
          dirs.delete(from);
          dirs.add(to);
        }
        return null;
      }
      case 'move_to_trash':
        files.delete(String(args.path));
        dirs.delete(String(args.path));
        return null;
      default:
        console.warn('[tauriMock] 未模拟的命令：', cmd, args);
        return null;
    }
  });
}
