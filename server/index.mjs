// NoteBoard 网页入口：同源 API、可选 HTTP Basic 认证和静态资源托管。
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { createFiles, fail, ROOT, MAX_FILE_BYTES, classify } from './files.mjs';
import { startSyncWorker } from './sync.mjs';
import { createPlugins } from './plugins.mjs';
import { createFonts } from './fonts.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));

/** 创建服务，测试可传独立数据目录和端口，导入模块不会自动监听。 */
export async function createWebServer(options = {}) {
  const dataDir = options.dataDir ?? process.env.NOTEBOARD_DATA_DIR ?? path.join(projectDir, '.web-data');
  const staticDir = path.resolve(options.staticDir ?? process.env.NOTEBOARD_STATIC_DIR ?? path.join(projectDir, 'dist-web'));
  const username = options.username ?? process.env.NOTEBOARD_USERNAME ?? '';
  const password = options.password ?? process.env.NOTEBOARD_PASSWORD ?? '';
  if (Boolean(username) !== Boolean(password)) throw new Error('NOTEBOARD_USERNAME 和 NOTEBOARD_PASSWORD 必须同时设置或同时留空');
  if (username.includes(':')) throw new Error('访问账号不能包含冒号');
  const files = await createFiles(dataDir);
  const fonts = await createFonts(dataDir);
  // 插件程序按部署实例共享；用户文档与工作台布局继续由文件服务管理。
  const pluginCommand = await createPlugins(dataDir, JSON.parse(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8')).version);
  // 原生工作进程同时提供多端同步与文档历史记录。同步管理包含云端凭证，只在部署访问认证已启用时开放；
  // 未启用认证时工作进程只提供历史记录（不启动同步调度、不执行同步钩子）。
  const native = await startSyncWorker(files, dataDir, { allowSync: !!username });
  const sync = username ? native : null;
  const streams = new Set();
  const attempts = new Map();

  /** 敏感字符串按定长摘要比较，避免通过字符串长度或比较时间猜测密码。 */
  function equal(a, b) {
    const hash = (value) => createHash('sha256').update(value).digest();
    return timingSafeEqual(hash(a), hash(b));
  }

  /** 所有页面、接口、附件使用同一认证边界；健康检查仅返回固定状态。 */
  function authorize(req, res) {
    if (!username) return true;
    const address = req.socket.remoteAddress;
    const now = Date.now();
    const prior = attempts.get(address);
    if (prior && prior.until > now && prior.count >= 30) {
      res.writeHead(429, { 'Retry-After': '60' }).end('登录尝试过多，请稍后重试');
      return false;
    }
    const header = req.headers.authorization ?? '';
    const credential = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '';
    if (equal(credential, `${username}:${password}`)) { attempts.delete(address); return true; }
    // 只保留有界的限流状态，避免匿名请求不断制造内存占用。
    if (attempts.size > 10000) attempts.clear();
    attempts.set(address, { count: prior?.until > now ? prior.count + 1 : 1, until: prior?.until > now ? prior.until : now + 60000 });
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="NoteBoard", charset="UTF-8"', 'Cache-Control': 'no-store' }).end('请使用部署时设置的账号密码登录');
    return false;
  }

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

  /** 按浏览器持久身份隔离草稿、最近记录和恢复快照，已保存的笔记和收藏共享。 */
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

  /** 明确列出网页支持的业务命令；未知原生命令拒绝执行，避免暴露服务器系统能力。 */
  async function command(cmd, args, req) {
    if (cmd === 'plugin_command') return pluginCommand(`plugin_${args.operation}`, args);
    if (cmd === 'get_font_pack_status' || cmd === 'refresh_font_pack_status') return fonts.status();
    if (cmd === 'download_font_pack') return fonts.download();
    if (cmd === 'remove_font_pack') return fonts.remove();
    const key = () => clientKey(req);
    if (cmd === 'web_capabilities') return { syncAvailable: !!sync, authEnabled: !!username, historyAvailable: !!native };
    if (cmd.startsWith('history_')) {
      if (!native) throw fail('当前部署未启用历史记录', 503);
      return native.command(cmd, args);
    }
    if (cmd.startsWith('sync_') || cmd.startsWith('backup_')) {
      if (!username) throw fail('网页同步需要先设置部署访问账号密码', 403);
      if (!sync) throw fail('同步工作进程不可用，请检查镜像构建或 NOTEBOARD_SYNC_BINARY', 503);
      return sync.command(cmd, args);
    }
    switch (cmd) {
      case 'read_dir': return files.list(args.path, args.showHidden);
      case 'read_document': return files.read(args.path);
      case 'file_revision': {
        const { bytes } = await files.readBytes(args.path);
        return files.revision(bytes);
      }
      case 'probe_document':
      case 'path_exists': {
        const target = await files.resolve(args.path);
        const stat = await fs.stat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        return { exists: !!stat, isDir: stat?.isDirectory() ?? false, size: stat?.size ?? 0, kind: classify(args.path)[0], isText: !!stat?.isFile() && classify(args.path)[0] !== 'image' };
      }
      case 'prepare_document': {
        const target = await files.resolve(args.path);
        const stat = await fs.stat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) return { type: 'failed', message: '文件不存在', missing: true };
        if (stat.isDirectory()) return { type: 'directory', path: args.path };
        if (classify(args.path)[0] === 'image') return { type: 'image', key: args.path, displayName: path.posix.basename(args.path), dirPath: path.posix.dirname(args.path), language: 'plaintext', size: stat.size, mtime: Math.trunc(stat.mtimeMs) };
        const payload = await files.read(args.path);
        if (payload.content?.includes('\0')) return { type: 'unsupported', ...payload, content: undefined };
        return { type: 'text', payload };
      }
      case 'write_document':
      case 'save_binary_file': {
        if (cmd === 'write_document' && classify(args.path)[0] === 'preview') throw fail('此文件仅支持只读查看');
        await native?.hook('prepare_write', { path: args.path });
        const bytes = cmd === 'write_document' ? files.encode(args.content, args.encoding, args.eol) : Buffer.from(args.base64, 'base64');
        const result = await files.write(args.path, bytes, args.expectedRevision);
        await native?.hook('on_written', { path: args.path });
        return result;
      }
      case 'create_file': {
        const target = child(args.dir, args.name);
        await files.write(target, Buffer.alloc(0), null, true);
        await native?.hook('on_written', { path: target });
        return files.read(target);
      }
      case 'create_dir': {
        const target = await files.resolve(child(args.dir, args.name), { allowRoot: false });
        await fs.mkdir(target);
        return null;
      }
      case 'rename_path': return files.serialize(async () => {
        const from = await files.resolve(args.from, { allowRoot: false });
        const to = await files.resolve(args.to, { allowRoot: false });
        const existing = await fs.lstat(to).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (existing) throw fail('目标名称已存在', 409);
        await fs.rename(from, to);
        await native?.hook('on_renamed', { from: args.from, to: args.to });
        return null;
      });
      case 'move_to_trash': {
        const moved = await native?.hook('move_to_sync_trash', { path: args.path });
        if (!moved) {
          // 历史记录钩子需要删除前的真实路径
          const resolved = native ? await files.resolve(args.path) : null;
          await files.trash(args.path);
          if (resolved) await native.hook('on_deleted', { path: args.path }).catch(() => {});
        }
        return null;
      }
      case 'load_settings': return files.loadState('settings', null);
      case 'save_settings': {
        const revision = Date.now();
        await files.saveState('settings', { ...args.settings, revision });
        return revision;
      }
      case 'load_favorites': return files.loadState('favorites', { schemaVersion: 1, roots: [] });
      case 'save_favorites': await files.saveState('favorites', args.favorites); return null;
      case 'load_session': return files.loadState(`${key()}-session`, null);
      case 'save_session': await files.saveState(`${key()}-session`, args.session); return null;
      case 'clear_session': await files.saveState(`${key()}-session`, null); return null;
      case 'list_recent': return files.loadState(`${key()}-recent`, []);
      case 'push_recent': {
        await files.resolve(args.path);
        const recent = await files.loadState(`${key()}-recent`, []);
        await files.saveState(`${key()}-recent`, [{ path: args.path, isDir: args.isDir, lastOpened: Date.now() }, ...recent.filter((item) => item.path !== args.path)].slice(0, 100));
        return null;
      }
      case 'list_drafts': return files.loadState(`${key()}-drafts`, []);
      case 'write_draft':
      case 'delete_draft': {
        const drafts = await files.loadState(`${key()}-drafts`, []);
        const next = drafts.filter((item) => item.key !== args.key);
        if (cmd === 'write_draft') next.push({ key: args.key, content: args.content, kind: args.kind, savedAt: Date.now() });
        await files.saveState(`${key()}-drafts`, next.slice(-100));
        return null;
      }
      case 'get_default_staging_directory': return `${ROOT}/.staging`;
      case 'ensure_staging_directory': {
        const settings = await files.loadState('settings', null);
        const target = settings?.file?.stagingDirectory || `${ROOT}/.staging`;
        await fs.mkdir(await files.resolve(target), { recursive: true });
        return target;
      }
      case 'stash_documents': {
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

  const server = http.createServer(async (req, res) => {
    // 文件内容（包括 SVG / HTML）作为附件隔离，不能在应用源内执行脚本。
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      const url = new URL(req.url, 'http://noteboard.local');
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if (!authorize(req, res)) return;
      if (url.pathname.startsWith('/api/font-pack/') && req.method === 'GET') {
        const name = decodeURIComponent(url.pathname.slice('/api/font-pack/'.length));
        const bytes = await fonts.asset(name);
        res.writeHead(200, {'Content-Type':name.endsWith('.ttf') ? 'font/ttf' : 'font/woff2','Cache-Control':'private, max-age=3600'});
        return res.end(bytes);
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!native) throw fail('同步事件不可用', 403);
        if (streams.size >= 100) throw fail('连接数过多', 429);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n'); streams.add(res);
        // 未启用多端同步（无访问认证）时只转发历史记录事件
        const forward = (event) => { if (sync || String(event.event).startsWith('nb://history-')) res.write(`data: ${JSON.stringify(event)}\n\n`); };
        native.events.on('event', forward);
        const timer = setInterval(() => res.write(': heartbeat\n\n'), 25000);
        req.on('close', () => { clearInterval(timer); streams.delete(res); native.events.off('event', forward); });
        return;
      }
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) throw fail('不支持的请求方法', 405);
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        const publicUrl = process.env.NOTEBOARD_PUBLIC_URL;
        if (req.headers['sec-fetch-site'] === 'cross-site' || origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}` && origin !== publicUrl) throw fail('拒绝跨站写入请求', 403);
        // 自定义头不能由 HTML 表单跨站发送；同时拒绝没有显式 API 标记的写入。
        if (req.headers['x-noteboard-request'] !== '1') throw fail('请求校验失败', 403);
        if (url.pathname === '/api/upload') {
          const target = url.searchParams.get('path');
          const result = await files.write(target, await body(req, MAX_FILE_BYTES), null, true);
          await native?.hook('on_written', { path: target });
          return json(res, 200, result);
        }
        if (url.pathname === '/api/command') {
          if (!req.headers['content-type']?.startsWith('application/json')) throw fail('需要 JSON 请求', 415);
          const input = JSON.parse((await body(req, 72 * 1024 * 1024)).toString('utf8'));
          if (!input || typeof input.command !== 'string' || input.args && (typeof input.args !== 'object' || Array.isArray(input.args))) throw fail('命令参数不合法');
          return json(res, 200, { result: await command(input.command, input.args ?? {}, req) });
        }
        throw fail('接口不存在', 404);
      }
      if (url.pathname === '/api/file') {
        const key = url.searchParams.get('path');
        const { bytes } = await files.readBytes(key);
        const ext = path.posix.extname(key).toLowerCase();
        const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' }[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", 'Content-Disposition': `${url.searchParams.has('download') || !mime.startsWith('image/') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.posix.basename(key))}` });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      if (url.pathname.startsWith('/api/')) throw fail('接口不存在', 404);
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { throw fail('URL 不合法'); }
      if (decoded.split('/').some((part) => part.startsWith('.')) || decoded.includes('\\')) throw fail('资源不存在', 404);
      const target = path.resolve(staticDir, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (!target.startsWith(staticDir + path.sep)) throw fail('资源不存在', 404);
      const bytes = await fs.readFile(target);
      const ext = path.extname(target);
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' }[ext] ?? 'application/octet-stream';
      // Vite 入口保留了两段固定引导脚本，按实际内容生成哈希，而不全局放开内联脚本。
      const scriptHashes = ext === '.html' ? [...bytes.toString().matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`).join(' ') : '';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': ext === '.html' ? 'no-store' : 'private, max-age=3600', 'Content-Security-Policy': `default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval' ${scriptHashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' blob: data: https:; connect-src 'self' blob: https:; worker-src 'self' blob:; frame-src https://embed.diagrams.net; object-src 'none'; base-uri 'self'; frame-ancestors 'self'` });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : error instanceof SyntaxError ? 400 : 500);
      // 不把服务器绝对路径、系统异常堆栈或认证信息返回给访问者。
      if (status === 500) console.error('网页请求处理失败:', error.message);
      json(res, status, { error: error.status ? error.message : status === 404 ? '文件不存在' : status === 400 ? '请求格式不合法' : '服务器操作失败，请检查日志' });
    }
  });
  server.requestTimeout = 120000;
  server.on('close', () => sync?.close());
  // 停止时先关闭 SSE，避免长连接阻止服务和同步工作进程退出。
  server.stopNoteboard = () => { for (const stream of streams) stream.end(); native?.close(); };
  // 直接关闭 HTTP 服务时同样停止工作进程
  server.on('close', () => native?.close());
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
