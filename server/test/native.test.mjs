// 使用两个真实网页服务与同一 WebDAV 测试端验证跨实例协议，而非仅测试内存模拟。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebServer } from '../index.mjs';

test('两个网页实例通过现有 WebDAV 协议双向同步，并能备份和恢复', { skip: !process.env.NOTEBOARD_SYNC_BINARY }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'noteboard-sync-http-'));
  const remote = new Map();
  // WebDAV 测试服务保留真实字节并支持引擎使用的目录、锁和清单操作。
  const dav = http.createServer(async (req, res) => {
    // 模拟 Cloudflare Access 网关：所有方法都必须携带两项 Service Token 请求头。
    if (req.headers['cf-access-client-id'] !== 'test-service-id' || req.headers['cf-access-client-secret'] !== 'test-gateway-secret') {
      return res.writeHead(403).end();
    }
    const key = decodeURIComponent(req.url);
    if (req.method === 'MKCOL') return res.writeHead(201).end();
    if (req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      remote.set(key, Buffer.concat(chunks)); return res.writeHead(201).end();
    }
    if (req.method === 'DELETE') { remote.delete(key); return res.writeHead(204).end(); }
    if (req.method === 'PROPFIND') return res.writeHead(207, { 'Content-Type': 'application/xml' }).end('<d:multistatus xmlns:d="DAV:"/>');
    if (req.method === 'GET' && remote.has(key)) return res.writeHead(200).end(remote.get(key));
    res.writeHead(404).end();
  });
  await new Promise((resolve) => dav.listen(0, '127.0.0.1', resolve));
  const servers = [];
  t.after(async () => {
    for (const server of servers) { server.stopNoteboard(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    dav.closeAllConnections(); await new Promise((resolve) => dav.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  });

  /** 每个服务对应一台设备，必须拥有独立 deviceId、状态基线与工作区。 */
  async function device(name) {
    const server = await createWebServer({ dataDir: path.join(temp, name), username: 'admin', password: 'password' });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    // 管理员使用部署账号登录，后续请求携带会话 Cookie。
    const login = await fetch(`http://127.0.0.1:${server.address().port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NoteBoard-Request': '1' }, body: JSON.stringify({ username: 'admin', password: 'password' }) });
    assert.equal(login.status, 200);
    const session = login.headers.get('set-cookie').split(';')[0];
    async function call(command, args = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NoteBoard-Request': '1', 'X-NoteBoard-Client': `browser-${name}-1234`, Cookie: session }, body: JSON.stringify({ command, args }) });
      const result = await response.json();
      assert.equal(response.status, 200, `${command}: ${JSON.stringify(result)}`);
      return result.result;
    }
    const capabilities = await call('web_capabilities');
    assert.equal(capabilities.syncAvailable, true);
    const config = await call('sync_get_config');
    config.sync.enabled = true; config.sync.rootDir = '/workspace'; config.sync.deviceName = name;
    config.sync.intervalEnabled = false; config.sync.syncOnStartup = false; config.sync.syncOnSave = false;
    config.sync.provider.kind = 'webdav';
    config.sync.provider.webdav = {
      url: `http://127.0.0.1:${dav.address().port}/dav/`, username: 'test-user', password: 'test-secret', remoteDir: 'Notes',
      headers: [
        { name: 'CF-Access-Client-Id', value: 'test-service-id' },
        { name: 'CF-Access-Client-Secret', value: 'test-gateway-secret' },
      ],
    };
    const saved = await call('sync_save_config', { config });
    assert.equal(saved.sync.rootDir, '/workspace');
    assert.equal(saved.backup.localDir, '/backups');
    assert.deepEqual(saved.sync.provider.webdav.headers, config.sync.provider.webdav.headers);
    async function run(kind) {
      const before = await call('sync_get_status');
      const field = kind === 'sync_now' ? 'lastSync' : 'lastBackup';
      await call(kind);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const current = await call('sync_get_status');
        // 开启同步会异步生成 enable 报告；必须等到本次手动任务完成，不能把更早的报告当作本次结果。
        if (current[field]?.trigger === 'manual' && current[field].at && current[field].at !== before[field]?.at) { assert.equal(current[field].ok, true, current[field].message); return current[field]; }
        await delay(50);
      }
      assert.fail('同步任务未在预期时间完成');
    }
    // 开启同步会异步执行首轮同步并持有远端锁；等它结束，避免另一台设备随后同步时撞锁。
    for (let attempt = 0; attempt < 200 && (await call('sync_get_status')).syncing; attempt += 1) await delay(50);
    return { call, run, id: saved.deviceId };
  }

  const a = await device('server-a'); const b = await device('server-b');
  assert.notEqual(a.id, b.id);
  const file = await a.call('create_file', { dir: '/workspace', name: '同步笔记.md' });
  await a.call('write_document', { path: file.key, content: '# 来自网页 A', encoding: 'utf8', eol: 'lf', expectedRevision: file.webRevision });
  await a.run('sync_now'); await b.run('sync_now');
  const downloaded = await b.call('read_document', { path: file.key });
  assert.equal(downloaded.content, '# 来自网页 A');
  await b.call('write_document', { path: file.key, content: '# 来自网页 B', encoding: 'utf8', eol: 'lf', expectedRevision: downloaded.webRevision });
  await b.run('sync_now'); await a.run('sync_now');
  assert.equal((await a.call('read_document', { path: file.key })).content, '# 来自网页 B');
  await a.call('rename_path', { from: file.key, to: '/workspace/改名.md' });
  await a.run('sync_now'); await b.run('sync_now');
  assert.equal((await b.call('read_document', { path: '/workspace/改名.md' })).content, '# 来自网页 B');
  const backup = await a.run('backup_now');
  assert.ok((await a.call('backup_list')).length > 0);
  await a.call('create_dir', { dir: '/workspace', name: '恢复' });
  await a.call('backup_restore', { name: backup.name, targetDir: '/workspace/恢复' });
  const restored = await fs.readdir(path.join(temp, 'server-a/workspace/恢复'));
  assert.equal(restored.length, 1);
  await a.call('move_to_trash', { path: '/workspace/改名.md' });
  assert.equal((await a.call('sync_trash_list')).length, 1);
  const stored = await fs.readFile(path.join(temp, 'server-a/native/sync/config.json'), 'utf8');
  assert.ok(!stored.includes('test-secret'));
  assert.ok(!stored.includes('test-gateway-secret'));
});

test('未启用访问认证时仍提供文档历史记录，且不开放同步命令', { skip: !process.env.NOTEBOARD_SYNC_BINARY }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'noteboard-history-http-'));
  const server = await createWebServer({ dataDir: path.join(temp, 'data') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.stopNoteboard(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  });
  async function send(command, args = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NoteBoard-Request': '1', 'X-NoteBoard-Client': 'browser-history-1234' }, body: JSON.stringify({ command, args }) });
    return { status: response.status, body: await response.json() };
  }
  async function call(command, args) {
    const { status, body } = await send(command, args);
    assert.equal(status, 200, `${command}: ${JSON.stringify(body)}`);
    return body.result;
  }
  const capabilities = await call('web_capabilities');
  assert.equal(capabilities.syncAvailable, false);
  assert.equal(capabilities.historyAvailable, true);
  assert.equal((await call('history_get_config')).mode, 'off');
  assert.equal((await call('history_set_mode', { mode: 'local' })).mode, 'local');
  const file = await call('create_file', { dir: '/workspace', name: '历史.md' });
  let revision = file.webRevision;
  for (const content of ['# 第一版', '# 第一版\n\n补充']) {
    const written = await call('write_document', { path: file.key, content, encoding: 'utf8', eol: 'lf', expectedRevision: revision });
    revision = written.webRevision;
  }
  // 后台线程异步记录：轮询等待版本出现
  let list;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    list = await call('history_list', { path: file.key });
    if (list.entries.length >= 1 && list.entries[0].size > 0) break;
    await delay(50);
  }
  assert.ok(list.entries.length >= 1);
  const latest = await call('history_read', { path: file.key, entryId: list.entries[0].id });
  assert.equal(latest.content, '# 第一版\n\n补充');
  // 工作区外的路径被拒绝；同步命令在无认证时不可用
  assert.notEqual((await send('history_list', { path: '/etc/passwd' })).status, 200);
  assert.equal((await send('sync_get_config')).status, 403);
  // 历史目录不出现在文件列表
  const names = (await call('read_dir', { path: '/workspace', showHidden: true })).map((n) => n.name);
  assert.ok(!names.includes('.nb-history'));
});

test('多用户：普通用户拥有独立历史记录，共享文件写入记录在所有者历史中，同步仅管理员可用', { skip: !process.env.NOTEBOARD_SYNC_BINARY }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'noteboard-multi-history-'));
  const server = await createWebServer({ dataDir: path.join(temp, 'data'), username: 'admin', password: 'admin-password' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.stopNoteboard(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function as(username, password) {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NoteBoard-Request': '1' }, body: JSON.stringify({ username, password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    async function send(command, args = {}) {
      const response = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NoteBoard-Request': '1', 'X-NoteBoard-Client': `browser-${username}-1234`, Cookie: cookie }, body: JSON.stringify({ command, args }) });
      return { status: response.status, body: await response.json() };
    }
    async function call(command, args = {}) {
      const { status, body } = await send(command, args);
      assert.equal(status, 200, `${command}: ${JSON.stringify(body)}`);
      return body.result;
    }
    return { send, call };
  }
  const admin = await as('admin', 'admin-password');
  await admin.call('users_create', { username: 'writer', password: 'writer-password' });
  const writer = await as('writer', 'writer-password');
  const capabilities = await writer.call('web_capabilities');
  assert.equal(capabilities.syncAvailable, false);
  assert.equal(capabilities.historyAvailable, true);
  assert.equal((await writer.send('sync_get_config')).status, 403);
  assert.equal((await writer.send('backup_list')).status, 403);
  // 各自的历史配置独立
  assert.equal((await writer.call('history_set_mode', { mode: 'local' })).mode, 'local');
  assert.equal((await admin.call('history_get_config')).mode, 'off');
  await admin.call('history_set_mode', { mode: 'local' });

  const file = await admin.call('create_file', { dir: '/workspace', name: '共享历史.md' });
  await admin.call('share_set', { path: file.key, grants: [{ userId: '*', permission: 'edit' }] });
  const sharedKey = '/shared/admin/共享历史.md';
  let revision = (await writer.call('read_document', { path: sharedKey })).webRevision;
  for (const content of ['# 第一版', '# 第一版\n\nwriter 补充']) {
    revision = (await writer.call('write_document', { path: sharedKey, content, encoding: 'utf8', eol: 'lf', expectedRevision: revision })).webRevision;
  }
  let list;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    list = await admin.call('history_list', { path: file.key });
    if (list.entries.length >= 1 && list.entries[0].size > 0) break;
    await delay(50);
  }
  assert.ok(list.entries.length >= 1);
  // 接收者通过共享路径读取所有者的历史，但不能删除版本
  const shared = await writer.call('history_list', { path: sharedKey });
  assert.equal(shared.entries.length, list.entries.length);
  assert.equal((await writer.call('history_read', { path: sharedKey, entryId: list.entries[0].id })).content, '# 第一版\n\nwriter 补充');
  assert.equal((await writer.send('history_delete_entry', { path: sharedKey, entryId: list.entries[0].id })).status, 403);
  // 普通用户自己的文件记录在自己的历史中
  const own = await writer.call('create_file', { dir: '/workspace', name: '自己的.md' });
  await writer.call('write_document', { path: own.key, content: '自己的内容', encoding: 'utf8', eol: 'lf', expectedRevision: own.webRevision });
  let ownList;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    ownList = await writer.call('history_list', { path: own.key });
    if (ownList.entries.length >= 1) break;
    await delay(50);
  }
  assert.ok(ownList.entries.length >= 1);
  assert.equal((await admin.send('history_list', { path: own.key })).status, 200);
  assert.equal((await admin.call('history_list', { path: own.key })).entries.length, 0);
});
