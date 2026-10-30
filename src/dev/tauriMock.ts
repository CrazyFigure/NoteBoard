// NoteBoard 浏览器预览用 Tauri IPC 模拟（仅开发服务器 + URL 带 ?mock=1 时加载）
// 用途：在普通浏览器 / 无头浏览器中预览与走查界面（尤其是移动端布局），无需编译 Rust 与安卓工程。
// 提供内存文件系统与启动链路所需的最小命令集；未覆盖的命令返回 null 并打印提示。

import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { createDefaultBitableDocument, serializeBitableDocument } from '../features/bitable/bitableConverter';

interface MockFile {
  content: string;
  mtime: number;
}

const WORKSPACE = '/data/user/0/com.crazyfigure.noteboard/workspace';
const EXTERNAL_ROOT = '/storage/emulated/0';

const now = Date.now();
const files = new Map<string, MockFile>();
const dirs = new Set<string>([WORKSPACE, `${WORKSPACE}/项目笔记`, `${WORKSPACE}/读书`, `${WORKSPACE}/.nb-trash`, EXTERNAL_ROOT, `${EXTERNAL_ROOT}/Documents`]);

function seed(path: string, content: string, ageMinutes: number): void {
  files.set(path, { content, mtime: now - ageMinutes * 60_000 });
}

seed(`${WORKSPACE}/欢迎使用 NoteBoard.md`, '# 欢迎使用 NoteBoard\n\n这是你的笔记工作区。\n\n- 点击右下角 **＋** 新建\n- 长按文件查看更多操作\n- 输入 `[[` 链接其它笔记：[[周报]]、[[需求#目标|项目目标]]、[[尚未同步的笔记]]\n\n> [!TIP]\n> 从其它应用分享文件到 NoteBoard 即可编辑。\n\n![[需求]]\n', 3);
seed(`${WORKSPACE}/周报.md`, '* 本周完成\n* 下周计划\n\n_重点_：移动端适配，见 [[需求]]\n', 60 * 30);
seed(`${WORKSPACE}/购物清单.txt`, '牛奶\n面包\n鸡蛋\n', 60 * 24 * 40);
seed(`${WORKSPACE}/架构草图.excalidraw`, '', 60 * 5);
seed(`${WORKSPACE}/项目笔记/需求.md`, '# 需求\n\n## 背景\n\n## 目标\n', 90);
seed(`${WORKSPACE}/读书/摘录.md`, '# 摘录\n', 2000);
seed(`${WORKSPACE}/任务看板.bitable`, serializeBitableDocument(createDefaultBitableDocument('任务看板')), 30);
// 预览插件和跨文件工作台的开发样例，二进制由测试目录按需提供。
seed(`${WORKSPACE}/快捷笔记.bitable`, serializeBitableDocument(createDefaultBitableDocument('快捷笔记')), 15);
// HTML 分屏预览样例：外链样式表验证本地样式内联
seed(`${WORKSPACE}/产品介绍.html`, `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>产品介绍</title>
  <link rel="stylesheet" href="style.css">
  <style>
    body { font-family: system-ui, sans-serif; margin: 32px; color: #1e293b; }
    .card { padding: 16px 20px; border-radius: 12px; background: #eff6ff; border: 1px solid #bfdbfe; }
  </style>
</head>
<body>
  <h1>NoteBoard</h1>
  <p class="lead">一站式笔记、画板与图表工具。</p>
  <div class="card">
    <h2>功能</h2>
    <ul>
      <li>Markdown 笔记</li>
      <li>思维导图</li>
      <li><a href="#more">了解更多</a></li>
    </ul>
  </div>
  <script>document.body.innerHTML = "脚本不应执行";</script>
  <h2 id="more">更多</h2>
  <p>预览不运行脚本。</p>
</body>
</html>
`, 8);
seed(`${WORKSPACE}/style.css`, `h1 { color: #2563eb; }
.lead { font-size: 18px; color: #475569; }
`, 8);
for(const name of ['sample.doc','sample.docx','sample.xls','sample.xlsx','sample.ppt','sample.pptx','sample.pdf','sample.dwg','sample.dxf','sample.epub'])seed(`${WORKSPACE}/${name}`,'',10);

let mockFontPackState: 'ready' | 'missing' = 'ready';

/** 更新样例模式：URL 参数 mockUpdate=1（多个版本）/ single（单个版本），未设置时为 null */
function mockUpdateMode(): 'multi' | 'single' | null {
  const value = new URLSearchParams(window.location.search).get('mockUpdate');
  if (!value) return null;
  return value === 'single' ? 'single' : 'multi';
}

/** 更新检查样例：格式与真实 Release 正文一致（新增 / 修复 / 优化小节） */
function mockUpdateResult() {
  const day = 24 * 60 * 60_000;
  const notes = [
    { version: '0.5.2', body: '新增：\n- 同步与备份新增 GitCode 远端\n\n修复：\n- 安卓构建单独安装 NDK 并在下载中断时重试\n\n优化：\n- 设置弹窗与同步弹窗去掉全屏毛玻璃，修复桌面端滚动卡顿\n- 字体包卡片背景与其他分组统一，设置页滑块改为细轨道并填充已选区间\n- 图表全屏预览拖动缩放改为直写 DOM，去掉普通滚轮平移' },
    { version: '0.5.1', body: '修复：\n- 修复最小化恢复后 Tooltip 残留\n- 消除同步与备份页首次切换闪烁' },
    { version: '0.5.0', body: '新增：\n- 多端同步与备份：支持 WebDAV、S3、GitHub、Gitee\n- 同步回收站，可恢复被远端删除的笔记\n\n优化：\n- 设置页分组重新排版\n- 移动端底部格式栏支持 `代码块` 快捷插入' },
    { version: '0.4.9', body: '新增：\n- 多维表格支持长文本单元格编辑浮层\n\n修复：\n- 多维表格 Backspace 误删整行' },
    { version: '0.4.8', body: '' },
  ];
  const list = mockUpdateMode() === 'single' ? notes.slice(0, 1) : notes;
  const releaseNotes = list.map((note, index) => ({
    version: note.version,
    name: `v${note.version}`,
    url: `https://github.com/CrazyFigure/NoteBoard/releases/tag/v${note.version}`,
    publishedAt: new Date(now - index * day).toISOString(),
    body: note.body,
  }));
  return {
    currentVersion: '0.4.7',
    latestVersion: releaseNotes[0].version,
    releaseName: releaseNotes[0].name,
    releaseUrl: releaseNotes[0].url,
    publishedAt: releaseNotes[0].publishedAt,
    updateAvailable: true,
    installerAssetName: 'NoteBoard_0.5.2_x64-setup.exe',
    installerDownloadUrl: 'https://example.com/NoteBoard_0.5.2_x64-setup.exe',
    installerSize: 12_874_301,
    releaseBody: releaseNotes[0].body,
    releaseNotes,
    releaseNotesTruncated: false,
  };
}

/** 同步配置样例（保存后在内存中保留，便于预览交互） */
const emptyGit = { baseUrl: '', owner: '', repo: '', branch: '', token: '', remoteDir: '' };
/** 每个入口创建独立对象，便于浏览器预览验证切换后配置与密钥互不覆盖。 */
const emptyStorage = () => ({ endpoint: '', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', prefix: '', pathStyle: false, customDomain: false, headers: [] });
const mockProvider = {
  kind: 'webdav',
  webdav: { url: 'https://dav.jianguoyun.com/dav/', username: 'me@example.com', password: 'app-password', headers: [], remoteDir: 'NoteBoard' },
  s3: emptyStorage(),
  oss: emptyStorage(),
  zos: emptyStorage(),
  oos: emptyStorage(),
  obs: emptyStorage(),
  cos: emptyStorage(),
  github: { ...emptyGit },
  gitee: { ...emptyGit },
  gitcode: { ...emptyGit },
  gitlab: { ...emptyGit },
};
let mockSyncConfig: Record<string, unknown> = {
  version: 1,
  deviceId: 'mock-device',
  sync: {
    enabled: true, rootDir: WORKSPACE, deviceName: '我的电脑', provider: mockProvider,
    syncOnSave: true, intervalEnabled: true, intervalMinutes: 30, syncOnStartup: true, notifyNoChange: false,
    trashEnabled: true, trashDays: 30,
  },
  backup: { autoEnabled: true, intervalHours: 24, keepCount: 10, target: 'local', localDir: 'D:/Backup/NoteBoard', provider: { ...mockProvider, kind: 'github' } },
};

// ── 文档历史记录（内存样例：URL 带 mockHistory=off 时模拟未开启） ──

interface MockVersion {
  id: string;
  at: number;
  content: string;
  reason: string;
  device: string;
  name: string;
  restoredFrom?: string;
  pinned?: boolean;
  open?: boolean;
}

const MOCK_DEVICE = 'mock-device';
let mockHistoryMode = new URLSearchParams(window.location.search).get('mockHistory') === 'off' ? 'off' : 'local';
let mockHistoryWindow = 10;
let mockHistoryRetention = 90;
let mockHistoryFullKeep = 7;
const mockHistories = new Map<string, MockVersion[]>();
let mockVersionSeq = 0;

function mockVersion(content: string, ageMinutes: number, reason = 'save', device = MOCK_DEVICE, name = '我的电脑'): MockVersion {
  mockVersionSeq += 1;
  return { id: `v${mockVersionSeq.toString().padStart(4, '0')}`, at: now - ageMinutes * 60_000, content, reason, device, name };
}

/** 粗略统计：剥离公共前后缀后各自剩余的字数 */
function mockStats(prev: string | undefined, next: string) {
  if (prev === undefined) return undefined;
  let pre = 0;
  while (pre < prev.length && pre < next.length && prev[pre] === next[pre]) pre += 1;
  let suf = 0;
  while (suf < prev.length - pre && suf < next.length - pre && prev[prev.length - 1 - suf] === next[next.length - 1 - suf]) suf += 1;
  const count = (s: string) => s.replace(/[\r\n]/g, '').length;
  return { ins: count(next.slice(pre, next.length - suf)), del: count(prev.slice(pre, prev.length - suf)), unit: 'char' };
}

function seedHistory(path: string, versions: MockVersion[]): void {
  mockHistories.set(path, versions.sort((a, b) => a.at - b.at));
}

seedHistory(`${WORKSPACE}/周报.md`, [
  mockVersion('* 本周完成\n', 60 * 24 * 40, 'initial'),
  mockVersion('* 本周完成\n* 下周计划\n', 60 * 24 * 40 - 6),
  mockVersion('* 本周完成：同步设置页\n* 下周计划\n\n重点：桌面端适配\n', 60 * 24 * 3, 'sync-pull', 'macbook', 'MacBook'),
  mockVersion('* 本周完成：同步设置页\n* 下周计划：历史记录\n\n_重点_：移动端适配\n', 60 * 26),
  mockVersion('* 本周完成\n* 下周计划\n\n_重点_：移动端适配\n', 60 * 30),
]);
seedHistory(`${WORKSPACE}/欢迎使用 NoteBoard.md`, [
  mockVersion('# 欢迎使用 NoteBoard\n\n这是你的笔记工作区。\n', 60 * 24 * 2, 'initial'),
  mockVersion('# 欢迎使用 NoteBoard\n\n这是你的笔记工作区。\n\n- 点击右下角 **＋** 新建\n- 长按文件查看更多操作\n', 60 * 5),
  mockVersion(files.get(`${WORKSPACE}/欢迎使用 NoteBoard.md`)?.content ?? '', 3),
]);
seedHistory(`${WORKSPACE}/购物清单.txt`, [
  mockVersion('牛奶\n面包\n', 60 * 24 * 41, 'initial'),
  mockVersion('牛奶\n全麦面包\n苹果\n', 60 * 24 * 40.5, 'save', 'phone', '安卓设备'),
  mockVersion('牛奶\n面包\n鸡蛋\n', 60 * 24 * 40),
]);

// Markdown 渲染级差异样例：标题改名、嵌套列表增删、表格单元格修改、代码块替换
const CONCEPT_V1 = [
  '# 00001_基础概念', '',
  '- Tracking 平台项目组织：',
  '  - Tracking：链路追踪服务', '    - tracking-agent：agent服务包', '    - tracking-core：核心逻辑',
  '  - Tracking-Realtime：实时计算', '    - tracking-realtime-streaming：实时数据ETL处理',
  '  - tracking-common：基础公共服务包', '',
  '| 模块 | 负责人 |', '| --- | --- |', '| agent | 张三 |', '| core | 李四 |', '',
  '```js', 'const port = 8080;', '```', '',
  '旧的补充说明，稍后删除。', '',
].join('\n');
const CONCEPT_V2 = [
  '# 基础概念', '',
  '- Tracking 平台项目组织：',
  '  - Tracking：链路追踪Agent服务', '    - tracking-agent：agent服务包', '    - tracking-core：核心逻辑', '    - tracking-plugin：插件逻辑',
  '  - Tracking-Realtime：实时计算服务', '    - tracking-realtime-alerting：实时内存告警计算', '    - tracking-realtime-streaming：实时数据ETL处理',
  '  - Tracking-Management：控制台管理服务', '    - tracking-management-console：管理平台',
  '  - tracking-common：基础公共服务包', '',
  '| 模块 | 负责人 |', '| --- | --- |', '| agent | 张三 |', '| core | **王五** |', '',
  '```js', 'const port = 9090;', '```', '',
].join('\n');
seed(`${WORKSPACE}/项目笔记/基础概念.md`, CONCEPT_V2, 30);
seedHistory(`${WORKSPACE}/项目笔记/基础概念.md`, [
  mockVersion('# 00001_基础概念\n\n- Tracking 平台项目组织：\n', 60 * 24 * 33, 'initial'),
  mockVersion(CONCEPT_V1, 60 * 24 * 33 - 20, 'save', 'macbook', 'MacBook'),
  mockVersion(CONCEPT_V2, 60 * 2),
]);

// 多维表格样例：旧版本改单元格、删一行、改列名，新版本新增一行与一列
{
  const next = createDefaultBitableDocument('任务看板');
  const old = JSON.parse(JSON.stringify(next)) as typeof next;
  old.title = '任务清单';
  if (old.rows[0]) old.rows[0].col_status = 'opt_todo';
  if (old.rows[1]) old.rows[1].col_assignee = '张三';
  old.rows.splice(2, 0, { id: 'row_removed', col_name: '旧需求整理', col_status: 'opt_done', col_assignee: '李四' });
  const statusCol = old.columns.find((c) => c.id === 'col_status');
  if (statusCol) statusCol.name = '状态';
  next.rows.push({ id: 'row_added', col_name: '历史记录功能', col_status: 'opt_doing', col_priority: 'p_p0', col_assignee: '王五' });
  next.columns.push({ id: 'col_estimate', key: 'estimate', name: '预估工时', type: 'number', width: 100 });
  if (next.rows[0]) next.rows[0].col_estimate = 8;
  seed(`${WORKSPACE}/任务看板.bitable`, serializeBitableDocument(next), 30);
  seedHistory(`${WORKSPACE}/任务看板.bitable`, [
    mockVersion(serializeBitableDocument(old), 60 * 24 * 5, 'initial'),
    mockVersion(serializeBitableDocument(next), 40),
  ]);
}

// 思维导图样例：节点改名、新增、删除子树、移动
{
  const node = (id: string, text: string, children: unknown[] = []) => ({ id, text, children });
  const oldTree = node('root', '产品路线图', [
    node('q1', '一季度', [node('q1a', '多端同步'), node('q1b', '备份恢复')]),
    node('q2', '二季度', [node('q2a', '插件市场'), node('q2b', '网页版')]),
    node('q3', '三季度', [node('q3a', '协作编辑', [node('q3a1', '实时光标')])]),
  ]);
  const newTree = node('root', '产品路线图', [
    node('q1', '一季度', [node('q1a', '多端同步'), node('q1b', '备份与恢复'), node('q2b', '网页版')]),
    node('q2', '二季度', [node('q2a', '插件市场'), node('q2c', '历史记录')]),
    node('q3', '三季度'),
  ]);
  const docOf = (root: unknown) => JSON.stringify({ version: 1, root, layout: 'right', theme: 'classic' }, null, 2);
  seed(`${WORKSPACE}/项目笔记/路线图.mindmap`, docOf(newTree), 20);
  seedHistory(`${WORKSPACE}/项目笔记/路线图.mindmap`, [
    mockVersion(docOf(oldTree), 60 * 24 * 2, 'initial'),
    mockVersion(docOf(newTree), 20, 'save', 'macbook', 'MacBook'),
  ]);
}

// 画板样例：移动并改文字的方框、新增方框、删除椭圆
{
  const base = { type: 'rectangle', angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
  const box = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ ...base, id, x, y, width: 180, height: 80, ...extra });
  const label = (id: string, container: string, x: number, y: number, text: string) => ({
    ...base, type: 'text', id, x, y, width: 120, height: 25, text, originalText: text, fontSize: 20, fontFamily: 5, textAlign: 'center', verticalAlign: 'middle', containerId: container, lineHeight: 1.25, autoResize: true,
  });
  const scene = (elements: unknown[]) => JSON.stringify({ type: 'excalidraw', version: 2, source: 'noteboard', elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} });
  const v1 = scene([
    box('front', 100, 100, { boundElements: [{ id: 'front-t', type: 'text' }] }), label('front-t', 'front', 130, 127, '前端'),
    box('api', 400, 100, { boundElements: [{ id: 'api-t', type: 'text' }] }), label('api-t', 'api', 430, 127, '接口服务'),
    box('cache', 400, 300, { type: 'ellipse', backgroundColor: '#ffc9c9' }),
  ]);
  const v2 = scene([
    box('front', 100, 100, { boundElements: [{ id: 'front-t', type: 'text' }], version: 5 }), label('front-t', 'front', 130, 127, '网页前端'),
    box('api', 460, 140, { boundElements: [{ id: 'api-t', type: 'text' }] }), label('api-t', 'api', 490, 167, '接口服务'),
    box('db', 460, 320, { backgroundColor: '#b2f2bb', boundElements: [{ id: 'db-t', type: 'text' }] }), label('db-t', 'db', 490, 347, '数据库'),
  ]);
  seed(`${WORKSPACE}/架构草图.excalidraw`, v2, 5);
  seedHistory(`${WORKSPACE}/架构草图.excalidraw`, [
    mockVersion(v1, 60 * 24, 'initial'),
    mockVersion(v2, 5),
  ]);
}

// Draw.io 样例：图形改文字、移动、新增与删除（明文页面）
{
  const cell = (id: string, value: string, x: number, y: number) =>
    `<mxCell id="${id}" value="${value}" style="rounded=1;whiteSpace=wrap;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="120" height="60" as="geometry"/></mxCell>`;
  const file = (cells: string) => `<mxfile host="NoteBoard"><diagram id="page1" name="部署图"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`;
  const v1 = file(cell('web', '网页', 40, 40) + cell('api', '接口', 240, 40) + cell('mq', '消息队列', 240, 160));
  const v2 = file(cell('web', '网页前端', 40, 40) + cell('api', '接口', 280, 60) + cell('db', '数据库', 280, 180));
  seed(`${WORKSPACE}/项目笔记/部署图.drawio`, v2, 8);
  seedHistory(`${WORKSPACE}/项目笔记/部署图.drawio`, [
    mockVersion(v1, 60 * 24 * 3, 'initial'),
    mockVersion(v2, 8),
  ]);
}

function mockHistoryList(path: string) {
  const list = mockHistories.get(path) ?? [];
  const entries = list.map((v, i) => ({
    id: v.id, start: v.at, at: v.at, hash: v.id, size: v.content.length, reason: v.reason,
    origin: { device: v.device, name: v.name }, stats: mockStats(list[i - 1]?.content, v.content),
    restoredFrom: v.restoredFrom, pinned: v.pinned, open: v.open, isOwn: v.device === MOCK_DEVICE,
  })).reverse();
  return { docId: list.length ? `doc-${nameOf(path)}` : null, kind: kindOf(nameOf(path)), deviceId: MOCK_DEVICE, entries };
}

let mockPendingRestore: { path: string; from: string } | null = null;

/** 模拟写盘后的记录：合并窗口内的连续保存只更新最后一版 */
function mockRecordWrite(path: string, content: string): void {
  if (mockHistoryMode === 'off' || kindOf(nameOf(path)) === 'preview') return;
  const list = mockHistories.get(path) ?? [];
  const last = list[list.length - 1];
  if (last?.content === content) return;
  const restore = mockPendingRestore?.path === path ? mockPendingRestore : null;
  mockPendingRestore = null;
  if (!restore && last?.open && last.reason === 'save' && Date.now() - last.at < mockHistoryWindow * 60_000) {
    last.content = content;
    last.at = Date.now();
  } else {
    if (last) last.open = false;
    const v = mockVersion(content, 0, restore ? 'restore' : 'save');
    v.at = Date.now();
    v.open = !restore;
    if (restore) v.restoredFrom = restore.from;
    list.push(v);
  }
  mockHistories.set(path, list);
}

function mockHistoryConfig() {
  return {
    mode: mockHistoryMode, retentionDays: mockHistoryRetention, mergeWindowMin: mockHistoryWindow, fullKeepDays: mockHistoryFullKeep, maxTotalMb: 0,
    effectiveMaxMb: 1024, syncAvailable: true, gitBackend: false,
  };
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function kindOf(name: string): string | null {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (['excalidraw', 'board', 'canvas'].includes(ext)) return 'board';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['mindmap', 'xmind'].includes(ext)) return 'mindmap';
  if (['bitable', 'table'].includes(ext)) return 'bitable';
  if (['doc','docx','xls','xlsx','ppt','pptx','pdf','dwg','dxf','epub'].includes(ext))return 'preview';
  if (['drawio', 'dio'].includes(ext)) return 'drawio';
  return 'code';
}

function languageOf(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md') return 'markdown';
  if (ext === 'json' || ext === 'excalidraw') return 'json';
  if (ext === 'sql') return 'sql';
  if (ext === 'html' || ext === 'htm') return 'html';
  return 'plaintext';
}

function listDir(path: string) {
  const children: unknown[] = [];
  for (const dir of dirs) {
    if (dir !== path && parentOf(dir) === path) {
      children.push({ path: dir, name: nameOf(dir), isDir: true, kind: null, size: null, mtime: null, isHidden: false, isSymlink: false });
    }
  }
  for (const [filePath, file] of files) {
    if (parentOf(filePath) === path) {
      const name = nameOf(filePath);
      children.push({ path: filePath, name, isDir: false, kind: kindOf(name), size: file.content.length, mtime: Math.floor(file.mtime / 1000), isHidden: false, isSymlink: false });
    }
  }
  return children;
}

function payloadOf(path: string) {
  const file = files.get(path);
  const name = nameOf(path);
  return {
    key: path,
    displayName: name,
    dirPath: parentOf(path),
    kind: kindOf(name),
    language: languageOf(name),
    content: file?.content ?? '',
    encoding: 'utf8',
    eol: 'lf',
    size: file?.content.length ?? 0,
    mtime: Math.floor((file?.mtime ?? now) / 1000),
    readonly: false,
  };
}

let listenerId = 0;

/** 安装模拟（必须在应用首次 invoke 之前调用） */
export function installTauriMock(): void {
  mockWindows('nb-main');
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    switch (cmd) {
      // 插件调试采用真实构建模块，模拟的仅为安装存储与本机文件选择。
      case 'plugin_command': return import('./pluginMock').then((m)=>m.mockPluginCommand(args));
      case 'read_preview_file': return fetch(`/test-results/plugin-fixtures/${nameOf(String(args.path))}`).then((r)=>{if(!r.ok)throw new Error('请先准备插件查看测试文件');return r.arrayBuffer();});
      case 'plugin:dialog|open': return `${WORKSPACE}/快捷笔记.bitable`;
      // ── 事件与插件 ──
      case 'plugin:event|listen':
      case 'plugin:app|register_listener':
        listenerId += 1;
        return listenerId;
      case 'plugin:event|unlisten':
      case 'plugin:event|emit':
      case 'plugin:event|emit_to':
      case 'plugin:app|remove_listener':
        return null;
      // ── 启动握手 ──
      case 'window_listeners_ready':
        return { protocolVersion: 1, consumerId: 'mock', startupMode: 'empty', transferId: null, queueVersion: 0 };
      case 'window_shell_ready':
      case 'ack_open_request':
      case 'set_document_dirty':
      case 'unregister_document':
      case 'save_settings':
      case 'save_favorites':
      case 'save_session':
      case 'clear_session':
      case 'push_recent':
      case 'record_web_spans':
      case 'delete_staged_file':
        return null;
      case 'list_incoming_transfers':
        // 浏览器开发没有跨原生窗口迁移，保持新握手接口返回空队列。
        return [];
      case 'list_open_requests':
      case 'stash_documents':
      case 'list_system_fonts':
      case 'take_incoming_files':
      case 'reconcile_documents':
        return [];
      case 'load_settings':
        throw new Error('mock：使用默认设置');
      case 'load_favorites':
        return { schemaVersion: 1, roots: [] };
      case 'load_session':
        return null;
      case 'is_perf_spans_enabled':
      case 'claim_tab_drop':
        return false;
      case 'get_font_pack_status':
      case 'refresh_font_pack_status':
        return { id: 'mock', version: '0', state: mockFontPackState, installedSizeBytes: 0, downloadSizeBytes: 0, downloadUrl: '', faces: [] };
      case 'remove_font_pack':
      case 'download_font_pack':
        // 字体包卸载与下载只切换样例状态，供设置页验证按钮与确认流程。
        mockFontPackState = cmd === 'remove_font_pack' ? 'missing' : 'ready';
        return { id: 'mock', version: '0', state: mockFontPackState, installedSizeBytes: 0, downloadSizeBytes: 0, downloadUrl: '', faces: [] };
      case 'check_for_updates':
        // URL 带 mockUpdate=1 时返回跨多个版本的更新样例（mockUpdate=single 为单个版本），否则模拟离线
        if (mockUpdateMode()) return mockUpdateResult();
        throw new Error('mock：离线');
      case 'get_default_staging_directory':
      case 'ensure_staging_directory':
        return `${WORKSPACE}/../staging`;
      // ── 平台 ──
      case 'get_platform_info':
        return { platform: 'android', isMobile: true, defaultWorkspace: WORKSPACE, externalRoot: EXTERNAL_ROOT, allFilesAccess: false };
      case 'ensure_default_workspace':
        return WORKSPACE;
      case 'request_all_files_access':
      case 'move_app_to_background':
      case 'set_system_bar_style':
      case 'share_file':
        return null;
      // ── 多端同步与备份（界面预览用样例数据） ──
      case 'sync_get_config':
      case 'sync_save_config':
        if (cmd === 'sync_save_config') mockSyncConfig = args.config as typeof mockSyncConfig;
        return mockSyncConfig;
      case 'sync_get_status':
        return {
          syncing: false,
          backingUp: false,
          lastSync: {
            at: now - 4 * 60_000, durationMs: 1800, trigger: 'interval', ok: true,
            upload: { added: 1, modified: 2, deleted: 0 }, download: { added: 0, modified: 1, deleted: 1 },
            merged: 1, conflicts: 0, errors: [], message: '同步完成 · 本机→云端：新增 1、修改 2 · 云端→本机：修改 1、删除 1 · 按行合并 1 个',
          },
          lastBackup: { at: now - 26 * 3600_000, ok: true, trigger: 'auto', name: 'NoteBoard-backup-mock.zip', size: 2_400_000, fileCount: 42, removedOld: 0, message: '备份完成：42 个文件（2.3 MB）' },
          nextSyncAt: now + 26 * 60_000,
          nextBackupAt: now + 3600_000,
        };
      case 'sync_test_connection':
        return '连接成功，远端已有同步数据，开启同步后将与本机双向合并';
      case 'sync_now':
      case 'sync_resolve_updates':
      case 'backup_now':
      case 'sync_trash_delete':
        return null;
      case 'sync_trash_empty':
        return 2;
      case 'sync_trash_list':
        return [
          { id: '.nb-trash/旧方案', name: '旧方案', isDir: true, origPath: '项目笔记/旧方案', trashedAt: now - 3 * 86_400_000, expiresAt: now + 27 * 86_400_000, size: 52_000, fileCount: 6 },
          { id: '.nb-trash/草稿.md', name: '草稿.md', isDir: false, origPath: '草稿.md', trashedAt: now - 28 * 86_400_000, expiresAt: now + 1.5 * 86_400_000, size: 1_200, fileCount: 1 },
        ];
      case 'sync_trash_restore':
        return `${WORKSPACE}/草稿 (1).md`;
      case 'backup_list':
        return [
          { name: 'NoteBoard-backup-20261010-090000-mock_PC-12345678.zip', size: 2_400_000, createdAt: now - 26 * 3600_000, device: 'mock_PC', isOwn: true },
          { name: 'NoteBoard-backup-20261009-090000-安卓设备-abcdef12.zip', size: 2_300_000, createdAt: now - 50 * 3600_000, device: '安卓设备', isOwn: false },
        ];
      case 'backup_restore':
        return '已恢复备份：写回 3 个文件，1 个备份之外的文件已移入回收站';
      case 'backup_delete':
        return null;
      // ── 文档历史记录 ──
      case 'history_get_config':
        return mockHistoryConfig();
      case 'history_set_mode':
        mockHistoryMode = String(args.mode);
        if (mockHistoryMode === 'off') mockHistories.clear();
        return mockHistoryConfig();
      case 'history_set_options': {
        const options = args.options as { retentionDays: number; mergeWindowMin: number; fullKeepDays: number };
        mockHistoryRetention = options.retentionDays;
        mockHistoryWindow = options.mergeWindowMin;
        mockHistoryFullKeep = options.fullKeepDays;
        return mockHistoryConfig();
      }
      case 'history_list':
        return mockHistoryMode === 'off' ? { docId: null, kind: 'code', deviceId: MOCK_DEVICE, entries: [] } : mockHistoryList(String(args.path));
      case 'history_read': {
        const version = mockHistories.get(String(args.path))?.find((v) => v.id === args.entryId);
        if (!version) throw new Error('版本不存在或已被清理');
        return { content: version.content, encoding: 'utf8', size: version.content.length };
      }
      case 'history_checkpoint': {
        const path = String(args.path);
        const list = mockHistories.get(path) ?? [];
        if (args.reason === 'close' || args.reason === 'before-restore') {
          const last = list[list.length - 1];
          if (last) last.open = false;
        }
        if (args.reason === 'before-restore' && typeof args.content === 'string' && list[list.length - 1]?.content !== args.content) {
          const v = mockVersion(args.content, 0, 'before-restore');
          v.at = Date.now();
          list.push(v);
          mockHistories.set(path, list);
        }
        if (args.reason === 'restore') mockPendingRestore = { path, from: String(args.restoredFrom) };
        return null;
      }
      case 'history_pin': {
        const version = mockHistories.get(String(args.path))?.find((v) => v.id === args.entryId);
        if (version) version.pinned = Boolean(args.pinned);
        return null;
      }
      case 'history_delete_entry': {
        const path = String(args.path);
        mockHistories.set(path, (mockHistories.get(path) ?? []).filter((v) => v.id !== args.entryId));
        return null;
      }
      case 'history_usage': {
        let entries = 0;
        let bytes = 0;
        for (const list of mockHistories.values()) {
          entries += list.length;
          bytes += list.reduce((n, v) => n + v.content.length * 3, 0);
        }
        return { bytes, docs: mockHistories.size, entries };
      }
      case 'history_clear_all':
        mockHistories.clear();
        return null;
      // ── 文件系统 ──
      case 'read_dir':
        return listDir(String(args.path));
      case 'register_document':
        return { type: 'ok' };
      case 'find_document_owner':
        return null;
      case 'prepare_document': {
        const path = String(args.path);
        if (dirs.has(path)) return { type: 'directory', path };
        return { type: 'text', payload: payloadOf(path) };
      }
      case 'read_document':
        return payloadOf(String(args.path));
      case 'read_xmind_file':
        // 开发替身只存文本，旧版 JSON 后缀样例仍按二进制接口返回；真实压缩包由工具栏上传测试。
        return new TextEncoder().encode(payloadOf(String(args.path)).content ?? '').buffer;
      case 'probe_document': {
        const path = String(args.path);
        return { exists: files.has(path), isDir:dirs.has(path), kind:kindOf(nameOf(path)), mtime: Math.floor((files.get(path)?.mtime ?? now) / 1000), size: files.get(path)?.content.length ?? 0 };
      }
      case 'path_exists': {
        const path = String(args.path);
        return { exists: files.has(path) || dirs.has(path), isDir: dirs.has(path) };
      }
      case 'write_document': {
        const path = String(args.path);
        files.set(path, { content: String(args.content ?? ''), mtime: Date.now() });
        mockRecordWrite(path, String(args.content ?? ''));
        return { ok: true, mtime: Math.floor(Date.now() / 1000), size: String(args.content ?? '').length, error: null };
      }
      case 'create_dir':
        dirs.add(`${String(args.dir)}/${String(args.name)}`);
        return null;
      case 'rename_path': {
        const from = String(args.from);
        const to = String(args.to);
        const file = files.get(from);
        if (file) {
          files.delete(from);
          files.set(to, file);
        } else if (dirs.has(from)) {
          dirs.delete(from);
          dirs.add(to);
        }
        return null;
      }
      // 插件 fs 读取文本文件（HTML 预览内联样式表等）
      case 'plugin:fs|read_file': {
        const file = files.get(String(args.path));
        if (!file) throw new Error(`文件不存在: ${String(args.path)}`);
        return new TextEncoder().encode(file.content).buffer;
      }
      case 'move_to_trash':
        files.delete(String(args.path));
        dirs.delete(String(args.path));
        return null;
      default:
        console.warn('[tauriMock] 未模拟的命令：', cmd, args);
        return null;
    }
  });
}
