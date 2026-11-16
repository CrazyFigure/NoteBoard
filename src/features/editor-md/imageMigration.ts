// NoteBoard 整理现有图片：在「文档同级目录」与「统一目录」之间迁移图片并改写引用
// 范围：扫描根目录（同步文件夹、当前打开的文件夹）下的全部 Markdown 文档；只处理应用自身管理的图片：
//  - 同级 → 统一：位于 `<文档目录>/<目录名>/` 或旧统一目录下的图片，移动到统一目录（同一张图只移动一次）；
//    更换统一目录位置（含开启同步 / 备份后移入同步文件夹）也走这一方向，旧统一目录作为来源
//  - 统一 → 同级：位于统一目录（及旧统一目录）下的图片，复制（仅一个目录引用时直接移动）到各文档的同级目录
// 两种模式共用同一个目录名：统一目录位置下的文档，其同级目录就是统一目录，引用保持不动。
// 同名冲突先比较内容：完全相同直接复用（去重），不同则追加 `_1` 等后缀。
// 执行顺序：文件操作 → 改写文档（只改写文件操作成功的引用）→ 回收多余源文件 → 清理搬空的目录；
// 任何一步失败都不影响其他文件，未改写的引用仍指向原文件，保证不会出现断图。

import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { basenameOf, dirnameOf, isSubPath, joinPath, normalizePath, pathKey, relativePathBetween } from '../explorer/pathUtils';
import { resolveRelativeDocPath } from './linkHandler';
import { siblingImageDir } from './imageStorage';
import { rewriteImageRefs, scanImageRefs } from './imageRefs';

/** 迁移方向 */
export type MigrationDirection = 'toGlobal' | 'toSibling';

/** 迁移参数 */
export interface MigrationOptions {
  direction: MigrationDirection;
  /** 扫描这些目录下的全部 Markdown 文档（互相包含时只扫描外层） */
  scanRoots: string[];
  /** 图片目录名称（同级与统一两种模式共用） */
  imageDirName: string | undefined;
  /** 统一目录：同级 → 统一时为目标，统一 → 同级时为来源 */
  globalDir: string;
  /** 旧统一目录（更换位置前的目录），其中的图片同样视为来源 */
  legacyGlobalDirs?: string[];
}

/** 规划阶段使用的只读文件访问（测试可替换为内存实现） */
export interface MigrationReadFs {
  /** 递归列出目录下全部 Markdown 文档 */
  listMarkdownFiles(root: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  readBytes(path: string): Promise<Uint8Array>;
  /** 文档是否已打开且有未保存修改 */
  isDirtyOpenDocument(path: string): boolean;
}

/** 一个文件操作 */
export interface MigrationFileOp {
  id: number;
  /** move：移动；copy：复制；reuse：目标已有相同内容，无需写入 */
  kind: 'move' | 'copy' | 'reuse';
  from: string;
  to: string;
  /** reuse 复用另一个计划中操作的产物时，依赖该操作成功 */
  dependsOn?: number;
}

/** 一篇文档中的一处地址改写 */
export interface MigrationRefChange {
  oldSrc: string;
  newSrc: string;
  opId: number;
}

/** 执行后需要回收的源文件 */
export interface MigrationTrashItem {
  path: string;
  /** 产生该源文件副本的操作，全部成功才回收 */
  opIds: number[];
  /** 引用该源文件的文档，全部改写成功才回收 */
  docs: string[];
}

/** 跳过的引用 */
export interface MigrationSkip {
  doc: string;
  src: string;
  reason: string;
}

/** 迁移计划 */
export interface MigrationPlan {
  options: MigrationOptions;
  /** 统一目录 */
  globalDir: string;
  docs: Array<{ path: string; changes: MigrationRefChange[] }>;
  ops: MigrationFileOp[];
  trash: MigrationTrashItem[];
  skipped: MigrationSkip[];
  /** 迁移后可能变空、需要清理的旧目录 */
  emptyDirCandidates: string[];
  stats: {
    /** 扫描的文档数 */
    scannedDocs: number;
    /** 需要改写的文档数 */
    docs: number;
    /** 涉及的图片数（去重后的源文件） */
    images: number;
    /** 需要改写的引用数 */
    refs: number;
    /** 同名且内容不同、追加了后缀的数量 */
    renamed: number;
    /** 目标已有相同内容、直接复用的数量 */
    deduped: number;
  };
}

/** 进度回调 */
export type MigrationProgress = (done: number, total: number, label: string) => void;

/** 生成文档引用图片的相对路径（`./` 或 `../` 开头）；无法相对时退回 `/` 分隔的绝对路径 */
export function linkPathFor(docDir: string, target: string): string {
  const relative = relativePathBetween(docDir, target);
  if (relative === null) return normalizePath(target).replace(/\\/g, '/');
  return relative.startsWith('..') ? relative : `./${relative}`;
}

/** 拆分文件名为主名与扩展名（含点） */
function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

/** 比较两段字节是否完全相同 */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** 规划期间的文件状态缓存：避免同一路径重复读盘 */
class PlanningCache {
  private existsCache = new Map<string, Promise<boolean>>();
  private bytesCache = new Map<string, Promise<Uint8Array | null>>();

  constructor(private fs: MigrationReadFs) {}

  exists(path: string): Promise<boolean> {
    const key = pathKey(path);
    let cached = this.existsCache.get(key);
    if (!cached) {
      cached = this.fs.exists(path).catch(() => false);
      this.existsCache.set(key, cached);
    }
    return cached;
  }

  bytes(path: string): Promise<Uint8Array | null> {
    const key = pathKey(path);
    let cached = this.bytesCache.get(key);
    if (!cached) {
      cached = this.fs.readBytes(path).catch(() => null);
      this.bytesCache.set(key, cached);
    }
    return cached;
  }

  async sameContent(left: string, right: string): Promise<boolean> {
    const [a, b] = await Promise.all([this.bytes(left), this.bytes(right)]);
    return !!a && !!b && sameBytes(a, b);
  }
}

/** 去掉互相包含的扫描根目录，只保留最外层，避免同一文档被扫描两次 */
export function outermostRoots(roots: Array<string | null | undefined>): string[] {
  const normalized = roots.map((root) => normalizePath(root?.trim())).filter((root): root is string => !!root);
  const result: string[] = [];
  for (const root of normalized) {
    if (normalized.some((other) => pathKey(other) !== pathKey(root) && isSubPath(other, root))) continue;
    if (result.some((kept) => pathKey(kept) === pathKey(root))) continue;
    result.push(root);
  }
  return result;
}

/** 路径位于目录内部（不含目录本身） */
function isInside(dir: string, path: string): boolean {
  return isSubPath(dir, path) && pathKey(dir) !== pathKey(path);
}

/** 一处待迁移的引用 */
interface Candidate {
  doc: string;
  docDir: string;
  oldSrc: string;
  source: string;
  /** 该引用应迁往的目录 */
  targetDir: string;
}

/**
 * 生成迁移计划（只读，不改动任何文件）。
 * 同级 → 统一时 targetDir 为统一目录；统一 → 同级时为各文档自己的同级目录。
 */
export async function planImageMigration(
  options: MigrationOptions,
  fs: MigrationReadFs,
  onProgress?: MigrationProgress,
): Promise<MigrationPlan> {
  const globalDir = normalizePath(options.globalDir?.trim());
  // 旧统一目录：与新目录相同的不算来源
  const legacyDirs = (options.legacyGlobalDirs ?? [])
    .map((dir) => normalizePath(dir?.trim()))
    .filter((dir) => dir && pathKey(dir) !== pathKey(globalDir));
  const scanRoots = outermostRoots(options.scanRoots);
  const plan: MigrationPlan = {
    options,
    globalDir,
    docs: [],
    ops: [],
    trash: [],
    skipped: [],
    emptyDirCandidates: [],
    stats: { scannedDocs: 0, docs: 0, images: 0, refs: 0, renamed: 0, deduped: 0 },
  };
  if (!scanRoots.length || !globalDir) return plan;

  const cache = new PlanningCache(fs);
  // 汇总各扫描根目录下的文档（按路径去重）
  const docPaths: string[] = [];
  const seenDocs = new Set<string>();
  for (const root of scanRoots) {
    for (const doc of await fs.listMarkdownFiles(root)) {
      const key = pathKey(doc);
      if (seenDocs.has(key)) continue;
      seenDocs.add(key);
      docPaths.push(doc);
    }
  }
  plan.stats.scannedDocs = docPaths.length;

  // 1. 扫描全部文档，按源文件汇总全部本地引用（同一文档内同一地址只记一次）。
  //    源文件一旦移动，其他文档以任何写法引用它的地址都必须一起改写，否则会断图。
  const refsBySource = new Map<string, { source: string; managed: boolean; refs: Array<{ doc: string; docDir: string; oldSrc: string }> }>();
  for (let index = 0; index < docPaths.length; index += 1) {
    const doc = docPaths[index];
    onProgress?.(index, docPaths.length, basenameOf(doc));
    let text: string;
    try {
      text = await fs.readText(doc);
    } catch {
      plan.skipped.push({ doc, src: '', reason: '文档读取失败' });
      continue;
    }
    const docDir = dirnameOf(doc);
    const siblingDir = siblingImageDir(docDir, options.imageDirName);
    const seen = new Set<string>();
    for (const ref of scanImageRefs(text)) {
      if (seen.has(ref.src)) continue;
      seen.add(ref.src);
      const source = normalizePath(resolveRelativeDocPath(docDir, ref.src));
      if (!source) continue;
      const sourceKey = pathKey(source);
      let entry = refsBySource.get(sourceKey);
      if (!entry) {
        entry = { source, managed: false, refs: [] };
        refsBySource.set(sourceKey, entry);
      }
      entry.refs.push({ doc, docDir, oldSrc: ref.src });
      // 是否为本次需要迁移的图片
      const inLegacy = legacyDirs.some((dir) => isInside(dir, source));
      if (options.direction === 'toGlobal') {
        // 同级图片目录或旧统一目录内、且不在统一目录内的图片
        if ((isInside(siblingDir, source) || inLegacy) && !isSubPath(globalDir, source)) entry.managed = true;
      } else if (isInside(globalDir, source) || inLegacy) {
        entry.managed = true;
      }
    }
  }
  onProgress?.(docPaths.length, docPaths.length, '');

  // 引用它的任一文档有未保存修改时，整张图片跳过，避免只改写一部分引用
  const candidates: Candidate[] = [];
  for (const entry of refsBySource.values()) {
    if (!entry.managed) continue;
    const dirtyDoc = entry.refs.find((ref) => fs.isDirtyOpenDocument(ref.doc));
    if (dirtyDoc) {
      for (const ref of entry.refs) {
        plan.skipped.push({ doc: ref.doc, src: ref.oldSrc, reason: `引用该图片的文档「${basenameOf(dirtyDoc.doc)}」有未保存的修改，请先保存` });
      }
      continue;
    }
    for (const ref of entry.refs) {
      const targetDir = options.direction === 'toGlobal' ? globalDir : siblingImageDir(ref.docDir, options.imageDirName);
      candidates.push({ ...ref, source: entry.source, targetDir });
    }
  }

  // 2. 校验源文件存在
  const available: Candidate[] = [];
  for (const candidate of candidates) {
    if (await cache.exists(candidate.source)) available.push(candidate);
    else plan.skipped.push({ doc: candidate.doc, src: candidate.oldSrc, reason: '图片文件不存在' });
  }

  // 3. 按「源文件 → 目标目录」分组
  const bySource = new Map<string, { source: string; groups: Map<string, { dir: string; refs: Candidate[] }> }>();
  for (const candidate of available) {
    const sourceKey = pathKey(candidate.source);
    let entry = bySource.get(sourceKey);
    if (!entry) {
      entry = { source: candidate.source, groups: new Map() };
      bySource.set(sourceKey, entry);
    }
    const dirKey = pathKey(candidate.targetDir);
    let group = entry.groups.get(dirKey);
    if (!group) {
      group = { dir: candidate.targetDir, refs: [] };
      entry.groups.set(dirKey, group);
    }
    group.refs.push(candidate);
  }
  plan.stats.images = bySource.size;

  // 已规划的目标：路径比较键 → 产生该目标的操作（用于计划内去重与避让）
  const plannedTargets = new Map<string, MigrationFileOp>();
  const docChanges = new Map<string, MigrationRefChange[]>();
  const emptyDirs = new Map<string, string>();
  let nextId = 1;

  /** 为源文件在目标目录中分配文件名：相同内容复用，不同内容追加后缀 */
  const allocate = async (dir: string, source: string): Promise<{ path: string; reuseOf: MigrationFileOp | null; reuseDisk: boolean }> => {
    const { stem, ext } = splitName(basenameOf(source));
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const name = attempt === 0 ? `${stem}${ext}` : `${stem}_${attempt}${ext}`;
      const path = joinPath(dir, name);
      const key = pathKey(path);
      const planned = plannedTargets.get(key);
      if (planned) {
        if (await cache.sameContent(planned.from, source)) return { path, reuseOf: planned, reuseDisk: false };
        continue;
      }
      if (await cache.exists(path)) {
        if (await cache.sameContent(path, source)) return { path, reuseOf: null, reuseDisk: true };
        continue;
      }
      if (attempt > 0) plan.stats.renamed += 1;
      return { path, reuseOf: null, reuseDisk: false };
    }
    throw new Error(`无法为 ${basenameOf(source)} 分配文件名`);
  };

  // 4. 逐个源文件生成文件操作与引用改写
  for (const { source, groups } of bySource.values()) {
    // 源文件已位于目标目录内的引用（如同步目录根下的文档，其同级目录就是统一目录）保持不动，
    // 此时源文件仍被引用，只能复制给其他目录，且不能回收
    const groupList = [...groups.values()].filter((group) => !isSubPath(group.dir, source));
    const keepSource = groupList.length < groups.size;
    if (groupList.length === 0) {
      plan.stats.images -= 1;
      continue;
    }
    // 只有一个目标目录时可直接移动；多个目录共享时逐个复制，最后回收源文件
    const canMove = groupList.length === 1 && !keepSource;
    const trashOps: number[] = [];
    const trashDocs = new Set<string>();
    let needTrash = !canMove && !keepSource;
    for (const group of groupList) {
      const allocated = await allocate(group.dir, source);
      let op: MigrationFileOp;
      if (allocated.reuseOf || allocated.reuseDisk) {
        op = { id: nextId++, kind: 'reuse', from: source, to: allocated.path, dependsOn: allocated.reuseOf?.id };
        plan.stats.deduped += 1;
        needTrash = !keepSource;
      } else {
        op = { id: nextId++, kind: canMove ? 'move' : 'copy', from: source, to: allocated.path };
        plannedTargets.set(pathKey(allocated.path), op);
      }
      plan.ops.push(op);
      trashOps.push(op.id);
      for (const ref of group.refs) {
        const changes = docChanges.get(ref.doc) ?? [];
        changes.push({ oldSrc: ref.oldSrc, newSrc: linkPathFor(ref.docDir, allocated.path), opId: op.id });
        docChanges.set(ref.doc, changes);
        trashDocs.add(ref.doc);
      }
    }
    if (needTrash) plan.trash.push({ path: source, opIds: trashOps, docs: [...trashDocs] });
    // 同级 → 统一：源文件所在目录可能被搬空
    if (options.direction === 'toGlobal') {
      const dir = dirnameOf(source);
      emptyDirs.set(pathKey(dir), dir);
    }
  }

  plan.docs = [...docChanges.entries()].map(([path, changes]) => ({ path, changes }));
  plan.stats.docs = plan.docs.length;
  plan.stats.refs = plan.docs.reduce((sum, doc) => sum + doc.changes.length, 0);
  plan.emptyDirCandidates = [...emptyDirs.values()];
  return plan;
}

// ── 执行 ──

/** 执行阶段使用的文件操作（测试可替换为内存实现） */
export interface MigrationWriteFs {
  /** 确保目录存在（含多级） */
  ensureDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  /** 按「原地址 → 新地址」改写文档，返回改写处数 */
  rewriteDocument(path: string, replacements: Map<string, string>): Promise<number>;
  /** 目录是否为空（不存在视为非空，不做处理） */
  isEmptyDir(path: string): Promise<boolean>;
}

/** 迁移结果报告 */
export interface MigrationReport {
  /** 成功移动或复制的图片数 */
  files: number;
  /** 改写成功的文档数 */
  docs: number;
  /** 改写成功的引用数 */
  refs: number;
  /** 移入回收站的源文件数 */
  trashed: number;
  /** 清理的空目录数 */
  removedDirs: number;
  errors: string[];
}

/** 执行迁移计划；单个文件失败不影响其他文件 */
export async function executeImageMigration(
  plan: MigrationPlan,
  fs: MigrationWriteFs,
  onProgress?: MigrationProgress,
): Promise<MigrationReport> {
  const report: MigrationReport = { files: 0, docs: 0, refs: 0, trashed: 0, removedDirs: 0, errors: [] };
  const succeeded = new Set<number>();
  const ensuredDirs = new Set<string>();
  /** 移动失败改为复制后，源文件需要在文档改写后回收 */
  const fallbackTrash: MigrationTrashItem[] = [];
  const total = plan.ops.length + plan.docs.length;
  let done = 0;

  const ensureDir = async (dir: string) => {
    const key = pathKey(dir);
    if (ensuredDirs.has(key)) return;
    await fs.ensureDir(dir);
    ensuredDirs.add(key);
  };

  // 1. 文件操作
  for (const op of plan.ops) {
    onProgress?.(done++, total, basenameOf(op.from));
    try {
      if (op.kind === 'reuse') {
        // 复用计划内其他操作的产物时，该操作必须成功
        if (op.dependsOn !== undefined && !succeeded.has(op.dependsOn)) continue;
      } else {
        await ensureDir(dirnameOf(op.to));
        if (op.kind === 'move') {
          try {
            await fs.rename(op.from, op.to);
          } catch {
            // 跨设备等无法直接移动时改为复制，源文件待文档改写成功后回收
            await fs.copy(op.from, op.to);
            const docs = plan.docs.filter((doc) => doc.changes.some((change) => change.opId === op.id)).map((doc) => doc.path);
            fallbackTrash.push({ path: op.from, opIds: [op.id], docs });
          }
        } else {
          await fs.copy(op.from, op.to);
        }
        report.files += 1;
      }
      succeeded.add(op.id);
    } catch (error) {
      report.errors.push(`${basenameOf(op.from)}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 2. 改写文档：只改写文件操作成功的引用
  const failedDocs = new Set<string>();
  for (const doc of plan.docs) {
    onProgress?.(done++, total, basenameOf(doc.path));
    const replacements = new Map<string, string>();
    for (const change of doc.changes) {
      if (succeeded.has(change.opId)) replacements.set(change.oldSrc, change.newSrc);
    }
    if (replacements.size < doc.changes.length) failedDocs.add(pathKey(doc.path));
    if (replacements.size === 0) continue;
    try {
      const count = await fs.rewriteDocument(doc.path, replacements);
      report.refs += count;
      if (count > 0) report.docs += 1;
    } catch (error) {
      failedDocs.add(pathKey(doc.path));
      report.errors.push(`${basenameOf(doc.path)}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  onProgress?.(total, total, '');

  // 3. 回收源文件：产生副本的操作全部成功、引用它的文档全部改写成功才回收
  for (const item of [...plan.trash, ...fallbackTrash]) {
    if (!item.opIds.every((id) => succeeded.has(id))) continue;
    if (item.docs.some((doc) => failedDocs.has(pathKey(doc)))) continue;
    try {
      await fs.trash(item.path);
      report.trashed += 1;
    } catch (error) {
      report.errors.push(`${basenameOf(item.path)}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 4. 清理搬空的旧图片目录
  for (const dir of plan.emptyDirCandidates) {
    try {
      if (await fs.isEmptyDir(dir)) {
        await fs.trash(dir);
        report.removedDirs += 1;
      }
    } catch {
      // 清理空目录失败不影响迁移结果
    }
  }
  return report;
}

// ── 默认文件访问实现（桌面、移动端、网页共用 IPC） ──

/** 递归扫描时跳过的目录：隐藏目录（.nb-trash / .nb-history 等）与常见依赖、构建目录 */
const SKIPPED_DIRS = new Set(['node_modules', '__pycache__', 'target']);

/** 文档 key（已打开时）及其正文是否已加载 */
function findOpenDocument(path: string): { key: string; loaded: boolean; dirty: boolean } | null {
  const target = pathKey(path);
  for (const doc of useDocumentStore.getState().documents.values()) {
    if (pathKey(doc.key) === target) return { key: doc.key, loaded: typeof doc.content === 'string', dirty: doc.isDirty };
  }
  return null;
}

/** 基于 IPC 的只读文件访问 */
export function createIpcReadFs(): MigrationReadFs {
  return {
    async listMarkdownFiles(root) {
      const result: string[] = [];
      const walk = async (dir: string) => {
        let nodes: Awaited<ReturnType<typeof ipc.readDir>>;
        try {
          nodes = await ipc.readDir(dir, true);
        } catch {
          return;
        }
        for (const node of nodes) {
          if (node.isSymlink) continue;
          if (node.isDir) {
            if (node.name.startsWith('.') || SKIPPED_DIRS.has(node.name)) continue;
            await walk(node.path);
          } else if (/\.(md|markdown)$/i.test(node.name)) {
            result.push(node.path);
          }
        }
      };
      await walk(root);
      return result;
    },
    async readText(path) {
      return (await ipc.readDocument(path)).content ?? '';
    },
    async exists(path) {
      const result = await ipc.pathExists(path);
      return result.exists && !result.isDir;
    },
    readBytes: (path) => ipc.readPreviewFile(path),
    isDirtyOpenDocument: (path) => findOpenDocument(path)?.dirty ?? false,
  };
}

/** 基于 IPC 的文件写入；已打开且无修改的文档改写磁盘后从磁盘重新加载 */
export function createIpcWriteFs(): MigrationWriteFs {
  const ensureDir = async (path: string): Promise<void> => {
    const result = await ipc.pathExists(path).catch(() => null);
    if (result?.exists) {
      if (!result.isDir) throw new Error(`同名文件已存在：${basenameOf(path)}`);
      return;
    }
    const parent = dirnameOf(path);
    if (!parent || pathKey(parent) === pathKey(path)) throw new Error(`无法创建目录：${path}`);
    await ensureDir(parent);
    await ipc.createDir(parent, basenameOf(path));
  };
  return {
    ensureDir,
    rename: (from, to) => ipc.renamePath(from, to),
    async copy(from, to) {
      const bytes = await ipc.readPreviewFile(from);
      const result = await ipc.saveBinaryFile(to, bytes);
      if (!result.ok) throw new Error(typeof result.error === 'string' ? result.error : '写入图片失败');
    },
    trash: (path) => ipc.moveToTrash(path),
    async rewriteDocument(path, replacements) {
      const open = findOpenDocument(path);
      // 规划之后才产生的未保存修改：不覆盖编辑内容
      if (open?.dirty) throw new Error('文档有未保存的修改，请先保存后重试');
      const payload = await ipc.readDocument(path);
      const content = payload.content ?? '';
      const { text, count } = rewriteImageRefs(content, replacements);
      if (count === 0) return 0;
      const result = await ipc.writeDocument(path, text, payload.encoding, payload.eol);
      if (!result.ok) throw new Error('写入文档失败');
      // 已打开的文档从磁盘重新加载，编辑器内容与磁盘保持一致
      if (open?.loaded) {
        const { reloadFromDisk } = await import('../external/externalChangeActions');
        await reloadFromDisk(open.key, { silent: true });
      }
      return count;
    },
    async isEmptyDir(path) {
      try {
        return (await ipc.readDir(path, true)).length === 0;
      } catch {
        return false;
      }
    },
  };
}
