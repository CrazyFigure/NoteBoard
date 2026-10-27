// 多用户空间：每个账号独立的文件服务与历史工作进程，以及“共享给我”虚拟路径的逐请求授权路由。
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createFiles, fail, ROOT, classify } from './files.mjs';
import { startSyncWorker, workerBinary } from './sync.mjs';
import { ADMIN_ID } from './accounts.mjs';

export const SHARED = '/shared';
// 普通用户只有历史记录工作进程，没有后台同步任务，空闲后可安全关闭，下次使用时再启动。
const IDLE_MS = 30 * 60 * 1000;
const MAX_USER_WORKERS = 50;

/** 用户名可能来自部署环境变量，转换为合法的单段路径名。 */
function segment(name) {
  // 控制字符逐个替换，避免正则中出现控制字符区间
  let value = Array.from(String(name), (char) => char.charCodeAt(0) < 32 || '\\/<>:"|?*'.includes(char) ? '_' : char).join('').trim().replace(/[. ]+$/, '');
  if (!value || value.startsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value)) value = `_${value}`;
  return value;
}

/** 同名条目在扩展名前追加序号，保持文档类型识别不变。 */
function unique(name, used) {
  if (!used.has(name)) return name;
  const { name: stem, ext } = path.posix.parse(name);
  for (let index = 2; ; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * accounts 为空表示公开模式：只有管理员空间，不提供共享路径。
 * allowAdminSync 与原行为一致：仅在部署启用访问认证时允许管理员空间多端同步。
 */
export async function createSpaces({ dataDir, accounts, allowAdminSync }) {
  const base = path.resolve(dataDir);
  const spaces = new Map();
  const historyAvailable = await fs.access(workerBinary()).then(() => true, () => false);

  async function build(id) {
    const dir = id === ADMIN_ID ? base : path.join(base, 'users', id);
    const files = await createFiles(dir);
    // 事件中转独立于工作进程，进程空闲关闭再启动后，已连接的事件流仍能收到新事件。
    const events = new EventEmitter();
    events.setMaxListeners(200);
    const syncAllowed = id === ADMIN_ID && allowAdminSync;
    let worker = null;
    let starting = null;
    let unavailable = false;
    const space = { id, dir, files, events, syncAllowed, historyAvailable, lastUsed: Date.now() };

    space.native = async () => {
      space.lastUsed = Date.now();
      if (worker?.alive()) return worker;
      if (unavailable) return null;
      starting ??= (async () => {
        const started = await startSyncWorker(files, dir, { allowSync: syncAllowed });
        if (!started) { unavailable = true; return null; }
        started.events.on('event', (event) => events.emit('event', event));
        worker = started;
        return started;
      })().finally(() => { starting = null; });
      const result = await starting;
      if (id !== ADMIN_ID) limitWorkers();
      return result;
    };
    space.running = () => !!worker?.alive();
    space.close = () => { worker?.close(); worker = null; };
    space.hook = async (name, args) => (await space.native())?.hook(name, args);
    space.command = async (name, args) => {
      const native = await space.native();
      if (!native) throw fail('当前部署未启用历史记录', 503);
      try { return await native.command(name, args); } finally { space.lastUsed = Date.now(); }
    };
    return space;
  }

  /** 同一账号并发请求只创建一次空间。 */
  function space(id) {
    let pending = spaces.get(id);
    if (!pending) {
      pending = build(id);
      spaces.set(id, pending);
      pending.catch(() => spaces.delete(id));
    }
    return pending;
  }

  /** 运行中的普通用户工作进程超过上限时，关闭最久未用的。 */
  async function limitWorkers() {
    const running = (await Promise.all([...spaces.values()].map((item) => item.catch(() => null)))).filter((item) => item && item.id !== ADMIN_ID && item.running());
    running.sort((a, b) => a.lastUsed - b.lastUsed);
    while (running.length > MAX_USER_WORKERS) running.shift().close();
  }

  const idleTimer = setInterval(async () => {
    const now = Date.now();
    for (const pending of spaces.values()) {
      const item = await pending.catch(() => null);
      if (item && item.id !== ADMIN_ID && item.running() && now - item.lastUsed > IDLE_MS) item.close();
    }
  }, 5 * 60 * 1000);
  idleTimer.unref();

  // 管理员空间立即启动，保证同步调度在服务启动后即开始运行（与原单用户行为一致）。
  const admin = await space(ADMIN_ID);
  await admin.native();

  /** 当前用户可见的共享树：所有者文件夹 → 共享项，名称在本次计算内唯一。 */
  function tree(user) {
    const groups = new Map();
    const byOwner = new Map();
    for (const share of accounts.incoming(user.id)) {
      let group = byOwner.get(share.ownerId);
      if (!group) {
        group = { name: unique(segment(share.owner), groups), ownerId: share.ownerId, owner: share.owner, items: new Map() };
        groups.set(group.name, group);
        byOwner.set(share.ownerId, group);
      }
      group.items.set(unique(path.posix.basename(share.path), group.items), share);
    }
    return groups;
  }

  /**
   * 将访问路径解析到真实所属空间。need 为 read / edit；无权访问统一 404，不暴露他人文件是否存在。
   * 返回的 key 仍是所属空间内的 /workspace 虚拟路径，最终由该空间的 files.resolve 逐段校验。
   */
  async function route(user, key, need = 'read') {
    if (typeof key !== 'string') throw fail('路径不合法');
    if (key === ROOT || key.startsWith(`${ROOT}/`)) return { space: await space(user.id), key, own: true, readonly: false };
    if (accounts && (key === SHARED || key.startsWith(`${SHARED}/`))) {
      const parts = key.slice(SHARED.length).split('/').slice(1);
      if (parts.some((part) => !part)) throw fail('路径不合法');
      // /shared 与 /shared/<所有者> 是只读的虚拟目录。
      if (parts.length < 2) {
        if (need !== 'read') throw fail('不能在此处修改', 403);
        if (parts.length === 1 && !tree(user).has(parts[0])) throw fail('文件不存在', 404);
        return { virtual: true, parts, own: false, readonly: true };
      }
      const share = tree(user).get(parts[0])?.items.get(parts[1]);
      if (!share) throw fail('文件不存在', 404);
      const rest = parts.slice(2);
      // 共享内容不包含隐藏文件（暂存、同步回收、历史等内部目录）。
      if (rest.some((part) => part.startsWith('.'))) throw fail('文件不存在', 404);
      if (need !== 'read' && share.permission !== 'edit') throw fail('只读共享，无法修改', 403);
      return {
        space: await space(share.ownerId),
        key: share.path + (rest.length ? `/${rest.join('/')}` : ''),
        own: false,
        readonly: share.permission === 'read',
        shareRoot: !rest.length,
        ownerId: share.ownerId,
        from: share.path,
        to: `${SHARED}/${parts[0]}/${parts[1]}`,
      };
    }
    throw fail(accounts ? '路径必须位于 /workspace 或 /shared' : '路径必须位于 /workspace');
  }

  /** 把所属空间的路径改写回访问者看到的共享路径；只读共享同时标记 readonly。 */
  function mapOut(target, value) {
    if (!target || target.own || target.virtual) return value;
    const parentFrom = path.posix.dirname(target.from);
    const parentTo = path.posix.dirname(target.to);
    const convert = (text) => {
      if (text === target.from || text.startsWith(`${target.from}/`)) return target.to + text.slice(target.from.length);
      return text === parentFrom ? parentTo : text;
    };
    const walk = (item) => {
      if (Array.isArray(item)) return item.map(walk);
      if (!item || typeof item !== 'object') return item;
      const output = {};
      for (const [name, field] of Object.entries(item)) output[name] = typeof field === 'string' && (name === 'key' || name === 'path' || name === 'dirPath') ? convert(field) : walk(field);
      if (target.readonly && 'readonly' in item) output.readonly = true;
      return output;
    };
    return walk(value);
  }

  /** 列出 /shared 虚拟目录；目标已被移走或删除的共享不显示。 */
  async function listVirtual(user, parts) {
    const groups = tree(user);
    if (!parts.length) {
      return [...groups.values()]
        .map((group) => ({ path: `${SHARED}/${group.name}`, name: group.name, isDir: true, kind: null, size: 0, mtime: 0, isHidden: false, isSymlink: false, readonly: true }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }
    const group = groups.get(parts[0]);
    if (!group) throw fail('文件不存在', 404);
    const result = [];
    for (const [name, share] of group.items) {
      const owner = await space(share.ownerId);
      const target = await owner.files.resolve(share.path).catch(() => null);
      const stat = target && await fs.stat(target).catch(() => null);
      if (!stat || !stat.isFile() && !stat.isDirectory()) continue;
      result.push({ path: `${SHARED}/${group.name}/${name}`, name, isDir: stat.isDirectory(), kind: stat.isDirectory() ? null : classify(name)[0], size: stat.size, mtime: Math.trunc(stat.mtimeMs), isHidden: false, isSymlink: false, readonly: share.permission === 'read' });
    }
    return result.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'zh-CN'));
  }

  /** 删除账号时关闭进程，并把数据目录整体移入回收目录，不永久删除。 */
  async function retire(user) {
    const pending = spaces.get(user.id);
    spaces.delete(user.id);
    (await pending?.catch(() => null))?.close();
    const source = path.join(base, 'users', user.id);
    const exists = await fs.stat(source).then(() => true, () => false);
    if (!exists) return;
    const trash = path.join(base, 'trash', 'users');
    await fs.mkdir(trash, { recursive: true });
    await fs.rename(source, path.join(trash, `${Date.now()}-${segment(user.username)}-${user.id}`));
  }

  async function closeAll() {
    clearInterval(idleTimer);
    for (const pending of spaces.values()) (await pending.catch(() => null))?.close();
  }

  return { space, admin, route, mapOut, listVirtual, retire, closeAll, historyAvailable };
}
