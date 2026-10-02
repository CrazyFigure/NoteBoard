// NoteBoard 浏览器预览用 Tauri IPC 模拟（仅开发服务器 + URL 带 ?mock=1 时加载）
// 用途：在普通浏览器 / 无头浏览器中预览与走查界面（尤其是移动端布局），无需编译 Rust 与安卓工程。
// 提供内存文件系统与启动链路所需的最小命令集；未覆盖的命令返回 null 并打印提示。

import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';

interface MockFile {
  content: string;
  mtime: number;
}

const WORKSPACE = '/data/user/0/com.crazyfigure.noteboard/workspace';
const EXTERNAL_ROOT = '/storage/emulated/0';

const now = Date.now();
const files = new Map<string, MockFile>();
const dirs = new Set<string>([WORKSPACE, `${WORKSPACE}/项目笔记`, `${WORKSPACE}/读书`, EXTERNAL_ROOT, `${EXTERNAL_ROOT}/Documents`]);

function seed(path: string, content: string, ageMinutes: number): void {
  files.set(path, { content, mtime: now - ageMinutes * 60_000 });
}

seed(`${WORKSPACE}/欢迎使用 NoteBoard.md`, '# 欢迎使用 NoteBoard\n\n这是你的笔记工作区。\n\n- 点击右下角 **＋** 新建\n- 长按文件查看更多操作\n\n> [!TIP]\n> 从其它应用分享文件到 NoteBoard 即可编辑。\n', 3);
seed(`${WORKSPACE}/周报.md`, '* 本周完成\n* 下周计划\n\n_重点_：移动端适配\n', 60 * 30);
seed(`${WORKSPACE}/购物清单.txt`, '牛奶\n面包\n鸡蛋\n', 60 * 24 * 40);
seed(`${WORKSPACE}/架构草图.excalidraw`, '', 60 * 5);
seed(`${WORKSPACE}/项目笔记/需求.md`, '# 需求\n\n## 背景\n\n## 目标\n', 90);
seed(`${WORKSPACE}/读书/摘录.md`, '# 摘录\n', 2000);

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
      case 'share_file':
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
