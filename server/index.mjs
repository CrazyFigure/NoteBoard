// NoteBoard 网页入口：同源 API、可选多用户登录与共享授权、静态资源托管。
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { fail, ROOT, MAX_FILE_BYTES, classify } from './files.mjs';
import { createPlugins } from './plugins.mjs';
import { createFonts } from './fonts.mjs';
import { createAccounts, ADMIN_ID } from './accounts.mjs';
import { createSpaces, SHARED } from './spaces.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const SESSION_COOKIE = 'nb_session';

/** 按客户端质量权重选择预压缩格式；显式 q=0 优先于通配符，同权重优先 Brotli。 */
function acceptedStaticEncodings(header) {
  const qualities = new Map(String(header ?? '').split(',').map((entry) => {
    const [name, ...parameters] = entry.trim().toLowerCase().split(';');
    const parameter = parameters.map((value) => value.trim()).find((value) => value.startsWith('q='));
    const quality = parameter === undefined ? 1 : Number(parameter.slice(2));
    return [name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0];
  }));
  return ['br', 'gzip'].map((encoding) => ({ encoding, quality: qualities.get(encoding) ?? qualities.get('*') ?? 0 }))
    .filter((item) => item.quality > 0).sort((a, b) => b.quality - a.quality).map((item) => item.encoding);
}

/** 创建服务，测试可传独立数据目录和端口，导入模块不会自动监听。 */
export async function createWebServer(options = {}) {
  const dataDir = options.dataDir ?? process.env.NOTEBOARD_DATA_DIR ?? path.join(projectDir, '.web-data');
  const staticDir = path.resolve(options.staticDir ?? process.env.NOTEBOARD_STATIC_DIR ?? path.join(projectDir, 'dist-web'));
  const username = options.username ?? process.env.NOTEBOARD_USERNAME ?? '';
  const password = options.password ?? process.env.NOTEBOARD_PASSWORD ?? '';
  if (Boolean(username) !== Boolean(password)) throw new Error('NOTEBOARD_USERNAME 和 NOTEBOARD_PASSWORD 必须同时设置或同时留空');
  if (username.includes(':')) throw new Error('访问账号不能包含冒号');
  // 设置管理员账号即启用多用户：管理员凭据只来自部署配置；两项留空保持公开单空间模式。
  const authEnabled = !!username;
  const accounts = authEnabled ? await createAccounts(dataDir, { username, password }) : null;
  const fonts = await createFonts(dataDir);
  // 插件程序按部署实例共享；用户文档与工作台布局继续由各自的文件服务管理。
  const pluginCommand = await createPlugins(dataDir, JSON.parse(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8')).version);
  // 原生工作进程同时提供多端同步与文档历史记录。同步管理包含云端凭证，只在部署访问认证已启用时开放给管理员；
  // 普通用户与未启用认证的部署只提供历史记录（不启动同步调度、不执行同步钩子）。
  const spaces = await createSpaces({ dataDir, accounts, allowAdminSync: authEnabled });
  const loginPage = await fs.readFile(new URL('./login.html', import.meta.url));
  // 公开模式没有登录，所有访问者使用原有的管理员空间。
  const publicUser = { id: ADMIN_ID, username: '', role: 'admin' };
  const streams = new Set();

  /** 请求体设置硬上限，同时校验声明长度；上传原始字节，避免数组膨胀内存。 */
  async function body(req, limit = MAX_FILE_BYTES + 1024 * 1024) {
    if (Number(req.headers['content-length']) > limit) throw fail('请求超过大小上限', 413);
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw fail('请求超过大小上限', 413);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  function cookie(req, name) {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const index = part.indexOf('=');
      if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
    }
    return '';
  }

  /** 直连 HTTPS、反向代理声明 HTTPS 或公开地址为 HTTPS 时，会话 Cookie 只经加密连接发送。 */
  function secure(req) {
    return !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' || String(process.env.NOTEBOARD_PUBLIC_URL ?? '').startsWith('https://');
  }

  function setSession(req, res, token, maxAge) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`);
  }

  /** 所有页面、接口、附件使用同一认证边界；健康检查与登录页除外。 */
  function authenticate(req) {
    if (!accounts) return publicUser;
    return accounts.session(cookie(req, SESSION_COOKIE));
  }

  /** 浏览器持久标识只用于区分同一账号在不同浏览器的草稿、最近记录和恢复快照。 */
  function clientKey(req) {
    const id = req.headers['x-noteboard-client'];
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw fail('浏览器标识无效');
    return `client-${id}`;
  }

  /** 只接受合法单段文件名，禁止在“新建名称”里偷偷指定其他目录。 */
  function child(dir, name) {
    if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\')) throw fail('请输入单个文件名');
    return `${dir}/${name}`;
  }

  /** 写入请求同源校验：拒绝跨站来源，并要求自定义头（HTML 表单无法跨站携带）。 */
  function checkWrite(req) {
    const origin = req.headers.origin;
    const publicUrl = process.env.NOTEBOARD_PUBLIC_URL;
    if (req.headers['sec-fetch-site'] === 'cross-site' || origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}` && origin !== publicUrl) throw fail('拒绝跨站写入请求', 403);
    if (req.headers['x-noteboard-request'] !== '1') throw fail('请求校验失败', 403);
  }

  function requireAdmin(user, message = '仅管理员可执行此操作') {
    if (user.role !== 'admin') throw fail(message, 403);
  }
  function requireMultiUser() {
    if (!accounts) throw fail('当前部署未启用多用户', 404);
  }

  /** 共享的是所有者自己的文件：只接受本人工作区内、非根目录且非隐藏的已存在路径。 */
  async function ownShareTarget(user, key) {
    const target = await spaces.route(user, key, 'read');
    if (!target.own) throw fail('只能共享自己的文件', 403);
    if (key === ROOT) throw fail('不能共享整个工作区');
    if (key.slice(ROOT.length + 1).split('/').some((part) => part.startsWith('.'))) throw fail('隐藏文件不能共享');
    await fs.stat(await target.space.files.resolve(key));
    return target;
  }

  /** 明确列出网页支持的业务命令；未知原生命令拒绝执行，避免暴露服务器系统能力。 */
  async function command(cmd, args, req, user) {
    const own = () => spaces.space(user.id);
    if (cmd === 'plugin_command') {
      // 插件程序按实例共享，安装、启用和卸载会影响所有用户。
      if (!['catalog', 'list', 'load'].includes(args.operation)) requireAdmin(user, '仅管理员可管理插件');
      return pluginCommand(`plugin_${args.operation}`, args);
    }
    if (cmd === 'get_font_pack_status' || cmd === 'refresh_font_pack_status') return fonts.status();
    if (cmd === 'download_font_pack') { requireAdmin(user, '仅管理员可管理字体包'); return fonts.download(); }
    if (cmd === 'remove_font_pack') { requireAdmin(user, '仅管理员可管理字体包'); return fonts.remove(); }
    const key = () => clientKey(req);
    if (cmd === 'web_capabilities') {
      return {
        syncAvailable: authEnabled && user.role === 'admin' && !!await spaces.admin.native(),
        authEnabled,
        historyAvailable: spaces.historyAvailable,
        multiUser: !!accounts,
        account: accounts ? { username: user.username, role: user.role } : null,
      };
    }
    if (cmd.startsWith('history_')) {
      if (!spaces.historyAvailable) throw fail('当前部署未启用历史记录', 503);
      // 共享文件的历史属于所有者：可读即可查看，可编辑才能写入还原检查点；置顶、删除版本仅所有者。
      if (typeof args.path === 'string') {
        const target = await spaces.route(user, args.path, cmd === 'history_list' || cmd === 'history_read' ? 'read' : 'edit');
        if (target.virtual) throw fail('文件不存在', 404);
        if (!target.own && cmd !== 'history_list' && cmd !== 'history_read' && cmd !== 'history_checkpoint') throw fail('仅所有者可管理历史版本', 403);
        return spaces.mapOut(target, await target.space.command(cmd, { ...args, path: target.key }));
      }
      return (await own()).command(cmd, args);
    }
    if (cmd.startsWith('sync_') || cmd.startsWith('backup_')) {
      if (!authEnabled) throw fail('网页同步需要先设置部署访问账号密码', 403);
      requireAdmin(user, '仅管理员可使用多端同步');
      const native = await spaces.admin.native();
      if (!native) throw fail('同步工作进程不可用，请检查镜像构建或 NOTEBOARD_SYNC_BINARY', 503);
      return native.command(cmd, args);
    }
    if (cmd.startsWith('account_') || cmd.startsWith('users_') || cmd.startsWith('share_')) requireMultiUser();
    if (cmd.startsWith('users_')) requireAdmin(user);
    switch (cmd) {
      case 'account_me': return { username: user.username, role: user.role };
      case 'account_change_password': await accounts.changePassword(user, args.oldPassword, args.newPassword); return null;
      case 'account_logout_others': await accounts.revoke(user.id, user.sessionId); return null;
      case 'users_list': return accounts.listUsers();
      case 'users_create': return accounts.createUser(args.username, args.password);
      case 'users_set_disabled': return accounts.setDisabled(String(args.id), args.disabled === true);
      case 'users_reset_password': return accounts.resetPassword(String(args.id), args.password);
      case 'users_delete': {
        const target = accounts.find(String(args.id));
        if (!target || target.id === ADMIN_ID) throw fail('用户不存在', 404);
        // 先把数据目录移入回收目录，成功后再删除账号记录，避免留下无主目录。
        await spaces.retire(target);
        await accounts.deleteUser(target.id);
        return null;
      }
      case 'share_targets': return accounts.shareTargets(user.id);
      case 'share_get': await ownShareTarget(user, args.path); return accounts.shareAt(user.id, args.path);
      case 'share_set': await ownShareTarget(user, args.path); return accounts.setShare(user.id, args.path, args.grants);
      case 'share_remove': await accounts.removeShare(user.id, String(args.id)); return null;
      case 'share_list_mine': {
        const space = await own();
        const result = [];
        for (const share of accounts.sharesOf(user.id)) {
          // 被同步或其他方式移走的目标标记失效，由所有者决定移除。
          const stat = await space.files.resolve(share.path).then((target) => fs.stat(target)).catch(() => null);
          result.push({ ...share, missing: !stat, isDir: !!stat?.isDirectory() });
        }
        return result;
      }
      case 'read_dir': {
        const target = await spaces.route(user, args.path, 'read');
        if (target.virtual) return spaces.listVirtual(user, target.parts);
        // 共享内容不包含隐藏文件（暂存、同步回收等内部目录）。
        const nodes = await target.space.files.list(target.key, target.own ? args.showHidden : false);
        return spaces.mapOut(target, target.readonly ? nodes.map((node) => ({ ...node, readonly: true })) : nodes);
      }
      case 'read_document': {
        const target = await spaces.route(user, args.path, 'read');
        if (target.virtual) throw fail('只能读取普通文件');
        return spaces.mapOut(target, await target.space.files.read(target.key));
      }
      case 'file_revision': {
        const target = await spaces.route(user, args.path, 'read');
        if (target.virtual) throw fail('只能读取普通文件');
        const { bytes } = await target.space.files.readBytes(target.key);
        return target.space.files.revision(bytes);
      }
      case 'probe_document':
      case 'path_exists': {
        const target = await spaces.route(user, args.path, 'read').catch((error) => {
          // 不存在或已取消的共享按“不存在”回答，与普通路径一致。
          if (error.status === 404 && String(args.path).startsWith(`${SHARED}/`)) return null;
          throw error;
        });
        if (target?.virtual) return { exists: true, isDir: true, size: 0, kind: 'code', isText: false };
        const stat = target && await fs.stat(await target.space.files.resolve(target.key)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        return { exists: !!stat, isDir: stat?.isDirectory() ?? false, size: stat?.size ?? 0, kind: classify(args.path)[0], isText: !!stat?.isFile() && classify(args.path)[0] !== 'image' };
      }
      case 'prepare_document': {
        const target = await spaces.route(user, args.path, 'read');
        if (target.virtual) return { type: 'directory', path: args.path };
        const stat = await fs.stat(await target.space.files.resolve(target.key)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) return { type: 'failed', message: '文件不存在', missing: true };
        if (stat.isDirectory()) return { type: 'directory', path: args.path };
        if (classify(args.path)[0] === 'image') return { type: 'image', key: args.path, displayName: path.posix.basename(args.path), dirPath: path.posix.dirname(args.path), language: 'plaintext', size: stat.size, mtime: Math.trunc(stat.mtimeMs) };
        const payload = spaces.mapOut(target, await target.space.files.read(target.key));
        if (payload.content?.includes('\0')) return { type: 'unsupported', ...payload, content: undefined };
        return { type: 'text', payload };
      }
      case 'write_document':
      case 'save_binary_file': {
        if (cmd === 'write_document' && classify(args.path)[0] === 'preview') throw fail('此文件仅支持只读查看');
        const target = await spaces.route(user, args.path, 'edit');
        if (target.virtual) throw fail('不能在此处修改', 403);
        // 共享文件的同步与历史钩子在所有者的工作进程中执行，所有者的同步与版本记录保持完整。
        await target.space.hook('prepare_write', { path: target.key });
        const bytes = cmd === 'write_document' ? target.space.files.encode(args.content, args.encoding, args.eol) : Buffer.from(args.base64, 'base64');
        const result = await target.space.files.write(target.key, bytes, args.expectedRevision);
        await target.space.hook('on_written', { path: target.key });
        return result;
      }
      case 'create_file': {
        const dir = await spaces.route(user, args.dir, 'edit');
        if (dir.virtual) throw fail('不能在此处新建', 403);
        const target = child(dir.key, args.name);
        if (!dir.own && args.name.startsWith('.')) throw fail('共享文件夹内不能新建隐藏文件');
        await dir.space.files.write(target, Buffer.alloc(0), null, true);
        await dir.space.hook('on_written', { path: target });
        return spaces.mapOut(dir, await dir.space.files.read(target));
      }
      case 'create_dir': {
        const dir = await spaces.route(user, args.dir, 'edit');
        if (dir.virtual) throw fail('不能在此处新建', 403);
        if (!dir.own && String(args.name).startsWith('.')) throw fail('共享文件夹内不能新建隐藏文件');
        const target = await dir.space.files.resolve(child(dir.key, args.name), { allowRoot: false });
        await fs.mkdir(target);
        return null;
      }
      case 'rename_path': {
        const from = await spaces.route(user, args.from, 'edit');
        if (from.virtual) throw fail('不能在此处修改', 403);
        if (from.shareRoot) throw fail('不能重命名或移动共享项本身', 403);
        const to = await spaces.route(user, args.to, 'edit');
        if (to.virtual || to.shareRoot) throw fail('不能移动到此处', 403);
        if (from.space !== to.space || from.own !== to.own) throw fail('不能跨空间移动，请复制后再粘贴', 400);
        const files = from.space.files;
        return files.serialize(async () => {
          const source = await files.resolve(from.key, { allowRoot: false });
          const destination = await files.resolve(to.key, { allowRoot: false });
          const existing = await fs.lstat(destination).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
          if (existing) throw fail('目标名称已存在', 409);
          await fs.rename(source, destination);
          await from.space.hook('on_renamed', { from: from.key, to: to.key });
          // 所有者在其下设置的共享随路径移动，接收者不会因改名失去访问。
          await accounts?.renameSharedPath(from.space.id, from.key, to.key);
          return null;
        });
      }
      case 'move_to_trash': {
        const target = await spaces.route(user, args.path, 'edit');
        if (target.virtual) throw fail('不能在此处修改', 403);
        if (target.shareRoot) throw fail('不能删除共享项本身', 403);
        const moved = await target.space.hook('move_to_sync_trash', { path: target.key });
        if (!moved) {
          await target.space.files.trash(target.key);
          // 历史记录钩子需要删除前的真实路径
          await target.space.hook('on_deleted', { path: target.key }).catch(() => {});
        }
        // 删除后移除其下共享，避免日后同名新文件意外继承授权。
        await accounts?.removeSharedPath(target.space.id, target.key);
        return null;
      }
      case 'load_settings': return (await own()).files.loadState('settings', null);
      case 'save_settings': {
        const revision = Date.now();
        await (await own()).files.saveState('settings', { ...args.settings, revision });
        return revision;
      }
      case 'load_favorites': return (await own()).files.loadState('favorites', { schemaVersion: 1, roots: [] });
      case 'save_favorites': await (await own()).files.saveState('favorites', args.favorites); return null;
      case 'load_session': return (await own()).files.loadState(`${key()}-session`, null);
      case 'save_session': await (await own()).files.saveState(`${key()}-session`, args.session); return null;
      case 'clear_session': await (await own()).files.saveState(`${key()}-session`, null); return null;
      case 'list_recent': return (await own()).files.loadState(`${key()}-recent`, []);
      case 'push_recent': {
        await spaces.route(user, args.path, 'read');
        const files = (await own()).files;
        const recent = await files.loadState(`${key()}-recent`, []);
        await files.saveState(`${key()}-recent`, [{ path: args.path, isDir: args.isDir, lastOpened: Date.now() }, ...recent.filter((item) => item.path !== args.path)].slice(0, 100));
        return null;
      }
      case 'list_drafts': return (await own()).files.loadState(`${key()}-drafts`, []);
      case 'write_draft':
      case 'delete_draft': {
        const files = (await own()).files;
        const drafts = await files.loadState(`${key()}-drafts`, []);
        const next = drafts.filter((item) => item.key !== args.key);
        if (cmd === 'write_draft') next.push({ key: args.key, content: args.content, kind: args.kind, savedAt: Date.now() });
        await files.saveState(`${key()}-drafts`, next.slice(-100));
        return null;
      }
      case 'get_default_staging_directory': return `${ROOT}/.staging`;
      case 'ensure_staging_directory': {
        // 暂存目录只能位于本人工作区，files.resolve 拒绝 /shared 等其他空间路径。
        const files = (await own()).files;
        const settings = await files.loadState('settings', null);
        const target = settings?.file?.stagingDirectory || `${ROOT}/.staging`;
        await fs.mkdir(await files.resolve(target), { recursive: true });
        return target;
      }
      case 'stash_documents': {
        const files = (await own()).files;
        const settings = await files.loadState('settings', null);
        const staging = settings?.file?.stagingDirectory || `${ROOT}/.staging`;
        await fs.mkdir(await files.resolve(staging), { recursive: true });
        const result = [];
        if (!Array.isArray(args.documents) || args.documents.length > 100) throw fail('一次最多暂存 100 个文档');
        for (const doc of args.documents) {
          const name = `${Date.now()}-${randomUUID()}-${path.posix.basename(doc.displayName || '未命名.md')}`;
          // 已有暂存路径仅允许在当前暂存目录内复用，防止定时任务每次生成一份副本。
          const stagedPath = doc.targetPath || child(staging, name);
          if (!stagedPath.startsWith(`${staging}/`)) throw fail('暂存路径不合法');
          const old = await files.readBytes(stagedPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
          await files.write(stagedPath, files.encode(doc.content ?? '', doc.encoding ?? 'utf8', doc.eol ?? 'lf'), old ? files.revision(old.bytes) : null);
          result.push({ key: doc.key, targetPath: stagedPath });
        }
        return result;
      }
      case 'delete_staged_file': {
        // 暂存清理不得借传参删除普通笔记；保留服务器回收副本。
        const files = (await own()).files;
        const settings = await files.loadState('settings', null);
        const staging = settings?.file?.stagingDirectory || `${ROOT}/.staging`;
        if (!args.path.startsWith(`${staging}/`)) throw fail('仅能清理暂存目录内的副本');
        await files.trash(args.path);
        return null;
      }
      default: throw fail(`网页端不支持该系统操作：${cmd}`, 404);
    }
  }

  /** JSON 响应统一禁止缓存，避免账号切换或重新部署后复用私人数据。 */
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  /** HTML 页面按实际内联脚本生成哈希写入 CSP，而不全局放开内联脚本。 */
  function contentSecurity(bytes, isHtml) {
    const scriptHashes = isHtml ? [...bytes.toString().matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`).join(' ') : '';
    return `default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval' ${scriptHashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' blob: data: https:; connect-src 'self' blob: https:; worker-src 'self' blob:; frame-src https://embed.diagrams.net; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`;
  }

  function sendLogin(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': contentSecurity(loginPage, true) });
    res.end(req.method === 'HEAD' ? undefined : loginPage);
  }

  async function serveStatic(req, res, pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { throw fail('URL 不合法'); }
    if (decoded.split('/').some((part) => part.startsWith('.')) || decoded.includes('\\')) throw fail('资源不存在', 404);
    const target = path.resolve(staticDir, `.${decoded === '/' ? '/index.html' : decoded}`);
    if (!target.startsWith(staticDir + path.sep)) throw fail('资源不存在', 404);
    const ext = path.extname(target);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw fail('资源不存在', 404);
    let bytes;
    let encoding;
    // 仅构建文本资源使用预压缩副本；旧构建未提供副本时回退原文件，不压缩私人 API 和附件。
    const compressible = /\.(js|css|json|svg)$/.test(ext);
    if (compressible && stat.size >= 1024) {
      for (const candidate of acceptedStaticEncodings(req.headers['accept-encoding'])) {
        try {
          bytes = await fs.readFile(`${target}.${candidate === 'br' ? 'br' : 'gz'}`);
          encoding = candidate;
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
    bytes ??= await fs.readFile(target);
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' }[ext] ?? 'application/octet-stream';
    // Vite 入口保留了两段固定引导脚本，按实际内容生成哈希，而不全局放开内联脚本。
    res.writeHead(200, {
      'Content-Type': mime, 'Content-Length': bytes.length,
      'Cache-Control': ext === '.html' ? 'no-store' : 'private, max-age=3600',
      'Content-Security-Policy': contentSecurity(bytes, ext === '.html'),
      ...(compressible ? { Vary: 'Accept-Encoding' } : {}),
      ...(encoding ? { 'Content-Encoding': encoding } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  const server = http.createServer(async (req, res) => {
    // 文件内容（包括 SVG / HTML）作为附件隔离，不能在应用源内执行脚本。
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      const url = new URL(req.url, 'http://noteboard.local');
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) throw fail('不支持的请求方法', 405);
      // 登录页只需要图标，其余静态资源仍在认证之后。
      if ((url.pathname === '/favicon.ico' || url.pathname === '/logo.png') && req.method !== 'POST') return await serveStatic(req, res, url.pathname);
      if (url.pathname === '/login' && req.method !== 'POST') {
        if (!accounts || authenticate(req)) { res.writeHead(302, { Location: '/' }).end(); return; }
        return sendLogin(req, res);
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        checkWrite(req);
        if (!accounts) throw fail('当前部署无需登录', 404);
        const input = JSON.parse((await body(req, 8192)).toString('utf8'));
        const { token } = await accounts.login(input?.username, input?.password, req.socket.remoteAddress);
        setSession(req, res, token, 30 * 24 * 3600);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        checkWrite(req);
        await accounts?.logout(cookie(req, SESSION_COOKIE));
        setSession(req, res, '', 0);
        return json(res, 200, { ok: true });
      }
      const user = authenticate(req);
      if (!user) {
        if (url.pathname.startsWith('/api/')) return json(res, 401, { error: '登录已失效，请重新登录', code: 'unauthenticated' });
        // 页面请求转到登录页，登录后回到原地址；脚本等资源直接拒绝。
        if (req.method !== 'POST' && String(req.headers.accept ?? '').includes('text/html')) {
          res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store' }).end();
          return;
        }
        res.writeHead(401, { 'Cache-Control': 'no-store' }).end('请先登录');
        return;
      }
      if (url.pathname.startsWith('/api/font-pack/') && req.method === 'GET') {
        const name = decodeURIComponent(url.pathname.slice('/api/font-pack/'.length));
        const bytes = await fonts.asset(name);
        res.writeHead(200, {'Content-Type':name.endsWith('.ttf') ? 'font/ttf' : 'font/woff2','Cache-Control':'private, max-age=3600'});
        return res.end(bytes);
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        const space = await spaces.space(user.id);
        if (!space.historyAvailable) throw fail('同步事件不可用', 403);
        if (streams.size >= 500) throw fail('连接数过多', 429);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n'); streams.add(res);
        // 每个用户只收到自己空间的事件；未启用多端同步的空间只转发历史记录事件
        const forward = (event) => { if (space.syncAllowed || String(event.event).startsWith('nb://history-')) res.write(`data: ${JSON.stringify(event)}\n\n`); };
        space.events.on('event', forward);
        const timer = setInterval(() => res.write(': heartbeat\n\n'), 25000);
        req.on('close', () => { clearInterval(timer); streams.delete(res); space.events.off('event', forward); });
        return;
      }
      if (req.method === 'POST') {
        checkWrite(req);
        if (url.pathname === '/api/upload') {
          const target = await spaces.route(user, url.searchParams.get('path'), 'edit');
          if (target.virtual) throw fail('不能在此处上传', 403);
          const result = await target.space.files.write(target.key, await body(req, MAX_FILE_BYTES), null, true);
          await target.space.hook('on_written', { path: target.key });
          return json(res, 200, result);
        }
        if (url.pathname === '/api/command') {
          if (!req.headers['content-type']?.startsWith('application/json')) throw fail('需要 JSON 请求', 415);
          const input = JSON.parse((await body(req, 72 * 1024 * 1024)).toString('utf8'));
          if (!input || typeof input.command !== 'string' || input.args && (typeof input.args !== 'object' || Array.isArray(input.args))) throw fail('命令参数不合法');
          return json(res, 200, { result: await command(input.command, input.args ?? {}, req, user) });
        }
        throw fail('接口不存在', 404);
      }
      if (url.pathname === '/api/file') {
        const key = url.searchParams.get('path');
        const target = await spaces.route(user, key, 'read');
        if (target.virtual) throw fail('文件不存在', 404);
        const { bytes } = await target.space.files.readBytes(target.key);
        const ext = path.posix.extname(key).toLowerCase();
        const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' }[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", 'Content-Disposition': `${url.searchParams.has('download') || !mime.startsWith('image/') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.posix.basename(key))}` });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      if (url.pathname.startsWith('/api/')) throw fail('接口不存在', 404);
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : error instanceof SyntaxError ? 400 : 500);
      // 不把服务器绝对路径、系统异常堆栈或认证信息返回给访问者。
      if (status === 500) console.error('网页请求处理失败:', error.message);
      if (res.headersSent) { res.end(); return; }
      json(res, status, { error: error.status ? error.message : status === 404 ? '文件不存在' : status === 400 ? '请求格式不合法' : '服务器操作失败，请检查日志' });
    }
  });
  server.requestTimeout = 120000;
  // 停止时先关闭 SSE，避免长连接阻止服务和同步工作进程退出。
  server.stopNoteboard = () => { for (const stream of streams) stream.end(); void spaces.closeAll(); };
  // 直接关闭 HTTP 服务时同样停止全部工作进程
  server.on('close', () => void spaces.closeAll());
  return server;
}

// 只在直接执行入口时启动；容器终止信号关闭监听并给正在写入的请求留出完成时间。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createWebServer();
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(`NoteBoard 网页服务已启动，端口 ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.stopNoteboard();
    server.close();
    server.closeIdleConnections();
  });
}
