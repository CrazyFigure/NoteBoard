// 官方插件持久化：固定下载源、摘要校验、版本目录和原子激活；网页部署按实例共享。
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from './files.mjs';

const IDS = new Set(['word', 'excel', 'powerpoint', 'pdf', 'cad', 'epub', 'workbench']);
const BASE = 'https://github.com/CrazyFigure/NoteBoard/releases/download/plugins/';
const MAX_BYTES = 32 * 1024 * 1024;
const semver = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;

/** 三段版本按数值比较，避免 1.10.0 被当作小于 1.9.0。 */
export function compareVersions(a, b) {
  if (!semver.test(a) || !semver.test(b)) throw fail('插件版本号无效');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

/** 安装前校验宿主协议和正文摘要；包格式不包含可解压路径。 */
export function validatePackage(pkg, id, appVersion) {
  const m = pkg?.manifest;
  if (!IDS.has(id) || m?.id !== id || !semver.test(m.version) || m.apiVersion !== 1 || compareVersions(m.minAppVersion, appVersion) > 0) throw fail('插件与当前软件版本不兼容');
  if (typeof pkg.code !== 'string' || !pkg.code || Buffer.byteLength(pkg.code) > MAX_BYTES || createHash('sha256').update(pkg.code).digest('hex') !== m.codeSha256) throw fail('插件完整性校验失败');
  return pkg;
}

/** 下载有大小与超时硬上限，错误响应不能写入已安装版本。 */
async function download(url, limit) {
  if (!url.startsWith(BASE) || url.slice(BASE.length).includes('/')) throw fail('插件下载来源无效');
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (response.status === 404) throw fail('官方插件尚未发布，请稍后检查更新', 404);
  if (!response.ok || Number(response.headers.get('content-length')) > limit) throw fail('插件下载失败或文件过大');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw fail('插件文件超过大小上限');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 单实例串行变更；激活失败时旧版本与状态保持可用。 */
export async function createPlugins(dataDir, appVersion, { downloadBytes = download } = {}) {
  const root = path.join(dataDir, 'plugins');
  await fs.mkdir(root, { recursive: true });
  let queue = Promise.resolve();
  const statePath = path.join(root, 'state.json');
  async function state() {
    try { return JSON.parse(await fs.readFile(statePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  function valid(id) { if (!IDS.has(id)) throw fail('未知官方插件'); }
  function packagePath(id, version) {
    valid(id); if (!semver.test(version)) throw fail('插件版本号无效');
    return path.join(root, `${id}-${version}.nbplugin`);
  }
  async function atomic(target, bytes) {
    const temp = path.join(root, `.pending-${randomUUID()}`);
    try {
      await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, target);
    } finally { await fs.rm(temp, { force: true }); }
  }
  async function read(id, version) {
    return validatePackage(JSON.parse(await fs.readFile(packagePath(id, version), 'utf8')), id, appVersion);
  }
  async function catalog() {
    // catalog.json 留给旧版本；新目录可能包含本版本未知的插件，忽略而不是整体拒绝。
    const c = JSON.parse((await downloadBytes(`${BASE}catalog-v2.json`, 1024 * 1024)).toString('utf8'));
    if (c.schemaVersion !== 1 || !Array.isArray(c.plugins) || c.plugins.length > 64) throw fail('插件目录格式无效');
    return { ...c, plugins: c.plugins.filter((p) => IDS.has(p?.id)) };
  }
  async function command(name, args) {
    if (name === 'plugin_catalog') return catalog();
    if (name === 'plugin_list') {
      const s = await state(); const result = [];
      for (const id of IDS) if (s[id]) {
        try {
          if (s[id].manifest) {
            const info = await fs.stat(packagePath(id, s[id].version));
            if (!info.isFile() || info.size !== s[id].size) throw fail('插件文件缺失或大小已改变');
            result.push({manifest:s[id].manifest,enabled:s[id].enabled});
            continue;
          }
          const pkg = await read(id, s[id].version);
          result.push({ manifest: pkg.manifest, enabled: s[id].enabled });
        } catch(error) {
          result.push({ manifest:{id,version:s[id].version,licenses:'',changelog:''},enabled:false,invalid:true,error:error.message });
        }
      }
      return result;
    }
    const id = args.id; valid(id); const s = await state();
    if (name === 'plugin_load') {
      if (!s[id]?.enabled) throw fail('请先安装并启用插件');
      return read(id, s[id].version);
    }
    if (name === 'plugin_install') {
      const entry = (await catalog()).plugins.find((p) => p.id === id);
      if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw fail('插件暂不可下载');
      if (s[id] && compareVersions(entry.version, s[id].version) < 0) return null;
      const bytes = await downloadBytes(entry.url, MAX_BYTES);
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw fail('插件下载校验失败');
      const pkg = validatePackage(JSON.parse(bytes.toString('utf8')), id, appVersion);
      if (pkg.manifest.version !== entry.version) throw fail('插件版本与目录不一致');
      await atomic(packagePath(id, entry.version), bytes);
      // 首次安装保持未启用；升级保留用户的勾选状态。
      s[id] = { version: entry.version, enabled: s[id]?.enabled === true, manifest:pkg.manifest, size:bytes.length };
    } else if (name === 'plugin_toggle') {
      if (!s[id]) throw fail('插件尚未安装');
      s[id].enabled = args.enabled === true;
    } else if (name === 'plugin_remove') {
      // 只删除插件程序，工作台布局和用户文件始终保留。
      delete s[id];
      await atomic(statePath, JSON.stringify(s));
      for (const name of await fs.readdir(root)) if (new RegExp(`^${id}-\\d+\\.\\d+\\.\\d+\\.nbplugin$`).test(name)) await fs.unlink(path.join(root, name));
      return null;
    } else throw fail('未知插件命令');
    await atomic(statePath, JSON.stringify(s));
    // 状态切换成功后清理同一插件旧版，最多保留当前包。
    if (name === 'plugin_install') for (const filename of await fs.readdir(root)) {
      const match = filename.match(new RegExp(`^${id}-(\\d+\\.\\d+\\.\\d+)\\.nbplugin$`));
      if (match && match[1] !== s[id].version) await fs.unlink(path.join(root, filename));
    }
    return null;
  }
  return (name, args) => {
    // 读取也与卸载串行，防止刚读取版本指针文件就被删除。
    const task = queue.then(() => command(name, args));
    queue = task.catch(() => {}); return task;
  };
}
