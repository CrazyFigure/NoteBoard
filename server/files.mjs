// 网页文件服务：对外统一使用 POSIX 虚拟路径，实际磁盘路径只在此层解析。
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import iconv from 'iconv-lite';
import { TextDecoder } from 'node:util';

/** 文本读取上限；避免多个大文件同时耗尽容器内存。 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const ROOT = '/workspace';

/** 将异常转换为带 HTTP 状态的业务错误。 */
export function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** 按扩展名返回与原生端一致的文档类型和编辑语言。 */
export function classify(name) {
  const ext = path.posix.extname(name).slice(1).toLowerCase();
  if (['md', 'markdown'].includes(ext)) return ['markdown', 'markdown'];
  if (['excalidraw', 'board', 'canvas'].includes(ext)) return ['board', 'plaintext'];
  if (['mindmap', 'xmind', 'mm'].includes(ext)) return ['mindmap', 'plaintext'];
  if (['drawio', 'dio'].includes(ext)) return ['drawio', 'plaintext'];
  if (['bitable', 'table'].includes(ext)) return ['bitable', 'plaintext'];
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'dwg', 'dxf', 'epub'].includes(ext)) return ['preview', 'plaintext'];
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'bmp', 'avif'].includes(ext)) return ['image', 'plaintext'];
  const language = { sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', mmd: 'mermaid', mermaid: 'mermaid', puml: 'plantuml', plantuml: 'plantuml', infographic: 'infographic', ig: 'infographic' }[ext] ?? 'plaintext';
  return ['code', language];
}

/** 创建工作区服务；拒绝穿越、反斜杠、符号链接及操作系统特有文件名。 */
export async function createFiles(dataDir) {
  const base = path.resolve(dataDir);
  await fs.mkdir(path.join(base, 'workspace'), { recursive: true });
  const diskRoot = await fs.realpath(path.join(base, 'workspace'));
  const stateRoot = path.join(base, 'state');
  await fs.mkdir(stateRoot, { recursive: true });

  /** 逐段检查路径，禁止经符号链接读写工作区之外的文件，也禁止根目录删除或改名。 */
  async function resolve(key, { allowRoot = true, createParents = false } = {}) {
    if (typeof key !== 'string' || !key.startsWith(`${ROOT}/`) && key !== ROOT || key.includes('\\') || key.includes('\0')) throw fail('路径必须位于 /workspace');
    const segments = key.slice(ROOT.length).split('/').filter(Boolean);
    if (segments.some((part) => part === '.' || part === '..' || Array.from(part).some((character) => character.charCodeAt(0) < 32) || /[<>:"|?*]/.test(part) || part.endsWith('.') || part.endsWith(' ') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) throw fail('文件名或路径不合法');
    if (!allowRoot && !segments.length) throw fail('不能修改工作区根目录');
    let current = diskRoot;
    for (let i = 0; i < segments.length; i += 1) {
      current = path.join(current, segments[i]);
      const stat = await fs.lstat(current).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) throw fail('网页端不允许访问符号链接', 403);
      if (i < segments.length - 1) {
        if (stat && !stat.isDirectory()) throw fail('父路径不是文件夹');
        if (!stat && createParents) await fs.mkdir(current);
        else if (!stat) throw fail('父目录不存在', 404);
      }
    }
    return current;
  }

  /** 对内容计算版本，写入时按浏览器读取的版本校验，阻止并发编辑静默覆盖。 */
  function revision(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

  /** 原子替换文件；临时文件位于同一目录，异常时清理残留。 */
  async function atomic(target, bytes) {
    const temporary = path.join(path.dirname(target), `.nb-write-${randomUUID()}`);
    try {
      // 写入完成后先同步文件，再原子替换，降低主机断电或容器中止时的数据丢失风险。
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  /** 限制单次读取大小；拒绝目录和特殊设备。 */
  async function readBytes(key) {
    const target = await resolve(key);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw fail('只能读取普通文件');
    if (stat.size > MAX_FILE_BYTES) throw fail('文件超过 50 MB 上限', 413);
    return { bytes: await fs.readFile(target), stat };
  }

  /** 保留 UTF-8 BOM / GBK 与原有换行风格，内容模型统一使用 LF。 */
  async function read(key) {
    const { bytes, stat } = await readBytes(key);
    // Office 和 PDF 返回空正文，查看器单独读取原始字节。
    if (classify(key)[0] === 'preview') return { key, displayName:path.posix.basename(key), dirPath:path.posix.dirname(key), kind:'preview', language:'plaintext', content:null, encoding:'utf8', eol:'lf', size:stat.size, mtime:Math.trunc(stat.mtimeMs), readonly:true, webRevision:revision(bytes) };
    let encoding = 'utf8';
    let content;
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
      encoding = 'utf8-bom';
      content = bytes.subarray(3).toString('utf8');
    } else {
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { encoding = 'gbk'; content = iconv.decode(bytes, 'gbk'); }
    }
    const [kind, language] = classify(key);
    return { key, displayName: path.posix.basename(key), dirPath: path.posix.dirname(key), kind, language, content: content.replace(/\r\n/g, '\n'), encoding, eol: content.includes('\r\n') ? 'crlf' : 'lf', size: stat.size, mtime: Math.trunc(stat.mtimeMs), readonly: !(stat.mode & 0o200), webRevision: revision(bytes) };
  }

  /** 有界读取目录并按文件夹优先排序；隐藏原子写临时文件和全部符号链接。 */
  async function list(key, showHidden = false) {
    const target = await resolve(key);
    const result = [];
    const directory = await fs.opendir(target);
    for await (const item of directory) {
      if (item.isSymbolicLink() || item.name.startsWith('.nb-write-') || !showHidden && item.name.startsWith('.')) continue;
      if (!item.isDirectory() && !item.isFile()) continue;
      if (result.length >= 10000) throw fail('单个文件夹最多显示 10000 项，请分目录整理', 413);
      const stat = await fs.stat(path.join(target, item.name));
      result.push({ path: `${key}/${item.name}`, name: item.name, isDir: item.isDirectory(), kind: item.isDirectory() ? null : classify(item.name)[0], size: stat.size, mtime: Math.trunc(stat.mtimeMs), isHidden: item.name.startsWith('.'), isSymlink: false });
    }
    return result.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'zh-CN'));
  }

  // 所有写操作排队执行，版本核对与落盘处于同一串行段；失败不阻塞后续请求。
  let mutation = Promise.resolve();
  function serialize(action) {
    const pending = mutation.then(action);
    mutation = pending.catch(() => {});
    return pending;
  }

  /** 创建或保存文件；已有文件必须提供读取版本，避免未授权覆盖和并发数据丢失。 */
  async function write(key, bytes, expectedRevision, exclusive = false) {
    if (bytes.length > MAX_FILE_BYTES) throw fail('文件超过 50 MB 上限', 413);
    return serialize(async () => {
      const target = await resolve(key, { allowRoot: false, createParents: true });
      const prior = await fs.stat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (prior && (!prior.isFile() || prior.size > MAX_FILE_BYTES)) throw fail('目标不是可编辑的普通文件或超过 50 MB', 413);
      const old = await fs.readFile(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (old && (exclusive || expectedRevision !== revision(old))) throw fail(exclusive ? '文件已存在' : '文件已被其他浏览器修改，请重新加载后保存', 409);
      if (!old && expectedRevision) throw fail('文件已被删除，请确认后另存为', 409);
      await atomic(target, bytes);
      const stat = await fs.stat(target);
      return { ok: true, size: stat.size, mtime: Math.trunc(stat.mtimeMs), error: null, webRevision: revision(bytes) };
    });
  }

  /** 编码转换先检查可逆性，GBK 无法表示的字符应报错而不能写成问号。 */
  function encode(content, encoding, eol) {
    if (typeof content !== 'string' || !['utf8', 'utf8-bom', 'gbk'].includes(encoding) || !['lf', 'crlf'].includes(eol)) throw fail('文档格式参数不合法');
    const normalized = content.replace(/\r\n/g, '\n').replace(/\n/g, eol === 'crlf' ? '\r\n' : '\n');
    const bytes = iconv.encode(normalized, encoding === 'gbk' ? 'gbk' : 'utf8');
    if (encoding === 'gbk' && iconv.decode(bytes, 'gbk') !== normalized) throw fail('部分字符无法使用 GBK 保存，请切换为 UTF-8');
    return encoding === 'utf8-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;
  }

  /** 状态文件名称仅接受内部固定键；损坏文件报告错误，避免用默认值覆盖原数据。 */
  async function loadState(name, fallback) {
    try { return JSON.parse(await fs.readFile(path.join(stateRoot, `${name}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  async function saveState(name, value) {
    return serialize(() => atomic(path.join(stateRoot, `${name}.json`), Buffer.from(JSON.stringify(value))));
  }

  /** 删除移入服务端回收目录，不调用 Linux 桌面回收站，也不递归永久删除用户文件。 */
  async function trash(key) {
    return serialize(async () => {
      const target = await resolve(key, { allowRoot: false });
      const trashRoot = path.join(base, 'trash');
      await fs.mkdir(trashRoot, { recursive: true });
      await fs.rename(target, path.join(trashRoot, `${Date.now()}-${randomUUID()}-${path.basename(target)}`));
    });
  }

  return { resolve, read, readBytes, list, write, encode, loadState, saveState, trash, serialize, revision };
}
