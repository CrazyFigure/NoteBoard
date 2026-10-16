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
    async function call(command, args = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NoteBoard-Request': '1', 'X-NoteBoard-Client': `browser-${name}-1234`, Authorization: `Basic ${Buffer.from('admin:password').toString('base64')}` }, body: JSON.stringify({ command, args }) });
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
    config.sync.provider.webdav = { url: `http://127.0.0.1:${dav.address().port}/dav/`, username: 'test-user', password: 'test-secret', userAgent: '', remoteDir: 'Notes' };
    const saved = await call('sync_save_config', { config });
    assert.equal(saved.sync.rootDir, '/workspace');
    assert.equal(saved.backup.localDir, '/backups');
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
});
