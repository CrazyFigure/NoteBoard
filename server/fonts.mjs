// 网页字体包沿用原生端固定版本、名称与 SHA；只在用户点击下载后访问官方资源。
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { fail } from './files.mjs';

const specs = JSON.parse(await fs.readFile(new URL('./font-files.json', import.meta.url), 'utf8'));
const DOWNLOAD_URL = 'https://github.com/CrazyFigure/NoteBoard/releases/download/fonts-v1.0.0/NoteBoard-fontpack-core-v1.0.0.zip';
const unzip = promisify(inflateRaw);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** ZIP 只读取固定字体名；解压上限来自受信清单，不使用归档路径写盘。 */
export async function extractFontFiles(bytes) {
  const found = new Map();
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < Math.max(0, bytes.length - 65557)) throw fail('字体压缩包格式无效');
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  if (count > 100) throw fail('字体压缩包条目过多');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw fail('字体压缩包目录无效');
    const size = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24), method = bytes.readUInt16LE(offset + 10);
    const nameSize = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
    const spec = specs.find((spec) => name === `fonts/${spec.name}`);
    if (spec) {
      if (found.has(spec.name) || expanded !== spec.size || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw fail('字体文件无效');
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (start + size > bytes.length || ![0, 8].includes(method)) throw fail('字体压缩数据无效');
      // inflateRaw 由 libuv 工作线程执行，大字体解压不阻塞 Node 主循环。
      const data = method === 0 ? bytes.subarray(start, start + size) : await unzip(bytes.subarray(start, start + size), { maxOutputLength: spec.size });
      if (data.length !== spec.size || hash(data) !== spec.sha256) throw fail('字体完整性校验失败');
      found.set(spec.name, data);
    }
    offset += 46 + nameSize + extra + comment;
  }
  if (found.size !== specs.length) throw fail('字体压缩包缺少文件');
  return found;
}

/** 字体目录与插件目录同级；实例共享，返回给浏览器的地址不包含服务器真实路径。 */
export async function createFonts(dataDir, { download = fetch } = {}) {
  const parent = path.join(dataDir, 'font-packs', 'core'), root = path.join(parent, '1.0.0');
  let cachedIdentity = '', cachedReady = false, installation;
  const base = { id:'core', version:'1.0.0', installedSizeBytes:36441444, downloadSizeBytes:19 * 1024 * 1024, downloadUrl:DOWNLOAD_URL };
  async function status() {
    const stats = await Promise.all(specs.map((spec) => fs.stat(path.join(root, 'fonts', spec.name)).catch(() => null)));
    const identity = stats.map((s) => s ? `${s.size}:${s.mtimeMs}` : '-').join('|');
    if (identity !== cachedIdentity) {
      cachedReady = false;
      if (stats.every((s, i) => s?.size === specs[i].size)) {
        const checked = await Promise.all(specs.map(async (spec) => hash(await fs.readFile(path.join(root, 'fonts', spec.name))) === spec.sha256));
        cachedReady = checked.every(Boolean);
      }
      cachedIdentity = identity;
    }
    const faces = cachedReady ? specs.map((s) => ({family:s.name.startsWith('Maple') ? 'Maple Mono Normal NF CN' : 'JetBrains Mono',weight:s.name.includes('Bold') ? '700' : '400',style:s.name.includes('Italic') ? 'italic' : 'normal',path:`/api/font-pack/${s.name}`})) : [];
    return {...base,state:cachedReady ? 'ready' : stats.some(Boolean) ? 'invalid' : 'missing',faces};
  }
  async function install() {
    const response = await download(DOWNLOAD_URL, { signal:AbortSignal.timeout(600000) });
    if (!response.ok || Number(response.headers.get('content-length')) > 30 * 1024 * 1024) throw fail('字体下载失败');
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 30 * 1024 * 1024) throw fail('字体文件过大'); chunks.push(chunk); }
    const files = await extractFontFiles(Buffer.concat(chunks));
    await fs.mkdir(parent, { recursive:true });
    const staging = path.join(parent, `.install-${randomUUID()}`), backup = path.join(parent, `.backup-${randomUUID()}`);
    let backed = false;
    try {
      await fs.mkdir(path.join(staging, 'fonts'), { recursive:true });
      for (const [name, data] of files) await fs.writeFile(path.join(staging, 'fonts', name), data);
      try { await fs.rename(root, backup); backed = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      try { await fs.rename(staging, root); } catch (e) { if (backed) await fs.rename(backup, root); throw e; }
      // 成功激活后清理旧字体副本，避免修复后重复占用磁盘。
      if (backed) await fs.rm(backup, { recursive:true, force:true });
      cachedIdentity = ''; return status();
    } finally { await fs.rm(staging, { recursive:true, force:true }); }
  }
  return {
    status,
    download:() => installation ?? (installation = install().finally(() => { installation = undefined; })),
    // 卸载只删除本实例下载的字体目录；下载进行中拒绝，避免删掉刚激活的文件。
    remove:async () => {
      if (installation) throw fail('字体正在下载，请稍后再卸载');
      await fs.rm(root, { recursive:true, force:true });
      cachedIdentity = ''; return status();
    },
    asset:async (name) => {
      if (!specs.some((s) => s.name === name) || !(await status()).faces.length) throw fail('字体不存在', 404);
      return fs.readFile(path.join(root, 'fonts', name));
    },
  };
}
