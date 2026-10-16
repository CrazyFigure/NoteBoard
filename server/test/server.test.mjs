// 使用真实临时目录和 HTTP 请求验证网页运行边界，覆盖 Linux 路径和部署认证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createFiles } from '../files.mjs';
import { createWebServer } from '../index.mjs';

/** 每个测试使用独立目录；退出时只清理本次创建的临时文件。 */
async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'noteboard-web-'));
  const staticDir = path.join(temp, 'static');
  await fs.mkdir(staticDir);
  await fs.writeFile(path.join(staticDir, 'index.html'), '<html><script>window.test=1;</script>NoteBoard</html>');
  const dataDir = path.join(temp, 'data');
  const server = await createWebServer({ dataDir, staticDir, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); });
  async function call(command, args = {}, extra = {}) {
    return fetch(`${url}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NoteBoard-Request': '1', 'X-NoteBoard-Client': 'test-client-1234', ...extra }, body: JSON.stringify({ command, args }) });
  }
  return { temp, dataDir, url, call };
}

test('共享笔记、收藏和设置在服务重启后仍可读取', async (t) => {
  const { dataDir, call } = await fixture(t);
  const created = await call('create_file', { dir: '/workspace', name: '中文 A.md', template: 'markdown' });
  assert.equal(created.status, 200);
  const payload = (await created.json()).result;
  const write = await call('write_document', { path: payload.key, content: '# 笔记\n中文', encoding: 'utf8-bom', eol: 'crlf', expectedRevision: payload.webRevision });
  assert.equal(write.status, 200);
  await call('save_favorites', { favorites: { schemaVersion: 1, roots: [{ id: 'test', name: '收藏' }] } });
  await call('save_settings', { settings: { file: { stagingDirectory: '/workspace/.staging' } } });
  const reopened = await createFiles(dataDir);
  assert.equal((await reopened.read(payload.key)).content, '# 笔记\n中文');
  assert.equal((await reopened.read(payload.key)).encoding, 'utf8-bom');
  assert.equal((await reopened.loadState('favorites', null)).roots[0].name, '收藏');
  assert.equal((await reopened.readBytes(payload.key)).bytes.toString('utf8'), '\ufeff# 笔记\r\n中文');
});

test('过期写入及同名上传被拒绝，原内容不被覆盖', async (t) => {
  const { call } = await fixture(t);
  const first = await call('create_file', { dir: '/workspace', name: '并发.md', template: 'markdown' });
  const payload = (await first.json()).result;
  const args = { path: payload.key, content: '第一次保存', encoding: 'utf8', eol: 'lf', expectedRevision: payload.webRevision };
  assert.equal((await call('write_document', args)).status, 200);
  assert.equal((await call('write_document', { ...args, content: '过期内容' })).status, 409);
  assert.equal((await call('create_file', { dir: '/workspace', name: '并发.md' })).status, 409);
  assert.equal((await (await call('read_document', { path: payload.key })).json()).result.content, '第一次保存');
});

test('拒绝路径穿越、Windows 路径、根目录修改和符号链接', async (t) => {
  const { call, dataDir, temp } = await fixture(t);
  for (const key of ['/etc/passwd', '/workspace/../secret', '/workspace\\secret', '/workspace/NUL.txt']) {
    assert.equal((await call('read_document', { path: key })).status, 400, key);
  }
  assert.equal((await call('move_to_trash', { path: '/workspace' })).status, 400);
  const outside = path.join(temp, 'outside');
  await fs.mkdir(outside);
  // Windows 默认无法创建符号链接，目录联接仍能覆盖相同的越界检查。
  await fs.symlink(outside, path.join(dataDir, 'workspace', 'escape'), 'junction');
  assert.equal((await call('read_dir', { path: '/workspace/escape' })).status, 403);
  assert.equal((await call('create_file', { dir: '/workspace', name: '../escape.md' })).status, 400);
});

test('可选认证覆盖页面、API、附件；健康检查独立；拒绝跨站写入', async (t) => {
  const { url, call } = await fixture(t, { username: 'admin', password: '测试密码' });
  const auth = `Basic ${Buffer.from('admin:测试密码').toString('base64')}`;
  for (const route of ['/', '/api/file?path=/workspace/a.md']) assert.equal((await fetch(url + route)).status, 401);
  assert.equal((await call('read_dir', { path: '/workspace' })).status, 401);
  assert.equal((await fetch(url + '/api/health')).status, 200);
  const page = await fetch(url + '/', { headers: { Authorization: auth } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /sha256-/);
  assert.equal((await call('read_dir', { path: '/workspace' }, { Authorization: auth })).status, 200);
  assert.equal((await call('read_dir', { path: '/workspace' }, { Authorization: auth, Origin: 'https://attacker.example' })).status, 403);
});

test('暂存复用路径，删除进入回收目录，GBK 保存不丢字', async (t) => {
  const { call, dataDir } = await fixture(t);
  const doc = { key: 'untitled:test', displayName: '未保存.md', content: '中文', encoding: 'gbk', eol: 'lf' };
  const first = (await (await call('stash_documents', { documents: [doc] })).json()).result[0];
  const second = (await (await call('stash_documents', { documents: [{ ...doc, content: '更新内容', targetPath: first.targetPath }] })).json()).result[0];
  assert.equal(first.targetPath, second.targetPath);
  assert.equal((await (await call('read_document', { path: second.targetPath })).json()).result.content, '更新内容');
  assert.equal((await call('stash_documents', { documents: [{ ...doc, content: '😀' }] })).status, 400);
  assert.equal((await call('move_to_trash', { path: second.targetPath })).status, 200);
  assert.equal((await fs.readdir(path.join(dataDir, 'trash'))).length, 1);
});

test('Linux 文件名大小写分别存储，附件脚本禁止同源执行', async (t) => {
  const { call, url } = await fixture(t);
  const files = ['A.md', 'a.md'];
  // 大小写敏感性以实际文件系统为准，Linux CI 必须覆盖两个不同文件。
  if (process.platform !== 'win32') {
    for (const name of files) assert.equal((await call('create_file', { dir: '/workspace', name })).status, 200);
    assert.equal((await (await call('read_dir', { path: '/workspace' })).json()).result.length, 2);
  }
  assert.equal((await fetch(`${url}/api/upload?path=/workspace/test.svg`, { method: 'POST', headers: { 'X-NoteBoard-Request': '1' }, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' })).status, 200);
  const response = await fetch(`${url}/api/file?path=/workspace/test.svg`);
  assert.match(response.headers.get('content-security-policy'), /^sandbox;/);
});
