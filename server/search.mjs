// 网页全局搜索：管理员开关整个实例的索引，一份索引覆盖所有用户的工作区；
// 查询时按当前用户的文件访问权限（本人工作区 + 共享给他的内容）限定范围，结果路径改写为他看到的虚拟路径。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './files.mjs';
import { workerBinary } from './sync.mjs';
import { ADMIN_ID } from './accounts.mjs';

const QUERY_TIMEOUT_MS = 30 * 1000;

/** 启动搜索工作进程（同一程序的搜索模式），按 id 配对 JSON 行响应。 */
function startWorker(dataDir, events) {
  const worker = spawn(workerBinary(), [], { env: { ...process.env, NOTEBOARD_DATA_DIR: dataDir, NOTEBOARD_WORKER: 'search' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  // 与同步工作进程一致：不单独维持 Node 事件循环，标准输入关闭时工作进程随之退出
  worker.unref();
  for (const stream of [worker.stdin, worker.stdout, worker.stderr]) stream?.unref?.();
  const pending = new Map();
  let counter = 0;
  let stopped = false;
  createInterface({ input: worker.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.event) { events.emit('event', { event: message.event, payload: null }); return; }
      const task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      if (message.error) task.reject(fail(message.error)); else task.resolve(message.result);
    } catch { console.error('搜索工作进程返回了无效响应'); }
  });
  worker.stderr.resume();
  const shutdown = () => {
    stopped = true;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(fail('搜索服务已停止', 503)); }
    pending.clear();
  };
  worker.on('error', shutdown); worker.on('exit', shutdown);
  function call(command, args) {
    if (stopped) return Promise.reject(fail('搜索服务不可用', 503));
    if (pending.size >= 200) return Promise.reject(fail('搜索请求过多，请稍后重试', 429));
    const id = ++counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(fail('搜索超时', 504)); }, QUERY_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      worker.stdin.write(JSON.stringify({ id, command, args }) + '\n', (error) => {
        if (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  }
  return { call, alive: () => !stopped, close: () => { worker.stdin.end(); worker.kill(); shutdown(); } };
}

/** 把服务器真实路径改写为访问者看到的路径；不在任何可访问位置中的返回 null。 */
export function toVirtual(scopes, physical) {
  let best = null;
  for (const scope of scopes) {
    if ((physical === scope.physical || physical.startsWith(scope.physical + path.sep)) && (!best || scope.physical.length > best.physical.length)) best = scope;
  }
  if (!best) return null;
  return best.virtual + physical.slice(best.physical.length).split(path.sep).join('/');
}

/** 结果逐条改写路径；范围外的条目（理论上不会出现）直接丢弃，防止泄露。 */
function mapHits(scopes, hits) {
  const result = [];
  for (const hit of hits) {
    const virtual = toVirtual(scopes, hit.path);
    if (!virtual) continue;
    result.push({ ...hit, path: virtual, dir: path.posix.dirname(virtual) });
  }
  return result;
}

export async function createSearch({ dataDir, spaces, accounts }) {
  const base = path.resolve(dataDir);
  const available = await fs.access(workerBinary()).then(() => true, () => false);
  const events = new EventEmitter();
  events.setMaxListeners(500);
  const adminFiles = spaces.admin.files;
  let enabled = !!(await adminFiles.loadState('search', null))?.enabled;
  let worker = null;

  /** 索引位置：管理员与每个账号的工作区（不存在时先创建，账号首次使用前写入的文件也能被索引）。 */
  async function roots() {
    const dirs = [path.join(base, 'workspace'), ...(accounts?.listUsers() ?? []).filter((user) => user.id !== ADMIN_ID).map((user) => path.join(base, 'users', user.id, 'workspace'))];
    const result = [];
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
      result.push(await fs.realpath(dir));
    }
    return result;
  }

  /** 按当前开关启动或停止索引；关闭时工作进程删除快照后退出，不在磁盘上保留文件清单。 */
  async function apply() {
    if (!available) return;
    if (enabled) {
      if (!worker?.alive()) worker = startWorker(base, events);
      await worker.call('search_configure', { enabled: true, roots: await roots() });
    } else if (worker?.alive()) {
      await worker.call('search_configure', { enabled: false, roots: [] }).catch(() => {});
      worker.close();
      worker = null;
    }
  }

  async function setEnabled(value) {
    if (!available) throw fail('当前部署未包含搜索服务', 503);
    enabled = value === true;
    await adminFiles.saveState('search', { enabled });
    await apply();
    return enabled;
  }

  /** 账号增删后更新索引位置。 */
  async function refreshRoots() {
    if (enabled) await apply().catch((error) => console.error('更新搜索索引位置失败:', error.message));
  }

  /** 查询：kind 为 names / content；被同一浏览器的新查询取代时返回 null。 */
  async function query(user, kind, args, client) {
    const empty = kind === 'names' ? { hits: [], total: 0 } : { hits: [], truncated: false };
    if (!enabled || !available) return empty;
    if (!worker?.alive()) await apply();
    const text = String(args.query ?? '');
    if (!text.trim() || text.length > 10000) return empty;
    const scopes = await spaces.searchScopes(user);
    const result = await worker.call(kind === 'names' ? 'search_names' : 'search_content', {
      query: text,
      seq: Number(args.seq) || 0,
      limit: Number(args.limit) || undefined,
      // 取消序号按账号 + 浏览器区分，不同用户的查询互不影响
      client: `${user.id}:${client}`,
      scopes: scopes.map((scope) => scope.physical),
    });
    if (!result) return null;
    return { ...result, hits: mapHits(scopes, result.hits ?? []) };
  }

  await apply().catch((error) => console.error('启动全局搜索失败:', error.message));
  return {
    available,
    enabled: () => enabled,
    setEnabled,
    refreshRoots,
    query,
    events,
    close: () => { worker?.close(); worker = null; },
  };
}
