// 网页多用户：账号、登录会话与共享授权的持久化。管理员凭据始终来自部署环境变量，普通用户由管理员在软件内维护。
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { fail } from './files.mjs';

export const ADMIN_ID = 'admin';
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;
// 会话最近使用时间按小时落盘，避免每个请求都写文件。
const TOUCH_MS = 3600 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const MAX_USERS = 500;
const MAX_SHARES = 5000;

/** scrypt 异步执行，避免登录校验阻塞其他请求。 */
function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => scryptCallback(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}

/** 哈希串内保存参数和盐，日后调整强度时旧密码仍可校验。 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 用户名比较忽略大小写与 Unicode 组合差异。 */
function fold(name) { return String(name).normalize('NFC').toLowerCase(); }
function digest(token) { return createHash('sha256').update(token).digest('hex'); }

/** 用户名会出现在共享路径中，规则与工作区文件名一致：不能以点开头结尾，也不能是 Windows 保留名。 */
export function validateUsername(name) {
  if (typeof name !== 'string') throw fail('请输入用户名');
  const value = name.normalize('NFC').trim();
  if (!value) throw fail('请输入用户名');
  if ([...value].length > 32) throw fail('用户名最多 32 个字符');
  if (!/^[\p{L}\p{N}._-]+$/u.test(value)) throw fail('用户名只能包含文字、数字和 . _ -');
  if (value.startsWith('.') || value.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) throw fail('用户名不可用');
  return value;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || [...password].length < 8) throw fail('密码至少 8 位');
  if (password.length > 256) throw fail('密码过长');
  return password;
}

/** 创建账号服务；auth 目录内文件仅当前服务用户可读写。 */
export async function createAccounts(dataDir, { username, password }) {
  const root = path.join(path.resolve(dataDir), 'auth');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });

  async function load(name, fallback) {
    try { return JSON.parse(await fs.readFile(path.join(root, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }

  // 所有写入串行并原子替换，异常时不会留下半截 JSON。
  let queue = Promise.resolve();
  function persist(name, value) {
    const task = queue.then(async () => {
      const target = path.join(root, name);
      const temporary = path.join(root, `.nb-write-${randomUUID()}`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, target);
      } finally { await fs.rm(temporary, { force: true }); }
    });
    queue = task.catch(() => {});
    return task;
  }

  // 服务端密钥只用于管理员会话指纹，部署凭据变化后旧会话立即失效。
  let secret = await fs.readFile(path.join(root, 'secret.key')).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!secret || secret.length < 32) {
    secret = randomBytes(32);
    await fs.writeFile(path.join(root, 'secret.key'), secret, { mode: 0o600 });
  }
  const adminFingerprint = createHmac('sha256', secret).update(`${username}\0${password}`).digest('hex');
  const adminName = username;

  const users = (await load('users.json', { schemaVersion: 1, users: [] })).users;
  const sessions = new Map(Object.entries((await load('sessions.json', { schemaVersion: 1, sessions: {} })).sessions));
  const shares = (await load('shares.json', { schemaVersion: 1, shares: [] })).shares;
  const conflict = users.find((user) => fold(user.username) === fold(adminName));
  if (conflict) console.warn(`普通用户 ${conflict.username} 与管理员账号同名，登录时将按管理员处理`);

  const saveUsers = () => persist('users.json', { schemaVersion: 1, users });
  const saveSessions = () => persist('sessions.json', { schemaVersion: 1, sessions: Object.fromEntries(sessions) });
  const saveShares = () => persist('shares.json', { schemaVersion: 1, shares });

  // 启动时清理过期会话，避免文件持续增长。
  const now = Date.now();
  let expired = false;
  for (const [id, item] of sessions) if (item.expires <= now) { sessions.delete(id); expired = true; }
  if (expired) await saveSessions();

  const admin = { id: ADMIN_ID, username: adminName, role: 'admin' };
  function identity(user) { return user.id === ADMIN_ID ? admin : { id: user.id, username: user.username, role: 'user' }; }
  function find(id) { return id === ADMIN_ID ? admin : users.find((user) => user.id === id) ?? null; }
  /** 停用、删除或与管理员同名的用户视为不可用：不能登录，共享对他人不可见。 */
  function active(id) {
    if (id === ADMIN_ID) return true;
    const user = users.find((item) => item.id === id);
    return !!user && !user.disabled && fold(user.username) !== fold(adminName);
  }
  function requireUser(id) {
    const user = users.find((item) => item.id === id);
    if (!user) throw fail('用户不存在', 404);
    return user;
  }

  // 登录限流：每 IP 每分钟 30 次硬上限；同一用户名连续失败只拖慢响应，不锁定账号，防止被他人恶意锁号。
  const ipAttempts = new Map();
  const nameFailures = new Map();
  const dummyHash = await hashPassword(randomBytes(16).toString('hex'));
  function throttle(ip) {
    const time = Date.now();
    const prior = ipAttempts.get(ip);
    if (prior && prior.until > time && prior.count >= 30) throw fail('登录尝试过多，请稍后重试', 429);
    if (ipAttempts.size > 10000) ipAttempts.clear();
    ipAttempts.set(ip, { count: prior?.until > time ? prior.count + 1 : 1, until: prior?.until > time ? prior.until : time + 60000 });
  }

  /** 签发会话前清理过期项，并限制每个账号最多保留 20 个会话（淘汰最久未用的）。 */
  function issue(userId) {
    const token = randomBytes(32).toString('base64url');
    const time = Date.now();
    for (const [id, item] of sessions) if (item.expires <= time) sessions.delete(id);
    const owned = [...sessions].filter(([, item]) => item.userId === userId).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    while (owned.length >= 20) sessions.delete(owned.shift()[0]);
    sessions.set(digest(token), { userId, created: time, lastSeen: time, expires: time + SESSION_MS, ...(userId === ADMIN_ID ? { fingerprint: adminFingerprint } : {}) });
    return token;
  }

  async function login(name, pass, ip) {
    throttle(ip);
    if (typeof name !== 'string' || typeof pass !== 'string' || !name.trim() || !pass || name.length > 256 || pass.length > 256) throw fail('请输入账号和密码', 400);
    const key = fold(name.trim());
    const failure = nameFailures.get(key);
    if (failure && failure.until > Date.now() && failure.count >= 10) await new Promise((resolve) => setTimeout(resolve, 1500));
    let userId = null;
    let disabled = false;
    if (key === fold(adminName)) {
      // 管理员按定长摘要比较，避免长度和比较时间泄露密码信息。
      const hash = (value) => createHash('sha256').update(value).digest();
      await verifyPassword(pass, dummyHash);
      if (timingSafeEqual(hash(pass), hash(password))) userId = ADMIN_ID;
    } else {
      const user = users.find((item) => fold(item.username) === key);
      // 不存在的用户同样计算一次哈希，响应时间不暴露用户名是否存在。
      if (await verifyPassword(pass, user?.passwordHash ?? dummyHash) && user) { userId = user.id; disabled = !!user.disabled; }
    }
    if (!userId) {
      if (nameFailures.size > 10000) nameFailures.clear();
      nameFailures.set(key, { count: failure?.until > Date.now() ? failure.count + 1 : 1, until: failure?.until > Date.now() ? failure.until : Date.now() + 15 * 60000 });
      throw fail('账号或密码错误', 401);
    }
    if (disabled) throw fail('账号已停用，请联系管理员', 403);
    nameFailures.delete(key);
    ipAttempts.delete(ip);
    const token = issue(userId);
    if (userId !== ADMIN_ID) { const user = requireUser(userId); user.lastLoginAt = Date.now(); await saveUsers(); }
    else admin.lastLoginAt = Date.now();
    await saveSessions();
    return { token, user: identity(find(userId)) };
  }

  /** 校验会话：过期、凭据变更、账号停用都返回空；有效会话滑动续期。 */
  function session(token) {
    if (typeof token !== 'string' || !token || token.length > 200) return null;
    const id = digest(token);
    const item = sessions.get(id);
    if (!item) return null;
    const time = Date.now();
    const valid = item.expires > time && active(item.userId) && (item.userId !== ADMIN_ID || item.fingerprint === adminFingerprint);
    if (!valid) { sessions.delete(id); void saveSessions().catch(() => {}); return null; }
    if (time - item.lastSeen > TOUCH_MS) {
      item.lastSeen = time; item.expires = time + SESSION_MS;
      void saveSessions().catch(() => {});
    }
    return { ...identity(find(item.userId)), sessionId: id };
  }

  async function revoke(userId, keepSessionId = null) {
    let changed = false;
    for (const [id, item] of sessions) if (item.userId === userId && id !== keepSessionId) { sessions.delete(id); changed = true; }
    if (changed) await saveSessions();
  }

  async function logout(token) {
    if (typeof token === 'string' && sessions.delete(digest(token))) await saveSessions();
  }

  function publicUser(user) {
    return { id: user.id, username: user.username, disabled: !!user.disabled, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt ?? null, conflict: fold(user.username) === fold(adminName) };
  }

  async function createUser(name, pass) {
    const username = validateUsername(name);
    validatePassword(pass);
    if (fold(username) === fold(adminName) || users.some((user) => fold(user.username) === fold(username))) throw fail('用户名已存在', 409);
    if (users.length >= MAX_USERS) throw fail(`最多创建 ${MAX_USERS} 个用户`);
    const passwordHash = await hashPassword(pass);
    // 计算哈希期间可能有同名的并发创建，落盘前再核对一次。
    if (users.some((user) => fold(user.username) === fold(username))) throw fail('用户名已存在', 409);
    // 目录名使用随机标识，不受用户名字符和日后调整影响。
    const user = { id: randomBytes(9).toString('base64url').replace(/[-_]/g, 'x'), username, passwordHash, disabled: false, createdAt: Date.now(), lastLoginAt: null };
    users.push(user);
    await saveUsers();
    return publicUser(user);
  }

  async function setDisabled(id, disabled) {
    const user = requireUser(id);
    user.disabled = !!disabled;
    await saveUsers();
    if (disabled) await revoke(id);
    return publicUser(user);
  }

  async function resetPassword(id, pass) {
    const user = requireUser(id);
    user.passwordHash = await hashPassword(validatePassword(pass));
    await saveUsers();
    await revoke(id);
    return publicUser(user);
  }

  async function changePassword(current, oldPass, newPass) {
    if (current.id === ADMIN_ID) throw fail('管理员密码请在 Docker / 1Panel 中修改', 403);
    const user = requireUser(current.id);
    if (typeof oldPass !== 'string' || !await verifyPassword(oldPass, user.passwordHash)) throw fail('当前密码不正确', 400);
    validatePassword(newPass);
    if (oldPass === newPass) throw fail('新密码不能与当前密码相同');
    user.passwordHash = await hashPassword(newPass);
    await saveUsers();
    await revoke(user.id, current.sessionId);
  }

  /** 删除账号记录、会话、其拥有的共享及授予他的权限；数据目录由调用方移入回收目录。 */
  async function deleteUser(id) {
    const index = users.findIndex((user) => user.id === id);
    if (index < 0) throw fail('用户不存在', 404);
    const [user] = users.splice(index, 1);
    await saveUsers();
    await revoke(id);
    for (const share of shares) share.grants = share.grants.filter((grant) => grant.userId !== id);
    const remaining = shares.filter((share) => share.ownerId !== id && share.grants.length);
    shares.splice(0, shares.length, ...remaining);
    await saveShares();
    return user;
  }

  // ── 共享授权 ──

  function under(target, base) { return target === base || target.startsWith(`${base}/`); }

  function listUsers() { return users.map(publicUser); }

  /** 共享对象候选：其他可用账号（含管理员），只返回名称与标识。 */
  function shareTargets(selfId) {
    return [admin, ...users.filter((user) => active(user.id))].filter((user) => user.id !== selfId).map((user) => ({ id: user.id, username: user.username, role: user.id === ADMIN_ID ? 'admin' : 'user' }));
  }

  function shareView(share) {
    return { id: share.id, path: share.path, createdAt: share.createdAt, grants: share.grants.map((grant) => ({ ...grant, username: grant.userId === '*' ? null : find(grant.userId)?.username ?? null })) };
  }

  function sharesOf(ownerId) { return shares.filter((share) => share.ownerId === ownerId).map(shareView); }
  function shareAt(ownerId, key) { const share = shares.find((item) => item.ownerId === ownerId && item.path === key); return share ? shareView(share) : null; }

  /** 设置单个路径的授权；空列表即取消共享。只接受可用账号或“所有用户”。 */
  async function setShare(ownerId, key, grants) {
    if (!Array.isArray(grants) || grants.length > 200) throw fail('共享对象不合法');
    const normalized = [];
    for (const grant of grants) {
      if (!grant || !['read', 'edit'].includes(grant.permission)) throw fail('共享权限不合法');
      if (grant.userId !== '*' && (grant.userId === ownerId || !active(grant.userId))) throw fail('共享对象不存在或已停用');
      if (normalized.some((item) => item.userId === grant.userId)) continue;
      normalized.push({ userId: grant.userId, permission: grant.permission });
    }
    const index = shares.findIndex((item) => item.ownerId === ownerId && item.path === key);
    if (!normalized.length) {
      if (index >= 0) { shares.splice(index, 1); await saveShares(); }
      return null;
    }
    if (index >= 0) shares[index].grants = normalized;
    else {
      if (shares.length >= MAX_SHARES) throw fail('共享数量已达上限');
      shares.push({ id: randomUUID(), ownerId, path: key, grants: normalized, createdAt: Date.now() });
    }
    await saveShares();
    return shareAt(ownerId, key);
  }

  async function removeShare(ownerId, id) {
    const index = shares.findIndex((item) => item.ownerId === ownerId && item.id === id);
    if (index < 0) throw fail('共享不存在', 404);
    shares.splice(index, 1);
    await saveShares();
  }

  /** 所有者改名或移动后，位于该路径之下的共享随之更新。 */
  async function renameSharedPath(ownerId, from, to) {
    let changed = false;
    for (const share of shares) if (share.ownerId === ownerId && under(share.path, from)) { share.path = to + share.path.slice(from.length); changed = true; }
    if (changed) await saveShares();
  }

  /** 所有者删除路径后，其下的共享一并移除，避免同名新文件意外继承授权。 */
  async function removeSharedPath(ownerId, key) {
    const before = shares.length;
    for (let i = shares.length - 1; i >= 0; i -= 1) if (shares[i].ownerId === ownerId && under(shares[i].path, key)) shares.splice(i, 1);
    if (shares.length !== before) await saveShares();
  }

  /** 共享给某用户的条目：所有者必须可用；显式授权与“所有用户”取较高权限。 */
  function incoming(userId) {
    const result = [];
    for (const share of shares) {
      if (share.ownerId === userId || !active(share.ownerId)) continue;
      const matched = share.grants.filter((grant) => grant.userId === userId || grant.userId === '*');
      if (!matched.length) continue;
      result.push({ id: share.id, ownerId: share.ownerId, owner: find(share.ownerId).username, path: share.path, createdAt: share.createdAt, permission: matched.some((grant) => grant.permission === 'edit') ? 'edit' : 'read' });
    }
    return result.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  return { adminName, admin, login, session, logout, revoke, find, active, listUsers, createUser, setDisabled, resetPassword, changePassword, deleteUser, shareTargets, sharesOf, shareAt, setShare, removeShare, renameSharedPath, removeSharedPath, incoming };
}
