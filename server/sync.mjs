// 网页同步宿主：启动现有 Rust 引擎，并将其事件透传为经过认证的 SSE。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './files.mjs';

/** 工作进程只通过管道接收受控命令，不监听额外端口或暴露磁盘路径。 */
export async function startSyncWorker(files, dataDir) {
  const binary = process.env.NOTEBOARD_SYNC_BINARY || fileURLToPath(new URL('./noteboard-sync-server', import.meta.url));
  try { await fs.access(binary); } catch { return null; }
  const events = new EventEmitter();
  events.setMaxListeners(200);
  const worker = spawn(binary, [], { env: { ...process.env, NOTEBOARD_DATA_DIR: path.resolve(dataDir) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let counter = 0;
  let stopped = false;
  const workspace = await files.resolve('/workspace');
  const backups = path.resolve(dataDir, 'native/backups');
  await fs.mkdir(backups, { recursive: true });

  /** 仅替换作为前缀的受控服务器路径；凭证、远端路径等普通字符串保持原值。 */
  function virtualize(value) {
    if (Array.isArray(value)) return value.map(virtualize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, virtualize(item)]));
    if (typeof value === 'string') {
      if (value === workspace || value.startsWith(workspace + path.sep)) return '/workspace' + value.slice(workspace.length).split(path.sep).join('/');
      if (value === backups) return '/backups';
    }
    return value;
  }

  /** 每条命令设定容量和超时，进程退出时全部失败，禁止产生永远等待的保存请求。 */
  function call(command, args = {}) {
    if (stopped) return Promise.reject(fail('同步工作进程不可用', 503));
    if (pending.size >= 100) return Promise.reject(fail('同步请求过多，请稍后重试', 429));
    const id = ++counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(fail('同步操作超时，请检查服务器任务状态', 504)); }, 10 * 60 * 1000);
      pending.set(id, { resolve, reject, timer });
      worker.stdin.write(JSON.stringify({ id, command, args }) + '\n', (error) => {
        if (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  }

  const lines = createInterface({ input: worker.stdout });
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.event) { events.emit('event', { event: message.event, payload: virtualize(message.payload) }); return; }
      const task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      if (message.error) task.reject(fail(message.error)); else task.resolve(virtualize(message.result));
    } catch { console.error('同步工作进程返回了无效响应'); }
  });
  // 不打印原始 stderr（远端错误可能含地址或凭证），只记录进程退出状态。
  worker.stderr.resume();
  function shutdown() {
    stopped = true;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(fail('同步工作进程已停止', 503)); }
    pending.clear();
  }
  worker.on('error', shutdown); worker.on('exit', shutdown);

  /** 将前端配置里的虚拟路径转换为真实路径，双重校验阻止通过同步/备份绕过文件边界。 */
  async function command(name, rawArgs) {
    const args = structuredClone(rawArgs);
    if (name === 'sync_save_config') {
      const config = args.config;
      config.sync.rootDir = config.sync.rootDir ? await files.resolve(config.sync.rootDir) : '';
      config.backup.localDir = !config.backup.localDir || config.backup.localDir === '/backups' ? backups : await files.resolve(config.backup.localDir);
    }
    if (name === 'backup_restore' && args.targetDir) args.targetDir = await files.resolve(args.targetDir);
    return call(name, args);
  }

  /** 文件写入与改名复用原生同步钩子，保持文件身份、删除历史和保存触发时机。 */
  async function hook(name, args) {
    const mapped = {};
    for (const [key, value] of Object.entries(args)) mapped[key] = await files.resolve(value);
    return call(name, mapped);
  }
  return { command, hook, events, close: () => { worker.stdin.end(); worker.kill(); shutdown(); } };
}
