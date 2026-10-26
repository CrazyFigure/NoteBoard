// NoteBoard 笔记索引（双链解析与补全的数据源）
// 设计：
// 1. 仓库根 = 当前文档所在的工作区根（桌面资源管理器根 / 移动端存储位置根），文档不在其中时退回文档所在目录。
// 2. 索引只在内存中按需构建（逐级 readDir），不落盘：多端同步、历史记录只看到 Markdown 原文，不会出现索引冲突。
// 3. 索引过期后先返回旧结果、后台重建（stale-while-revalidate），解析与补全不阻塞输入。
// 4. 窗口重新获得焦点、同步写入本机文件、资源管理器目录内容变化时标记过期；
//    同步后链接另一端尚未到达时只显示为「未找到」，文件到达后自动恢复为正常链接。

import * as ipc from '../../core/ipc/commands';
import type { DocumentKind, FileTreeNode } from '../../core/ipc/types';
import { useExplorerStore } from '../explorer/explorerStore';
import { basenameOf, dirnameOf, isSubPath, normalizePath, pathKey, PATH_SEP } from '../explorer/pathUtils';

/** 单次扫描的文件数上限（超出后停止扫描，索引标记为不完整） */
const MAX_INDEXED_FILES = 20000;
/** 单次扫描的目录数上限（防止误把磁盘根当作工作区时长时间扫描） */
const MAX_SCANNED_DIRS = 4000;
/** 并发读取目录数 */
const SCAN_CONCURRENCY = 6;
/** 同一仓库两次重建的最小间隔 */
const MIN_REBUILD_INTERVAL_MS = 3000;
/** 同时保留索引的仓库数 */
const MAX_CACHED_VAULTS = 3;
/** 扫描时跳过的目录（依赖与构建产物，不可能是笔记） */
const SKIPPED_DIR_NAMES = new Set(['node_modules', '__pycache__', 'target']);

/** 索引中的一个文件 */
export interface NoteEntry {
  /** 绝对路径 */
  path: string;
  /** 文件名（含扩展名） */
  name: string;
  /** 去掉扩展名的文件名 */
  stem: string;
  /** 小写扩展名（不含点） */
  ext: string;
  /** 相对仓库根的路径，统一用 `/` 分隔 */
  relPath: string;
  /** 所在目录 */
  dir: string;
  /** 是否 Markdown 笔记 */
  isMarkdown: boolean;
  kind: DocumentKind | null;
  mtime: number;
  size: number;
  /** 仓库外的文件（已打开的文档、按完整路径链接的文件）；relPath 为绝对路径 */
  external?: boolean;
}

/** 一个仓库的索引快照 */
export interface NoteIndexSnapshot {
  root: string;
  entries: NoteEntry[];
  /** 扫描是否因数量上限提前结束 */
  truncated: boolean;
  builtAt: number;
  /** 小写文件名 → 文件 */
  byName: Map<string, NoteEntry[]>;
  /** 小写 Markdown 文件名（不含扩展名）→ 文件 */
  byMarkdownStem: Map<string, NoteEntry[]>;
  /** 小写相对路径（含扩展名）→ 文件 */
  byRelPath: Map<string, NoteEntry>;
  /** 路径比较键 → 文件 */
  byPathKey: Map<string, NoteEntry>;
  /** 目录比较键 → 子项名称签名（用于判断资源管理器刷新是否带来增删） */
  dirSignatures: Map<string, string>;
}

/** 仓库索引状态 */
interface VaultState {
  root: string;
  snapshot: NoteIndexSnapshot | null;
  building: Promise<NoteIndexSnapshot> | null;
  stale: boolean;
  /** 重建期间再次过期，完成后需要再建一次 */
  dirtyWhileBuilding: boolean;
  lastBuildStartedAt: number;
  rebuildTimer: ReturnType<typeof setTimeout> | null;
}

const vaults = new Map<string, VaultState>();
const listeners = new Set<() => void>();
let indexVersion = 0;

/** 移动端等外壳提供的工作区根（返回 null 表示没有） */
type VaultRootProvider = () => string | null;
const rootProviders = new Set<VaultRootProvider>();

/** 注册工作区根来源（移动端存储位置根等）；返回注销函数 */
export function registerVaultRootProvider(provider: VaultRootProvider): () => void {
  rootProviders.add(provider);
  return () => {
    rootProviders.delete(provider);
  };
}

/** 订阅索引变化（重建完成后通知，节点据此重新解析） */
export function subscribeNoteIndex(listener: () => void): () => void {
  ensureInvalidationHooks();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 索引版本号（每次重建完成递增） */
export function getNoteIndexVersion(): number {
  return indexVersion;
}

/** 索引之外的解析结果变化（仓库外路径探测完成等）时，通知订阅者重新解析 */
export function notifyNoteIndexChanged(): void {
  notify();
}

function notify(): void {
  indexVersion += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[noteIndex] 通知订阅者失败:', error);
    }
  }
}

/**
 * 计算文档所属的仓库根。
 * 依次尝试外壳提供的根与资源管理器根，文档在其中即采用；否则退回文档所在目录。
 */
export function resolveVaultRoot(docPath: string | null | undefined): string | null {
  const candidates: string[] = [];
  for (const provider of rootProviders) {
    const root = provider();
    if (root) candidates.push(root);
  }
  const explorerRoot = useExplorerStore.getState().root;
  if (explorerRoot) candidates.push(explorerRoot);
  if (docPath) {
    for (const candidate of candidates) {
      if (isSubPath(candidate, docPath)) return normalizePath(candidate);
    }
    const dir = dirnameOf(docPath);
    return dir || null;
  }
  return candidates.length > 0 ? normalizePath(candidates[0]) : null;
}

/** 文件名拆分为主名与扩展名 */
function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
}

function isMarkdownExt(ext: string): boolean {
  return ext === 'md' || ext === 'markdown';
}

/** 目录子项名称签名：只关心可索引的文件与子目录 */
function childSignature(children: FileTreeNode[]): string {
  return children
    .filter((child) => isIndexableChild(child))
    .map((child) => `${child.isDir ? 'd' : 'f'}:${child.name}`)
    .sort()
    .join('\n');
}

function isIndexableChild(child: FileTreeNode): boolean {
  // 点开头的隐藏项（含 .git、同步回收站、历史记录目录）一律不进入索引
  if (child.isHidden || child.name.startsWith('.')) return false;
  if (child.isDir) return !SKIPPED_DIR_NAMES.has(child.name);
  return child.kind !== null && child.kind !== 'unsupported';
}

/** 把 `/` 分隔的相对路径拼到目录上（支持 `.` 与 `..`，不越过根） */
function joinRelativePath(dir: string, relative: string): string {
  const parts = normalizePath(dir).split(PATH_SEP).filter((part, index) => index === 0 || part);
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 1) parts.pop();
    } else {
      parts.push(part);
    }
  }
  return normalizePath(parts.join(PATH_SEP)) || PATH_SEP;
}

/** 相对仓库根的路径（`/` 分隔） */
function relativeTo(root: string, path: string): string {
  const normalizedRoot = normalizePath(root);
  const normalized = normalizePath(path);
  let rel = normalized.slice(normalizedRoot.length);
  rel = rel.replace(/^[\\/]+/, '');
  return PATH_SEP === '\\' ? rel.replace(/\\/g, '/') : rel;
}

function pushToBucket<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/** 逐级扫描仓库，构建索引快照 */
async function scanVault(root: string): Promise<NoteIndexSnapshot> {
  const entries: NoteEntry[] = [];
  const dirSignatures = new Map<string, string>();
  let scannedDirs = 0;
  let truncated = false;

  /** 读取单个目录，返回其子目录 */
  const scanDir = async (dir: string): Promise<string[]> => {
    if (entries.length >= MAX_INDEXED_FILES || scannedDirs >= MAX_SCANNED_DIRS) {
      truncated = true;
      return [];
    }
    scannedDirs += 1;
    let children: FileTreeNode[];
    try {
      children = await ipc.readDir(dir, false);
    } catch {
      // 目录不可读（权限、已删除）：跳过
      return [];
    }
    dirSignatures.set(pathKey(dir), childSignature(children));
    const subDirs: string[] = [];
    for (const child of children) {
      if (!isIndexableChild(child)) continue;
      if (child.isDir) {
        // 符号链接目录可能指回上层形成环，不跟随
        if (!child.isSymlink) subDirs.push(child.path);
        continue;
      }
      const { stem, ext } = splitName(child.name);
      entries.push({
        path: child.path,
        name: child.name,
        stem,
        ext,
        relPath: relativeTo(root, child.path),
        dir: normalizePath(dir),
        isMarkdown: isMarkdownExt(ext),
        kind: child.kind,
        mtime: child.mtime ?? 0,
        size: child.size ?? 0,
      });
    }
    return subDirs;
  };

  // 按层广度优先扫描：同一层的目录有界并发读取，浅层笔记优先进入索引
  let level = [normalizePath(root)];
  while (level.length > 0 && !truncated) {
    const nextLevel: string[] = [];
    for (let start = 0; start < level.length && !truncated; start += SCAN_CONCURRENCY) {
      const batch = level.slice(start, start + SCAN_CONCURRENCY);
      const results = await Promise.all(batch.map(scanDir));
      for (const subDirs of results) nextLevel.push(...subDirs);
    }
    level = nextLevel;
  }

  return buildSnapshot(root, entries, truncated, dirSignatures);
}

/** 文件被移动 / 重命名后的新条目（沿用修改时间等元数据，用于不重新扫描地推演改名后的索引） */
export function rebaseEntry(root: string, entry: NoteEntry, newPath: string): NoteEntry {
  const normalized = normalizePath(newPath);
  const name = basenameOf(normalized);
  const { stem, ext } = splitName(name);
  return {
    ...entry,
    path: normalized,
    name,
    stem,
    ext,
    relPath: relativeTo(root, normalized),
    dir: dirnameOf(normalized),
    isMarkdown: isMarkdownExt(ext),
  };
}

/** 由文件列表构建快照及各查找表 */
export function buildSnapshot(
  root: string,
  entries: NoteEntry[],
  truncated = false,
  dirSignatures = new Map<string, string>(),
): NoteIndexSnapshot {
  const byName = new Map<string, NoteEntry[]>();
  const byMarkdownStem = new Map<string, NoteEntry[]>();
  const byRelPath = new Map<string, NoteEntry>();
  const byPathKey = new Map<string, NoteEntry>();
  for (const entry of entries) {
    pushToBucket(byName, entry.name.toLowerCase(), entry);
    if (entry.isMarkdown) pushToBucket(byMarkdownStem, entry.stem.toLowerCase(), entry);
    byRelPath.set(entry.relPath.toLowerCase(), entry);
    byPathKey.set(pathKey(entry.path), entry);
  }
  return {
    root: normalizePath(root),
    entries,
    truncated,
    builtAt: Date.now(),
    byName,
    byMarkdownStem,
    byRelPath,
    byPathKey,
    dirSignatures,
  };
}

/** 取得仓库状态（不存在则创建，并淘汰最久未用的仓库） */
function vaultState(root: string): VaultState {
  const key = pathKey(root);
  let state = vaults.get(key);
  if (state) {
    // 重新插入以维持最近使用顺序
    vaults.delete(key);
    vaults.set(key, state);
    return state;
  }
  state = {
    root: normalizePath(root),
    snapshot: null,
    building: null,
    stale: true,
    dirtyWhileBuilding: false,
    lastBuildStartedAt: 0,
    rebuildTimer: null,
  };
  vaults.set(key, state);
  while (vaults.size > MAX_CACHED_VAULTS) {
    const oldestKey = vaults.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = vaults.get(oldestKey);
    if (oldest?.rebuildTimer) clearTimeout(oldest.rebuildTimer);
    vaults.delete(oldestKey);
  }
  return state;
}

/** 立即启动一次重建（已在重建中则复用） */
function startBuild(state: VaultState): Promise<NoteIndexSnapshot> {
  if (state.building) {
    return state.building;
  }
  state.stale = false;
  state.dirtyWhileBuilding = false;
  state.lastBuildStartedAt = Date.now();
  const previousSignature = state.snapshot ? snapshotSignature(state.snapshot) : null;
  let changed = true;
  const building = scanVault(state.root)
    .then((snapshot) => {
      // 文件集合与修改时间都没变时沿用旧快照：不通知订阅者，避免所有链接与嵌入无谓地重新解析、重绘
      if (previousSignature !== null && previousSignature === snapshotSignature(snapshot) && state.snapshot) {
        changed = false;
        state.snapshot.builtAt = snapshot.builtAt;
        return state.snapshot;
      }
      state.snapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      state.building = null;
      if (changed) notify();
      // 重建期间又有变化：按节流间隔再建一次
      if (state.dirtyWhileBuilding) scheduleRebuild(state);
    });
  state.building = building;
  return building;
}

/** 按最小间隔安排一次后台重建 */
function scheduleRebuild(state: VaultState): void {
  state.stale = true;
  if (state.building) {
    state.dirtyWhileBuilding = true;
    return;
  }
  if (state.rebuildTimer) return;
  const wait = Math.max(0, state.lastBuildStartedAt + MIN_REBUILD_INTERVAL_MS - Date.now());
  state.rebuildTimer = setTimeout(() => {
    state.rebuildTimer = null;
    if (vaults.get(pathKey(state.root)) !== state) return;
    void startBuild(state).catch(() => {});
  }, wait);
}

/**
 * 同步读取仓库索引：返回当前可用快照（可能已过期或为空），必要时在后台构建。
 * 解析链接、显示样式等不能等待的场景使用。
 */
export function peekNoteIndex(root: string): NoteIndexSnapshot | null {
  ensureInvalidationHooks();
  const state = vaultState(root);
  if (!state.snapshot && !state.building) {
    void startBuild(state).catch(() => {});
  } else if (state.stale) {
    scheduleRebuild(state);
  }
  return state.snapshot;
}

/**
 * 异步读取仓库索引。
 * fresh=true 时要求不早于本次调用前 MIN_REBUILD_INTERVAL_MS 的结果（点击未找到的链接时重试用）。
 */
export async function loadNoteIndex(root: string, options?: { fresh?: boolean }): Promise<NoteIndexSnapshot> {
  ensureInvalidationHooks();
  const state = vaultState(root);
  if (state.building) return state.building;
  const tooOld = options?.fresh && (!state.snapshot || Date.now() - state.snapshot.builtAt > MIN_REBUILD_INTERVAL_MS);
  if (!state.snapshot || tooOld) return startBuild(state);
  if (state.stale) scheduleRebuild(state);
  return state.snapshot;
}

/** 快照签名：文件路径、修改时间与大小（判断重建结果是否有变化） */
function snapshotSignature(snapshot: NoteIndexSnapshot): string {
  let signature = `${snapshot.entries.length}`;
  for (const entry of snapshot.entries) signature += `\n${entry.path}\t${entry.mtime}\t${entry.size}`;
  return signature;
}

/** 切回窗口触发的重建最小间隔：频繁切换窗口时不反复扫描整个仓库 */
const FOCUS_REBUILD_MIN_AGE_MS = 30000;

/**
 * 标记全部仓库索引过期（后台按节流重建）。
 * minAge：快照建立不足该时长时跳过（切回窗口等低价值触发使用）。
 */
export function invalidateNoteIndex(options?: { minAge?: number }): void {
  const minAge = options?.minAge ?? 0;
  for (const state of vaults.values()) {
    if (minAge > 0 && state.snapshot && Date.now() - state.snapshot.builtAt < minAge) continue;
    scheduleRebuild(state);
  }
}

/** 切回窗口 / 回到前台时调用：距上次扫描较久才重建 */
export function invalidateNoteIndexOnFocus(): void {
  invalidateNoteIndex({ minAge: FOCUS_REBUILD_MIN_AGE_MS });
}

// ── 过期触发 ──

let hooksInstalled = false;

/** 安装过期触发器（首次使用索引时安装，进程内只安装一次） */
function ensureInvalidationHooks(): void {
  if (hooksInstalled || typeof window === 'undefined') return;
  hooksInstalled = true;

  // 切回窗口时其它软件或同步可能已改动文件
  window.addEventListener('focus', () => invalidateNoteIndexOnFocus());

  // 同步写入本机文件后重建：链接另一端到达后自动恢复为可用链接
  void import('../../core/ipc/events')
    .then(({ onSyncApplied }) => onSyncApplied(() => invalidateNoteIndex()))
    .catch(() => {
      // 无同步事件通道的环境（单元测试等）忽略
    });

  // 资源管理器刷新目录：有增删才重建，只是修改时间变化则就地更新
  useExplorerStore.subscribe((next, previous) => {
    if (next.children === previous.children) return;
    for (const [dirKey, children] of next.children) {
      if (previous.children.get(dirKey) === children) continue;
      applyDirectoryRefresh(dirKey, children);
    }
  });
}

/** 资源管理器拿到某目录的新子项后，同步到包含该目录的仓库索引 */
function applyDirectoryRefresh(dirKey: string, children: FileTreeNode[]): void {
  for (const state of vaults.values()) {
    const snapshot = state.snapshot;
    if (!snapshot || !isSubPath(snapshot.root, dirKey)) continue;
    const previous = snapshot.dirSignatures.get(dirKey);
    // 未扫描过的目录（扫描上限之外或新建目录）不做判断，交给下一次整体重建
    if (previous === undefined) continue;
    if (previous !== childSignature(children)) {
      scheduleRebuild(state);
      continue;
    }
    // 子项未增删：更新修改时间与大小（反向链接据此判断是否需要重新读取）
    for (const child of children) {
      if (child.isDir) continue;
      const entry = snapshot.byPathKey.get(pathKey(child.path));
      if (!entry) continue;
      entry.mtime = child.mtime ?? entry.mtime;
      entry.size = child.size ?? entry.size;
    }
  }
}

// ── 解析 ──

/** 候选排序：与来源同目录优先，其次路径更短，最后按路径字母序 */
function pickBest(candidates: NoteEntry[], fromPath: string | null): NoteEntry | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const fromDirKey = fromPath ? pathKey(dirnameOf(fromPath)) : '';
  return [...candidates].sort((left, right) => {
    const leftSame = pathKey(left.dir) === fromDirKey ? 0 : 1;
    const rightSame = pathKey(right.dir) === fromDirKey ? 0 : 1;
    if (leftSame !== rightSame) return leftSame - rightSame;
    const depth = left.relPath.split('/').length - right.relPath.split('/').length;
    if (depth !== 0) return depth;
    return left.relPath.localeCompare(right.relPath);
  })[0];
}

/**
 * 把双链目标解析为索引中的文件（与 Obsidian 规则一致，大小写不敏感）：
 * - 只写名称：先按完整文件名（带扩展名的写法），再按 Markdown 主名匹配，重名时同目录优先、路径短优先；
 * - 写了目录：依次尝试相对仓库根、相对当前文档、路径后缀匹配，均可省略 `.md`。
 */
export function resolveWikiTarget(
  snapshot: NoteIndexSnapshot,
  target: string,
  fromPath: string | null,
): NoteEntry | null {
  // 完整路径（C:/笔记/a、/storage/.../a）：直接按路径查找；POSIX 的 `/a` 同时可能是仓库根相对写法，查不到再往下走
  if (isAbsoluteNotePath(target)) {
    const absolute = normalizePath(target.trim());
    const found = snapshot.byPathKey.get(pathKey(absolute)) ?? snapshot.byPathKey.get(pathKey(`${absolute}.md`));
    if (found || PATH_SEP === '\\') return found ?? null;
  }
  const cleaned = target.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();

  if (!lower.includes('/')) {
    const byName = snapshot.byName.get(lower);
    if (byName?.length) return pickBest(byName, fromPath);
    return pickBest(snapshot.byMarkdownStem.get(lower) ?? [], fromPath);
  }

  // 1. 相对仓库根
  const fromRoot = snapshot.byRelPath.get(lower) ?? snapshot.byRelPath.get(`${lower}.md`);
  if (fromRoot) return fromRoot;

  // 2. 相对当前文档目录（支持 ../ 写法）
  if (fromPath) {
    const absolute = joinRelativePath(dirnameOf(fromPath), cleaned);
    const relative = snapshot.byPathKey.get(pathKey(absolute)) ?? snapshot.byPathKey.get(pathKey(`${absolute}.md`));
    if (relative) return relative;
  }

  // 3. 路径后缀匹配（目标只写了部分目录）
  const suffixes = [`/${lower}`, `/${lower}.md`];
  const matches = snapshot.entries.filter((entry) => {
    const rel = entry.relPath.toLowerCase();
    return suffixes.some((suffix) => rel.endsWith(suffix));
  });
  return pickBest(matches, fromPath);
}

/**
 * 为选中的文件生成最短可用的链接目标：
 * Markdown 主名在仓库内唯一时只写主名，否则写相对仓库根的路径（省略 .md）；其它文件保留扩展名。
 */
export function shortestLinkTarget(snapshot: NoteIndexSnapshot, entry: NoteEntry): string {
  if (entry.isMarkdown) {
    const sameStem = snapshot.byMarkdownStem.get(entry.stem.toLowerCase()) ?? [];
    const sameName = snapshot.byName.get(entry.stem.toLowerCase()) ?? [];
    if (sameStem.length <= 1 && sameName.length === 0) return entry.stem;
    return entry.relPath.replace(/\.(md|markdown)$/i, '');
  }
  const sameName = snapshot.byName.get(entry.name.toLowerCase()) ?? [];
  return sameName.length <= 1 ? entry.name : entry.relPath;
}

// ── 仓库外的文件 ──

/** 是否为完整路径写法（Windows 盘符路径或 POSIX 根路径） */
export function isAbsoluteNotePath(target: string): boolean {
  const trimmed = target.trim();
  return PATH_SEP === '\\' ? /^[a-zA-Z]:[\\/]/.test(trimmed) : trimmed.startsWith('/');
}

/** 由绝对路径构造仓库外条目（relPath 存放 `/` 分隔的完整路径，用于显示与匹配） */
export function createExternalEntry(path: string, mtime = 0, size = 0): NoteEntry {
  const normalized = normalizePath(path);
  const name = basenameOf(normalized);
  const { stem, ext } = splitName(name);
  return {
    path: normalized,
    name,
    stem,
    ext,
    relPath: normalized.replace(/\\/g, '/'),
    dir: dirnameOf(normalized),
    isMarkdown: isMarkdownExt(ext),
    kind: isMarkdownExt(ext) ? 'markdown' : null,
    mtime,
    size,
    external: true,
  };
}

/** 双链目标对应的候选绝对路径（完整路径原样，其余相对当前文档目录）；只写名称时返回 null */
export function absoluteTargetPath(target: string, fromPath: string | null): string | null {
  const trimmed = target.trim();
  if (isAbsoluteNotePath(trimmed)) return normalizePath(trimmed);
  if (!/[\\/]/.test(trimmed) || !fromPath) return null;
  return joinRelativePath(dirnameOf(fromPath), trimmed.replace(/\\/g, '/'));
}

/** 在仓库外条目（已打开的文档等）中解析目标：只写名称按文件名 / 主名匹配，写了路径按绝对路径匹配 */
export function resolveAmongEntries(entries: NoteEntry[], target: string, fromPath: string | null): NoteEntry | null {
  const absolute = absoluteTargetPath(target, fromPath);
  if (absolute) {
    const keys = [pathKey(absolute), pathKey(`${absolute}.md`)];
    return entries.find((entry) => keys.includes(pathKey(entry.path))) ?? null;
  }
  const lower = target.trim().toLowerCase();
  if (!lower) return null;
  const byName = entries.filter((entry) => entry.name.toLowerCase() === lower);
  if (byName.length) return pickBest(byName, fromPath);
  return pickBest(entries.filter((entry) => entry.isMarkdown && entry.stem.toLowerCase() === lower), fromPath);
}

/** 两个路径的相对写法（`../a/b.md`，`/` 分隔）；不在同一盘符等无法相对时返回 null */
export function relativePathBetween(fromDir: string, toPath: string): string | null {
  const split = (path: string) => normalizePath(path).split(PATH_SEP).filter((part, index) => index === 0 || part);
  const from = split(fromDir);
  const to = split(toPath);
  const same = (left: string, right: string) => (PATH_SEP === '\\' ? left.toLowerCase() === right.toLowerCase() : left === right);
  if (!from.length || !to.length || !same(from[0], to[0])) return null;
  let common = 0;
  while (common < from.length && common < to.length && same(from[common], to[common])) common += 1;
  const ups = from.length - common;
  const rest = to.slice(common);
  const parts = [...Array(ups).fill('..'), ...rest];
  return parts.join('/');
}

/**
 * 选中补全项后写入的链接目标：仓库内的文件用最短写法；
 * 仓库外的文件写相对当前文档的路径（同步到其它设备后仍成立），无法相对时写完整路径。Markdown 省略扩展名。
 */
export function linkTargetFor(snapshot: NoteIndexSnapshot | null, entry: NoteEntry, fromPath: string | null): string {
  if (!entry.external && snapshot) return shortestLinkTarget(snapshot, entry);
  const stripExt = (value: string) => (entry.isMarkdown ? value.replace(/\.(md|markdown)$/i, '') : value);
  const relative = fromPath ? relativePathBetween(dirnameOf(fromPath), entry.path) : null;
  if (relative) return stripExt(relative.includes('/') ? relative : `./${relative}`);
  return stripExt(entry.path.replace(/\\/g, '/'));
}

// ── 补全搜索 ──

/** 子序列匹配（`wjj` 命中 `weekly-journal-jan`） */
function isSubsequence(query: string, text: string): boolean {
  let index = 0;
  for (const char of text) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return false;
}

/** 匹配用的小写字段缓存：逐字搜索时不必为每个文件反复转换大小写 */
const loweredFields = new WeakMap<NoteEntry, { stem: string; name: string; rel: string; dirKey: string }>();

function lowered(entry: NoteEntry): { stem: string; name: string; rel: string; dirKey: string } {
  let fields = loweredFields.get(entry);
  if (!fields) {
    fields = { stem: entry.stem.toLowerCase(), name: entry.name.toLowerCase(), rel: entry.relPath.toLowerCase(), dirKey: pathKey(entry.dir) };
    loweredFields.set(entry, fields);
  }
  return fields;
}

function scoreEntry(entry: NoteEntry, query: string): number {
  if (!query) return 1;
  const { stem, name, rel } = lowered(entry);
  if (stem === query || name === query) return 100;
  if (stem.startsWith(query)) return 80;
  if (stem.includes(query)) return 60;
  if (rel.includes(query)) return 40;
  if (isSubsequence(query, stem)) return 20;
  return 0;
}

/**
 * 补全候选：按匹配程度、是否 Markdown、是否同目录、最近修改排序。
 * 空查询时列出最近修改的笔记。
 */
export function searchNotes(
  snapshot: NoteIndexSnapshot | null,
  query: string,
  fromPath: string | null,
  limit = 50,
  extras: NoteEntry[] = [],
): NoteEntry[] {
  const normalizedQuery = query.trim().toLowerCase().replace(/\\/g, '/');
  const fromKey = fromPath ? pathKey(fromPath) : '';
  const fromDirKey = fromPath ? pathKey(dirnameOf(fromPath)) : '';
  const scored: Array<{ entry: NoteEntry; score: number }> = [];
  // 仓库外的条目（已打开的文档）只补充索引里没有的，且排除当前文档自身
  const extraEntries = extras.filter((entry) => {
    const key = pathKey(entry.path);
    return key !== fromKey && !snapshot?.byPathKey.has(key);
  });
  // 当前文档在索引中的条目按引用排除，避免逐个规范化路径比较
  const selfEntry = fromKey ? snapshot?.byPathKey.get(fromKey) : undefined;
  for (const entry of [...(snapshot?.entries ?? []), ...extraEntries]) {
    // 链接到自身没有意义（标题跳转用 [[#标题]]）
    if (entry === selfEntry) continue;
    // 图片等资源只在明确搜索时出现，空查询只列笔记
    if (!normalizedQuery && !entry.isMarkdown) continue;
    let score = scoreEntry(entry, normalizedQuery);
    if (score <= 0) continue;
    if (entry.isMarkdown) score += 5;
    if (lowered(entry).dirKey === fromDirKey) score += 3;
    scored.push({ entry, score });
  }
  scored.sort((left, right) =>
    right.score - left.score
    || right.entry.mtime - left.entry.mtime
    || left.entry.relPath.length - right.entry.relPath.length);
  return scored.slice(0, limit).map((item) => item.entry);
}

/** 路径对应的笔记名（去掉目录与扩展名） */
export function noteBaseName(path: string): string {
  return splitName(basenameOf(path)).stem;
}

/** 仅测试：清空全部索引状态 */
export function resetNoteIndexForTest(): void {
  for (const state of vaults.values()) {
    if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
  }
  vaults.clear();
  rootProviders.clear();
  indexVersion = 0;
}
