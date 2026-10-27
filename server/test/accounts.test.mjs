// 多用户网页部署：登录会话、用户管理、数据隔离与共享授权都经真实 HTTP 请求验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWebServer } from '../index.mjs';

/** 每个测试独立数据目录；返回按账号登录的调用器。 */
async function fixture(t, options = { username: 'admin', password: '管理员密码' }) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'noteboard-accounts-'));
  const staticDir = path.join(temp, 'static');
  await fs.mkdir(staticDir);
  await fs.writeFile(path.join(staticDir, 'index.html'), '<html>NoteBoard</html>');
  const dataDir = path.join(temp, 'data');
  let server;
  async function start(extra = {}) {
    server = await createWebServer({ dataDir, staticDir, ...options, ...extra });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server.stopNoteboard(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  let url = await start();
  t.after(async () => { await stop(); await fs.rm(temp, { recursive: true, force: true }); });

  async function login(username, password) {
    const response = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NoteBoard-Request': '1' }, body: JSON.stringify({ username, password }) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
  }
  /** 登录后返回该账号的调用器：send 返回状态和正文，call 断言成功。 */
  async function as(username, password) {
    const signed = await login(username, password);
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    const cookie = signed.cookie;
    async function send(command, args = {}) {
      const response = await fetch(`${url}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NoteBoard-Request': '1', 'X-NoteBoard-Client': 'test-client-1234', Cookie: cookie }, body: JSON.stringify({ command, args }) });
      return { status: response.status, body: await response.json() };
    }
    async function call(command, args = {}) {
      const { status, body } = await send(command, args);
      assert.equal(status, 200, `${command}: ${JSON.stringify(body)}`);
      return body.result;
    }
    const get = (route) => fetch(url + route, { headers: { Cookie: cookie } });
    const upload = (target, bytes) => fetch(`${url}/api/upload?path=${encodeURIComponent(target)}`, { method: 'POST', headers: { 'X-NoteBoard-Request': '1', Cookie: cookie }, body: bytes });
    return { cookie, send, call, get, upload };
  }
  async function write(user, key, content) {
    const current = await user.send('read_document', { path: key });
    const expectedRevision = current.status === 200 ? current.body.result.webRevision : null;
    return user.send('write_document', { path: key, content, encoding: 'utf8', eol: 'lf', expectedRevision });
  }
  return { temp, dataDir, get url() { return url; }, login, as, write, restart: async (extra) => { await stop(); url = await start(extra); } };
}

test('公开模式保持单空间：无需登录，多用户命令不可用', async (t) => {
  const { url } = await fixture(t, {});
  const send = (command, args = {}) => fetch(`${url}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NoteBoard-Request': '1', 'X-NoteBoard-Client': 'test-client-1234' }, body: JSON.stringify({ command, args }) });
  const capabilities = (await (await send('web_capabilities')).json()).result;
  assert.equal(capabilities.multiUser, false);
  assert.equal(capabilities.account, null);
  assert.equal((await send('read_dir', { path: '/workspace' })).status, 200);
  assert.equal((await send('users_list')).status, 404);
  assert.equal((await send('read_dir', { path: '/shared' })).status, 400);
  assert.equal((await fetch(`${url}/login`, { redirect: 'manual' })).status, 302);
});

test('管理员沿用原数据目录，登录、退出与错误提示正确', async (t) => {
  const { dataDir, login, as, url } = await fixture(t);
  await fs.mkdir(path.join(dataDir, 'workspace'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'workspace', '旧笔记.md'), '升级前的数据');
  assert.equal((await login('admin', '错误密码')).status, 401);
  assert.equal((await login('不存在', '错误密码')).status, 401);
  assert.equal((await login('', '')).status, 400);
  const admin = await as('ADMIN', '管理员密码');
  assert.deepEqual((await admin.call('web_capabilities')).account, { username: 'admin', role: 'admin' });
  assert.equal((await admin.call('read_document', { path: '/workspace/旧笔记.md' })).content, '升级前的数据');
  const out = await fetch(`${url}/api/logout`, { method: 'POST', headers: { 'X-NoteBoard-Request': '1', Cookie: admin.cookie } });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await admin.send('read_dir', { path: '/workspace' })).status, 401);
});

test('修改部署中的管理员密码后旧会话失效；会话在重启后保留', async (t) => {
  const ctx = await fixture(t);
  const admin = await ctx.as('admin', '管理员密码');
  await ctx.restart();
  assert.equal((await admin.send('read_dir', { path: '/workspace' })).status, 200);
  await ctx.restart({ password: '新的管理员密码' });
  assert.equal((await admin.send('read_dir', { path: '/workspace' })).status, 401);
  assert.equal((await ctx.login('admin', '管理员密码')).status, 401);
  assert.equal((await ctx.login('admin', '新的管理员密码')).status, 200);
});

test('用户管理仅管理员可用，用户名与密码规则生效', async (t) => {
  const { as } = await fixture(t);
  const admin = await as('admin', '管理员密码');
  assert.equal((await admin.send('users_create', { username: 'Admin', password: '12345678' })).status, 409);
  assert.equal((await admin.send('users_create', { username: '../x', password: '12345678' })).status, 400);
  assert.equal((await admin.send('users_create', { username: '小明', password: '短' })).status, 400);
  const created = await admin.call('users_create', { username: '小明', password: '小明的登录密码123' });
  assert.equal((await admin.send('users_create', { username: '小明', password: '小明的登录密码123' })).status, 409);
  const user = await as('小明', '小明的登录密码123');
  assert.deepEqual((await user.call('web_capabilities')).account, { username: '小明', role: 'user' });
  assert.equal((await user.call('web_capabilities')).syncAvailable, false);
  for (const command of ['users_list', 'users_create', 'users_delete']) assert.equal((await user.send(command, { id: created.id })).status, 403, command);
  // 实例共享的插件与字体包、多端同步只允许管理员修改。
  assert.equal((await user.send('plugin_command', { operation: 'install', id: 'pdf' })).status, 403);
  assert.equal((await user.send('remove_font_pack')).status, 403);
  assert.equal((await user.send('sync_get_config')).status, 403);
  assert.equal((await user.send('account_change_password', { oldPassword: '错误', newPassword: '新的登录密码123' })).status, 400);
  await user.call('account_change_password', { oldPassword: '小明的登录密码123', newPassword: '新的登录密码123' });
  // 当前会话保留，旧密码失效。
  assert.equal((await user.send('read_dir', { path: '/workspace' })).status, 200);
  assert.equal((await admin.send('account_change_password', { oldPassword: '管理员密码', newPassword: '新的登录密码123' })).status, 403);
});

test('用户数据互相隔离，停用吊销会话，删除后数据进入回收目录', async (t) => {
  const { as, dataDir, login } = await fixture(t);
  const admin = await as('admin', '管理员密码');
  const created = await admin.call('users_create', { username: 'alice', password: 'alice-password' });
  const alice = await as('alice', 'alice-password');
  await admin.call('create_file', { dir: '/workspace', name: '管理员.md' });
  await alice.call('create_file', { dir: '/workspace', name: 'alice.md' });
  await alice.call('save_settings', { settings: { appearance: { theme: 'mo-ye' } } });
  assert.deepEqual((await alice.call('read_dir', { path: '/workspace' })).map((node) => node.name), ['alice.md']);
  assert.deepEqual((await admin.call('read_dir', { path: '/workspace' })).map((node) => node.name), ['管理员.md']);
  assert.equal((await alice.send('read_document', { path: '/workspace/管理员.md' })).status, 404);
  assert.equal((await alice.get('/api/file?path=/workspace/管理员.md')).status, 404);
  assert.equal(await admin.call('load_settings'), null);
  await fs.access(path.join(dataDir, 'users', created.id, 'workspace', 'alice.md'));

  await admin.call('users_set_disabled', { id: created.id, disabled: true });
  assert.equal((await alice.send('read_dir', { path: '/workspace' })).status, 401);
  assert.equal((await login('alice', 'alice-password')).status, 403);
  await admin.call('users_set_disabled', { id: created.id, disabled: false });
  await admin.call('users_reset_password', { id: created.id, password: 'reset-password' });
  assert.equal((await login('alice', 'reset-password')).status, 200);

  await admin.call('users_delete', { id: created.id });
  assert.equal((await login('alice', 'reset-password')).status, 401);
  const retired = await fs.readdir(path.join(dataDir, 'trash', 'users'));
  assert.equal(retired.length, 1);
  await fs.access(path.join(dataDir, 'trash', 'users', retired[0], 'workspace', 'alice.md'));
});

test('只读与可编辑共享：路径映射、权限、取消与改名跟随', async (t) => {
  const { as, write } = await fixture(t);
  const admin = await as('admin', '管理员密码');
  const bobId = (await admin.call('users_create', { username: 'bob', password: 'bob-password' })).id;
  await admin.call('users_create', { username: 'carol', password: 'carol-password' });
  const bob = await as('bob', 'bob-password');
  const carol = await as('carol', 'carol-password');
  await bob.call('create_dir', { dir: '/workspace', name: '项目' });
  await bob.call('create_dir', { dir: '/workspace/项目', name: '.staging' });
  await bob.call('create_file', { dir: '/workspace/项目', name: '计划.md' });
  assert.equal((await write(bob, '/workspace/项目/计划.md', '# 计划')).status, 200);
  await bob.call('create_file', { dir: '/workspace', name: '私人.md' });

  // 共享校验：不能共享根目录、他人文件和隐藏路径。
  assert.equal((await bob.send('share_set', { path: '/workspace', grants: [{ userId: '*', permission: 'read' }] })).status, 400);
  assert.equal((await bob.send('share_set', { path: '/workspace/项目/.staging', grants: [{ userId: '*', permission: 'read' }] })).status, 400);
  assert.equal((await bob.send('share_set', { path: '/workspace/项目', grants: [{ userId: bobId, permission: 'read' }] })).status, 400);
  const targets = await bob.call('share_targets');
  const carolId = targets.find((item) => item.username === 'carol').id;
  assert.deepEqual(targets.map((item) => item.username).sort(), ['admin', 'carol']);
  await bob.call('share_set', { path: '/workspace/项目', grants: [{ userId: carolId, permission: 'read' }] });

  // 接收者看到 /shared/<所有者>/<共享项>，所有者自己与未授权用户看不到。
  assert.deepEqual((await carol.call('read_dir', { path: '/shared' })).map((node) => node.path), ['/shared/bob']);
  assert.deepEqual((await admin.call('read_dir', { path: '/shared' })), []);
  assert.equal((await admin.send('read_dir', { path: '/shared/bob/项目' })).status, 404);
  const listed = await carol.call('read_dir', { path: '/shared/bob/项目', showHidden: true });
  assert.deepEqual(listed.map((node) => [node.path, node.readonly]), [['/shared/bob/项目/计划.md', true]]);
  const doc = await carol.call('read_document', { path: '/shared/bob/项目/计划.md' });
  assert.equal(doc.key, '/shared/bob/项目/计划.md');
  assert.equal(doc.dirPath, '/shared/bob/项目');
  assert.equal(doc.readonly, true);
  assert.equal(doc.content, '# 计划');
  // 只读共享禁止一切写入，隐藏目录和穿越路径不可访问。
  assert.equal((await write(carol, '/shared/bob/项目/计划.md', '篡改')).status, 403);
  assert.equal((await carol.send('create_file', { dir: '/shared/bob/项目', name: '新.md' })).status, 403);
  assert.equal((await carol.send('move_to_trash', { path: '/shared/bob/项目/计划.md' })).status, 403);
  assert.equal((await carol.upload('/shared/bob/项目/上传.md', 'x')).status, 403);
  assert.equal((await carol.send('read_dir', { path: '/shared/bob/项目/.staging' })).status, 404);
  assert.equal((await carol.send('read_document', { path: '/shared/bob/项目/../私人.md' })).status, 404);
  assert.equal((await carol.send('read_document', { path: '/shared/bob/私人.md' })).status, 404);
  assert.equal((await carol.get('/api/file?path=/shared/bob/项目/计划.md')).status, 200);

  // 升级为可编辑：可新建、保存、改名、删除内部文件，但不能动共享项本身或跨空间移动。
  await bob.call('share_set', { path: '/workspace/项目', grants: [{ userId: carolId, permission: 'edit' }] });
  assert.equal((await write(carol, '/shared/bob/项目/计划.md', '# 计划\n\ncarol 补充')).status, 200);
  assert.equal((await bob.call('read_document', { path: '/workspace/项目/计划.md' })).content, '# 计划\n\ncarol 补充');
  const created = await carol.call('create_file', { dir: '/shared/bob/项目', name: '记录.md' });
  assert.equal(created.key, '/shared/bob/项目/记录.md');
  assert.equal((await carol.send('create_file', { dir: '/shared/bob/项目', name: '.隐藏.md' })).status, 400);
  assert.equal((await carol.upload('/shared/bob/项目/上传.md', 'x')).status, 200);
  await carol.call('rename_path', { from: '/shared/bob/项目/记录.md', to: '/shared/bob/项目/记录2.md' });
  assert.equal((await carol.send('rename_path', { from: '/shared/bob/项目', to: '/shared/bob/项目2' })).status, 403);
  assert.equal((await carol.send('move_to_trash', { path: '/shared/bob/项目' })).status, 403);
  assert.equal((await carol.send('rename_path', { from: '/shared/bob/项目/记录2.md', to: '/workspace/偷走.md' })).status, 400);
  await carol.call('move_to_trash', { path: '/shared/bob/项目/记录2.md' });
  assert.deepEqual((await bob.call('read_dir', { path: '/workspace/项目' })).map((node) => node.name), ['计划.md', '上传.md']);
  // /shared 虚拟目录本身不可写。
  assert.equal((await carol.send('create_file', { dir: '/shared', name: 'x.md' })).status, 403);
  assert.equal((await carol.send('create_dir', { dir: '/shared/bob', name: 'x' })).status, 403);

  // 所有者改名后共享跟随；删除后共享移除。
  await bob.call('rename_path', { from: '/workspace/项目', to: '/workspace/项目-新' });
  assert.deepEqual((await carol.call('read_dir', { path: '/shared/bob' })).map((node) => node.path), ['/shared/bob/项目-新']);
  assert.equal((await bob.call('share_list_mine'))[0].path, '/workspace/项目-新');

  // 取消共享立即生效。
  await bob.call('share_set', { path: '/workspace/项目-新', grants: [] });
  assert.equal((await carol.send('read_document', { path: '/shared/bob/项目-新/计划.md' })).status, 404);
  assert.deepEqual(await carol.call('read_dir', { path: '/shared' }), []);
  assert.deepEqual(await bob.call('share_list_mine'), []);
});

test('“所有用户”授权、同名共享项、所有者停用与删除', async (t) => {
  const { as } = await fixture(t);
  const admin = await as('admin', '管理员密码');
  const dave = await admin.call('users_create', { username: 'dave', password: 'dave-password' });
  await admin.call('users_create', { username: 'erin', password: 'erin-password' });
  const erin = await as('erin', 'erin-password');
  await admin.call('create_dir', { dir: '/workspace', name: 'a' });
  await admin.call('create_dir', { dir: '/workspace', name: 'b' });
  await admin.call('create_file', { dir: '/workspace/a', name: '笔记.md' });
  await admin.call('create_file', { dir: '/workspace/b', name: '笔记.md' });
  await admin.call('share_set', { path: '/workspace/a/笔记.md', grants: [{ userId: '*', permission: 'read' }] });
  await admin.call('share_set', { path: '/workspace/b/笔记.md', grants: [{ userId: '*', permission: 'edit' }, { userId: dave.id, permission: 'read' }] });
  const items = await erin.call('read_dir', { path: '/shared/admin' });
  assert.deepEqual(items.map((node) => [node.name, node.readonly, node.kind]), [['笔记 (2).md', false, 'markdown'], ['笔记.md', true, 'markdown']]);
  // 新建的用户自动获得“所有用户”授权；显式只读与所有人可编辑取较高权限。
  const daveSession = await as('dave', 'dave-password');
  assert.equal((await daveSession.call('read_dir', { path: '/shared/admin' })).find((node) => node.name === '笔记 (2).md').readonly, false);
  // 所有者被删除后其共享不再可见（以普通用户为所有者验证）。
  await daveSession.call('create_file', { dir: '/workspace', name: 'dave.md' });
  await daveSession.call('share_set', { path: '/workspace/dave.md', grants: [{ userId: '*', permission: 'read' }] });
  assert.ok((await erin.call('read_dir', { path: '/shared' })).some((node) => node.name === 'dave'));
  await admin.call('users_set_disabled', { id: dave.id, disabled: true });
  assert.ok(!(await erin.call('read_dir', { path: '/shared' })).some((node) => node.name === 'dave'));
  await admin.call('users_delete', { id: dave.id });
  assert.equal((await erin.send('read_dir', { path: '/shared/dave' })).status, 404);
});

test('草稿和最近记录按账号隔离，同一浏览器切换账号不串数据', async (t) => {
  const { as } = await fixture(t);
  const admin = await as('admin', '管理员密码');
  await admin.call('users_create', { username: 'frank', password: 'frank-password' });
  const frank = await as('frank', 'frank-password');
  await admin.call('write_draft', { key: 'untitled:1', content: '管理员草稿', kind: 'markdown' });
  await admin.call('create_file', { dir: '/workspace', name: 'x.md' });
  await admin.call('push_recent', { path: '/workspace/x.md', isDir: false });
  assert.deepEqual(await frank.call('list_drafts'), []);
  assert.deepEqual(await frank.call('list_recent'), []);
  // 暂存目录只能在本人工作区内。
  await frank.call('save_settings', { settings: { file: { stagingDirectory: '/shared/admin' } } });
  assert.equal((await frank.send('ensure_staging_directory')).status, 400);
});

test('反向代理声明 HTTPS 时会话 Cookie 带 Secure；同一来源连续失败触发限流', async (t) => {
  const { url, login } = await fixture(t);
  const secure = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NoteBoard-Request': '1', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ username: 'admin', password: '管理员密码' }) });
  assert.match(secure.headers.get('set-cookie'), /; Secure/);
  assert.doesNotMatch((await login('admin', '管理员密码')).cookie ?? '', /Secure/);
  // 缺少自定义请求头的跨站表单无法登录
  assert.equal((await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '管理员密码' }) })).status, 403);
  let status = 0;
  for (let attempt = 0; attempt < 31 && status !== 429; attempt += 1) status = (await login('admin', `错误密码-${attempt}`)).status;
  assert.equal(status, 429);
});
