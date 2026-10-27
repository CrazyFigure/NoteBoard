// 网页构建专属平台适配：替换 Tauri 的 IPC / 文件选择器 / 窗口接口。
// 原生构建不会引用本文件，服务器文件使用虚拟 POSIX 路径，浏览器本地文件需显式上传。
import { DEFAULT_SETTINGS } from '../stores/settingsStore';
import type { FileTreeNode, Settings, OpenRequestItemDto } from '../core/ipc/types';
import { useDocumentStore } from '../stores/documentStore';
import { installWebClipboardFallback } from './clipboard';
import './web.css';
import { browserSystemFonts } from './fonts';

const ROOT = '/workspace';
/** 普通 HTTP 部署也可生成随机标识；randomUUID 只在安全上下文中可用。 */
function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
const label = `web-${randomId()}`;
const clientId = localStorage.getItem('nb-web-client') || randomId();
localStorage.setItem('nb-web-client', clientId);
const revisions = new Map<string, string>();
const readVersions = new Map<string, Array<{ content: string; revision: string }>>();
const registrations = new Set<string>();
const queue: OpenRequestItemDto[] = [];
const events = new EventTarget();
let sequence = 0;
let syncAvailable = false;

/** 启动时读取服务能力；未设账号或工作进程未构建时不给出可操作的同步入口。 */
export function canUseWebSync(): boolean { return syncAvailable; }

/** 在 React 启动前连接同步事件，身份验证沿用页面 HTTP Basic 登录状态。 */
export async function initializeWebRuntime(): Promise<void> {
  // 服务器 IP + HTTP 也能复制文本；图片复制和主动粘贴仍遵循浏览器 HTTPS 权限限制。
  installWebClipboardFallback();
  const capabilities = await request<{ syncAvailable: boolean; authEnabled: boolean; historyAvailable?: boolean }>('web_capabilities');
  syncAvailable = capabilities.syncAvailable;
  // 未启用多端同步的部署仍可能提供历史记录：同样需要事件流刷新版本列表
  if (syncAvailable || capabilities.historyAvailable) {
    const stream = new EventSource('/api/events');
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as { event: string; payload: unknown };
      emit(event.event, event.payload);
    };
    window.addEventListener('pagehide', () => stream.close(), { once: true });
  }
}

/** HTTP 调用保留服务器错误，认证由同源浏览器会话处理，不把密码写入前端存储。 */
async function request<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('/api/command', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-NoteBoard-Request': '1', 'X-NoteBoard-Client': clientId },
    body: JSON.stringify({ command, args }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `请求失败（${response.status}）` }));
    throw new Error(error.error);
  }
  return (await response.json()).result as T;
}

/** 浏览器关闭/刷新无法等待异步弹窗，使用原生离开确认并依靠已有增量暂存恢复。 */
window.addEventListener('beforeunload', (event) => {
  if ([...useDocumentStore.getState().documents.values()].some((document) => document.isDirty || document.key.startsWith('untitled:') && !!document.content)) {
    event.preventDefault();
    event.returnValue = '';
  }
});

/** 本页事件沿用原生契约，监听返回的注销函数可安全重复调用。 */
export async function listen<T>(name: string, callback: (event: { payload: T }) => void): Promise<() => void> {
  const handler = (event: Event) => callback({ payload: (event as CustomEvent<T>).detail });
  events.addEventListener(name, handler);
  return () => events.removeEventListener(name, handler);
}

/** 派发本页业务事件，供平台无关的插件状态广播复用。 */
export function emit(name: string, payload?: unknown): void {
  events.dispatchEvent(new CustomEvent(name, { detail: payload }));
}

/** 统一生成经过认证、无磁盘路径泄露的附件 URL。 */
export function convertFileSrc(filePath: string): string {
  return `/api/file?path=${encodeURIComponent(filePath)}`;
}

/** 图表导出继续使用项目已有的浏览器下载分支。 */
export function isTauri(): boolean { return false; }

/** 编辑器不拥有桌面窗口；必要的全屏能力映射到浏览器 Fullscreen API。 */
const browserWindow = {
  label,
  isMaximized: async () => !!document.fullscreenElement,
  toggleMaximize: async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); },
  setFullscreen: async (enabled: boolean) => { if (enabled && !document.fullscreenElement) await document.documentElement.requestFullscreen(); else if (!enabled && document.fullscreenElement) await document.exitFullscreen(); },
  onResized: async (callback: () => void) => { window.addEventListener('resize', callback); return () => window.removeEventListener('resize', callback); },
  setTitle: async (title: string) => { document.title = title; },
};
export function getCurrentWindow(): typeof browserWindow { return browserWindow; }

// 极窄模式等桌面窗口能力在网页端不启用，仅补齐导出以通过打包时的具名导入检查。
export async function availableMonitors(): Promise<never[]> { return []; }
export class LogicalSize { constructor(public width: number, public height: number) {} }
export class PhysicalPosition { constructor(public x: number, public y: number) {} }

/** 浏览器不提供原生文件路径拖拽事件；图片粘贴/拖拽仍由编辑器现有逻辑处理。 */
export function getCurrentWebview() { return { onDragDropEvent: async () => () => {} }; }
export async function onBackButtonPress() { return () => {}; }

/** 将文件显式下载到访问者设备，隔离服务器文件和浏览器本地文件。 */
export function downloadWebFile(filePath: string): void {
  const anchor = document.createElement('a');
  anchor.href = `${convertFileSrc(filePath)}&download=1`;
  anchor.download = filePath.split('/').pop() || 'NoteBoard';
  // 应用会捕获 a.click，直接给独立窗口导航可绕开应用内链接路由。
  window.open(anchor.href, '_blank', 'noopener,noreferrer');
}

/** 网页 IPC：窗口状态保留在本页，文件与共享配置通过同源服务持久化。 */
export async function invoke<T>(command: string, rawArgs: Record<string, unknown> = {}): Promise<T> {
  const args = { ...rawArgs };
  let result: unknown;
  switch (command) {
    case 'window_listeners_ready':
      result = { protocolVersion: 1, consumerId: label, startupMode: queue.length ? 'explicit-open' : 'empty', transferId: null, queueVersion: sequence, isSoleWindow: true };
      break;
    case 'window_shell_ready': {
      const { useExplorerStore } = await import('../features/explorer/explorerStore');
      if (!useExplorerStore.getState().root) useExplorerStore.getState().setRoot(ROOT, await request('read_dir', { path: ROOT, showHidden: false }));
      break;
    }
    case 'enqueue_open_requests': {
      const batchId = randomId();
      for (const path of args.paths as string[]) queue.push({ request: { path, source: 'dialog', requestId: randomId(), batchId, sequence: ++sequence, cwd: null }, queueVersion: sequence });
      emit('nb://open-requests-available', { queueVersion: sequence });
      result = [batchId, sequence];
      break;
    }
    case 'list_open_requests': result = queue.slice(0, 32); break;
    case 'ack_open_request': {
      const index = queue.findIndex((item) => item.request.requestId === args.requestId);
      if (index >= 0) queue.splice(index, 1);
      result = true;
      break;
    }
    case 'register_document': registrations.add(String(args.key)); result = { type: 'ok' }; break;
    case 'unregister_document': registrations.delete(String(args.key)); revisions.delete(String(args.key)); readVersions.delete(String(args.key)); break;
    case 'find_document_owner': result = registrations.has(String(args.key)) ? label : null; break;
    case 'reconcile_documents': {
      const removed = [...registrations].filter((key) => !(args.keys as string[]).includes(key));
      removed.forEach((key) => registrations.delete(key));
      result = { removed };
      break;
    }
    case 'set_document_dirty': case 'record_web_spans': case 'focus_window': break;
    case 'is_perf_spans_enabled': result = false; break;
    case 'dump_perf_spans': result = ''; break;
    case 'list_system_fonts': result = await browserSystemFonts(args.allowBrowserPrompt === true); break;
    case 'download_font_pack': case 'remove_font_pack':
      result = await request(command, args);
      emit('noteboard-font-pack-changed', result);
      break;
    case 'get_platform_info': result = { platform: 'web', isMobile: false, defaultWorkspace: ROOT, externalRoot: ROOT, allFilesAccess: false }; break;
    case 'ensure_default_workspace': result = ROOT; break;
    case 'take_incoming_files': result = []; break;
    case 'set_system_bar_style': break;
    case 'open_external_url': {
      const url = new URL(String(args.url));
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error('不支持的链接协议');
      window.open(url.href, '_blank', 'noopener,noreferrer');
      break;
    }
    case 'open_with_default_app': case 'share_file': downloadWebFile(String(args.path)); break;
    case 'reveal_in_explorer': case 'open_staging_directory': {
      const dir = command === 'open_staging_directory' ? await request<string>('ensure_staging_directory') : String(args.path).split('/').slice(0, -1).join('/') || ROOT;
      const { useExplorerStore } = await import('../features/explorer/explorerStore');
      useExplorerStore.getState().setRoot(dir, await request('read_dir', { path: dir, showHidden: true }));
      result = dir;
      break;
    }
    case 'create_window': window.open(location.pathname, '_blank', 'noopener,noreferrer'); result = { label }; break;
    case 'close_window': window.close(); break;
    case 'read_xmind_file': {
      // 网页端继续使用受服务器工作区约束的二进制端点，与桌面返回相同的原始 ArrayBuffer。
      const path = String(args.path);
      if (!/\.xmind$/i.test(path)) throw new Error('此读取入口仅支持 .xmind 文件');
      const bytes = await readFile(path);
      result = bytes.buffer;
      break;
    }
    case 'read_preview_file': {
      // 二进制端点继续受到服务器工作区与 50 MB 上限约束。
      const bytes = await readFile(String(args.path)); result = bytes.buffer; break;
    }
    case 'load_settings': {
      const saved = await request<Partial<Settings> | null>(command);
      result = { ...DEFAULT_SETTINGS, ...saved, appearance: { ...DEFAULT_SETTINGS.appearance, ...saved?.appearance }, typography: { ...DEFAULT_SETTINGS.typography, ...saved?.typography }, editor: { ...DEFAULT_SETTINGS.editor, ...saved?.editor }, file: { ...DEFAULT_SETTINGS.file, stagingDirectory: `${ROOT}/.staging`, ...saved?.file }, layout: { ...DEFAULT_SETTINGS.layout, ...saved?.layout }, system: { ...DEFAULT_SETTINGS.system, ...saved?.system } };
      break;
    }
    case 'save_settings': result = await request(command, args); emit('nb://settings-changed', { ...args.settings as Settings, revision: result }); break;
    case 'write_document': case 'save_binary_file': {
      const key = String(args.path);
      const document = useDocumentStore.getState().getDocument(key);
      // 依据编辑文档的真实基线选择版本，外部核对不能把新远端版本误当成本地保存授权。
      const baseline = document?.baselineContent;
      args.expectedRevision = [...readVersions.get(key) ?? []].reverse().find((item) => item.content === baseline)?.revision ?? revisions.get(key) ?? null;
      if (command === 'save_binary_file') {
        const bytes = Uint8Array.from(args.data as number[]);
        let binary = '';
        for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
        args.base64 = btoa(binary);
        delete args.data;
      }
      result = await request(command, args);
      const version = (result as { webRevision: string }).webRevision;
      revisions.set(key, version);
      if (command === 'write_document') readVersions.set(key, [...readVersions.get(key) ?? [], { content: String(args.content), revision: version }].slice(-4));
      break;
    }
    default: {
      if (command === 'prepare_document' && registrations.has(String(args.path))) return { type: 'already-open', key: args.path, ownerLabel: label, ownerIsSelf: true } as T;
      result = await request(command, args);
      const payload = command === 'prepare_document' ? (result as { payload?: { key: string; webRevision: string; content: string } }).payload : result as { key?: string; webRevision?: string; content?: string };
      // 外部核对读取不改变正在编辑文档的写入版本；显式重新加载后才更新基线。
      if (payload?.key && payload.webRevision) {
        if (typeof payload.content === 'string') readVersions.set(payload.key, [...readVersions.get(payload.key) ?? [], { content: payload.content, revision: payload.webRevision }].slice(-4));
        if (!revisions.has(payload.key)) revisions.set(payload.key, payload.webRevision);
      }
    }
  }
  return result as T;
}

/** 浏览器中读取服务器二进制文件，继续支持 XMind 和图片等现有导入流程。 */
export async function readFile(filePath: string): Promise<Uint8Array> {
  const response = await fetch(convertFileSrc(filePath), { credentials: 'same-origin' });
  if (!response.ok) throw new Error('读取文件失败');
  return new Uint8Array(await response.arrayBuffer());
}

/** 每个活动目录以有界轮询检查变化，复用现有正文冲突检测；页面隐藏时减少服务器负担。 */
export async function watchImmediate(dir: string, callback: (event: { paths: string[]; type: string }) => void): Promise<() => void> {
  let stopped = false;
  let prior = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout>;
  async function poll(): Promise<void> {
    try {
      if (!document.hidden) {
        const nodes = await request<FileTreeNode[]>('read_dir', { path: dir, showHidden: true });
        const next = new Map(nodes.map((node) => [node.path, `${node.mtime}:${node.size}`]));
        const changed = new Set([...prior.keys(), ...next.keys()].filter((key) => prior.get(key) !== next.get(key)));
        if (prior.size && changed.size && !stopped) callback({ paths: [...changed], type: 'any' });
        prior = next;
      }
    } catch { /* 网络恢复后继续核对；写入错误由实际保存流程展示。 */ }
    if (!stopped) timer = setTimeout(() => void poll(), 2000);
  }
  void poll();
  return () => { stopped = true; clearTimeout(timer); };
}

interface DialogOptions { directory?: boolean; multiple?: boolean; defaultPath?: string; title?: string; filters?: { name: string; extensions: string[] }[] }

/** 安全创建文字按钮，文件名只作为 textContent，不能解释为 HTML。 */
function button(text: string, action: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button'; element.textContent = text; element.onclick = action;
  return element;
}

/** 服务器文件选择器：打开/保存/选择目录统一以工作区为边界，并提供显式本地上传入口。 */
async function choose(options: DialogOptions, saving: boolean): Promise<string | string[] | null> {
  const dialog = document.createElement('dialog');
  dialog.className = 'nb-web-dialog';
  const title = document.createElement('h2'); title.textContent = options.title || (saving ? '保存到服务器' : options.directory ? '选择服务器文件夹' : '打开服务器文件');
  const locationInput = document.createElement('input'); locationInput.ariaLabel = '服务器目录';
  const list = document.createElement('div'); list.className = 'nb-web-files';
  const error = document.createElement('div'); error.className = 'nb-web-error'; error.setAttribute('role', 'alert');
  const filename = document.createElement('input'); filename.ariaLabel = '文件名'; filename.placeholder = '文件名';
  const actions = document.createElement('div'); actions.className = 'nb-web-actions';
  let dir = options.defaultPath?.startsWith(ROOT + '/') ? options.defaultPath.split('/').slice(0, -1).join('/') : ROOT;
  if (saving) filename.value = options.defaultPath?.split(/[/\\]/).pop() || '未命名.md';
  const selected = new Set<string>();
  return new Promise((resolve) => {
    const finish = (value: string | string[] | null) => { dialog.close(); dialog.remove(); resolve(value); };
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    async function show(target: string): Promise<void> {
      try {
        const nodes = await request<FileTreeNode[]>('read_dir', { path: target, showHidden: true });
        if (!dialog.isConnected) return;
        dir = target; locationInput.value = dir; selected.clear(); list.replaceChildren(); error.textContent = '';
        if (dir !== ROOT) list.append(button('↰ 上一级', () => void show(dir.split('/').slice(0, -1).join('/') || ROOT)));
        for (const node of nodes) {
          const item = button(`${node.isDir ? '📁' : '📄'} ${node.name}`, () => {
            if (node.isDir) { void show(node.path); return; }
            if (options.directory) return;
            if (!options.multiple || saving) { selected.clear(); list.querySelectorAll('[aria-pressed]').forEach((row) => row.setAttribute('aria-pressed', 'false')); }
            if (selected.has(node.path)) selected.delete(node.path); else selected.add(node.path);
            item.setAttribute('aria-pressed', String(selected.has(node.path)));
            if (saving) filename.value = node.name;
          });
          if (options.directory && !node.isDir) continue;
          if (!node.isDir && !saving && options.filters?.length && !options.filters.some((filter) => filter.extensions.includes('*') || filter.extensions.some((ext) => node.name.toLowerCase().endsWith('.' + ext)))) continue;
          item.ondblclick = () => { if (!node.isDir && !saving && !options.directory) finish(options.multiple ? [node.path] : node.path); };
          list.append(item);
        }
      } catch (cause) { error.textContent = String(cause); }
    }
    locationInput.onkeydown = (event) => { if (event.key === 'Enter') void show(locationInput.value.replace(/\/+$/, '') || ROOT); };
    const confirm = button(saving ? '保存' : '选择', () => void (async () => {
      try {
        if (saving) {
          if (!filename.value.trim() || /[/\\]/.test(filename.value)) throw new Error('请输入单个文件名');
          const target = `${dir}/${filename.value}`;
          const exists = await request<{ exists: boolean }>('path_exists', { path: target });
          if (exists.exists) {
            if (!window.confirm('同名文件已存在，是否覆盖？')) return;
            revisions.set(target, await request<string>('file_revision', { path: target }));
          } else revisions.delete(target);
          finish(target);
        } else if (options.directory) finish(dir);
        else if (selected.size) finish(options.multiple ? [...selected] : [...selected][0]);
      } catch (cause) { error.textContent = String(cause); }
    })());
    if (!saving && !options.directory) {
      const upload = document.createElement('input'); upload.type = 'file'; upload.hidden = true; upload.multiple = !!options.multiple;
      if (options.filters?.length && !options.filters.some((filter) => filter.extensions.includes('*'))) upload.accept = options.filters.flatMap((filter) => filter.extensions.map((ext) => `.${ext}`)).join(',');
      upload.onchange = () => void (async () => {
        confirm.disabled = true;
        try {
          const paths: string[] = [];
          for (const file of Array.from(upload.files || [])) {
            const target = `${dir}/${file.name}`;
            const response = await fetch(`/api/upload?path=${encodeURIComponent(target)}`, { method: 'POST', headers: { 'X-NoteBoard-Request': '1' }, body: file });
            if (!response.ok) throw new Error((await response.json()).error);
            paths.push(target);
          }
          if (paths.length) finish(options.multiple ? paths : paths[0]);
        } catch (cause) { error.textContent = String(cause); } finally { confirm.disabled = false; }
      })();
      actions.append(button('从本机上传', () => upload.click()), upload);
    }
    actions.append(button('取消', () => finish(null)), confirm);
    dialog.append(title, locationInput, list);
    if (saving) dialog.append(filename);
    dialog.append(error, actions); document.body.append(dialog); dialog.showModal(); void show(dir);
  });
}

export function open(options: DialogOptions = {}): Promise<string | string[] | null> { return choose(options, false); }
export async function save(options: DialogOptions = {}): Promise<string | null> { return await choose(options, true) as string | null; }
