// 把一个 GitHub Release 同步到腾讯云 CNB 镜像仓库：创建或更新同名 Release，并上传缺失或内容变化的附件。
// 用法：node scripts/sync-cnb-release.mjs --release-json <gh release view 输出> --assets-dir <附件目录>
// 环境变量：CNB_TOKEN（需 repo-code / repo-release 读写），CNB_REPOSITORY（默认 crazy-figure/NoteBoard）。
// 可重复执行：CNB 上 sha256 一致的附件直接跳过，因此多个构建任务可各自在上传后调用。
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_BASE = (process.env.CNB_API_BASE || 'https://api.cnb.cool').replace(/\/+$/, '');
const REPOSITORY = process.env.CNB_REPOSITORY || 'crazy-figure/NoteBoard';
const MAX_ATTEMPTS = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { releaseJson: '', assetsDir: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--release-json') args.releaseJson = argv[++i];
    else if (argv[i] === '--assets-dir') args.assetsDir = argv[++i];
    else throw new Error(`未知参数：${argv[i]}`);
  }
  if (!args.releaseJson || !args.assetsDir) throw new Error('用法：sync-cnb-release.mjs --release-json <file> --assets-dir <dir>');
  if (!process.env.CNB_TOKEN) throw new Error('缺少 CNB_TOKEN');
  return args;
}

export class CnbClient {
  constructor({ apiBase = API_BASE, repository = REPOSITORY, token = process.env.CNB_TOKEN } = {}) {
    this.apiBase = apiBase;
    this.repository = repository;
    this.token = token;
  }

  headers(json = false) {
    return {
      Accept: 'application/vnd.cnb.api+json',
      Authorization: `Bearer ${this.token}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async request(method, apiPath, body = null, allow404 = false) {
    const response = await fetch(`${this.apiBase}/${this.repository}/-${apiPath}`, {
      method,
      headers: this.headers(body !== null),
      body: body === null ? undefined : JSON.stringify(body),
    });
    if (allow404 && response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) throw new Error(`CNB ${method} ${apiPath} 失败 ${response.status}：${text}`);
    // CNB 更新元数据时可能返回 200 空正文
    return text.trim() ? JSON.parse(text) : null;
  }

  getRelease(tag) {
    return this.request('GET', `/releases/tags/${encodeURIComponent(tag)}`, null, true);
  }

  /** 创建或更新 Release 元数据；镜像推送的 tag 可能稍晚到达，创建失败时等待后重试。 */
  async ensureRelease(release) {
    const meta = {
      name: release.name || release.tagName,
      body: release.body || '',
      prerelease: Boolean(release.isPrerelease),
      // 正式版本标记为最新，与 GitHub 保持一致；插件、字体等资源 Release 不参与
      ...(release.makeLatest ? { make_latest: 'true' } : {}),
    };
    for (let attempt = 1; ; attempt++) {
      const existing = await this.getRelease(release.tagName);
      if (existing) {
        await this.request('PATCH', `/releases/${existing.id}`, meta);
        return existing;
      }
      try {
        await this.request('POST', '/releases', { tag_name: release.tagName, ...meta });
        return await this.getRelease(release.tagName);
      } catch (error) {
        if (attempt >= 10) throw error;
        console.warn(`创建 CNB Release 失败，可能 tag 尚未镜像，30 秒后重试：${error.message}`);
        await sleep(30000);
      }
    }
  }

  /** 先申请上传地址，再 PUT 对象存储，最后确认，与 CNB OpenAPI 的附件上传流程一致。 */
  async uploadAsset(releaseId, filePath, overwrite) {
    const size = statSync(filePath).size;
    const target = await this.request('POST', `/releases/${releaseId}/asset-upload-url`, {
      asset_name: path.basename(filePath),
      size,
      overwrite,
    });
    const upload = await fetch(target.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      body: createReadStream(filePath),
      duplex: 'half',
    });
    if (!upload.ok) throw new Error(`CNB 对象上传失败 ${upload.status}：${await upload.text()}`);
    const verify = await fetch(decodeURIComponent(target.verify_url), { method: 'POST', headers: this.headers() });
    if (!verify.ok) throw new Error(`CNB 上传确认失败 ${verify.status}：${await verify.text()}`);
  }
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** 对比本地文件与 CNB 已有附件：哈希（或缺少哈希时的大小）一致才视为相同。 */
export function assetUpToDate(remote, local) {
  if (!remote) return false;
  if (remote.hash_algo === 'sha256' && remote.hash_value) return remote.hash_value === local.sha256;
  return Number(remote.size) === local.size;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const github = JSON.parse(readFileSync(args.releaseJson, 'utf8'));
  if (github.isDraft) throw new Error('草稿 Release 不同步');
  const tagName = github.tagName;
  const client = new CnbClient();
  const release = await client.ensureRelease({ ...github, makeLatest: /^v\d+\.\d+\.\d+$/.test(tagName) && !github.isPrerelease });
  const remoteAssets = new Map((release.assets || []).map((asset) => [asset.name, asset]));

  const files = readdirSync(args.assetsDir).map((name) => path.join(args.assetsDir, name)).filter((file) => statSync(file).isFile());
  for (const file of files) {
    const name = path.basename(file);
    const local = { size: statSync(file).size, sha256: await sha256(file) };
    const remote = remoteAssets.get(name);
    if (assetUpToDate(remote, local)) {
      console.log(`跳过未变化附件：${name}`);
      continue;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        console.log(`上传 ${name}（${(local.size / 1048576).toFixed(1)} MB，第 ${attempt} 次）`);
        await client.uploadAsset(release.id, file, Boolean(remote));
        break;
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw error;
        const delay = 2 ** (attempt - 1) * 5000;
        console.warn(`${name} 上传失败，${delay / 1000} 秒后重试：${error.message}`);
        await sleep(delay);
      }
    }
  }
  console.log(`CNB Release ${tagName} 同步完成：https://cnb.cool/${REPOSITORY}/-/releases/tag/${tagName}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
