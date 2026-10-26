// NoteBoard 重命名后同步更新双链
// 流程：重命名前用当时的索引找出所有指向被改名文件（或目录下文件）的双链 → 重命名成功后询问用户 →
// 按改名后的路径重写链接目标，并尽量沿用原写法（原来只写名称的仍只写名称，写了路径的改写为新路径）。
// 已打开的文档通过编辑器修改（进入撤销历史并按保存策略保存），未打开的文件直接改写磁盘内容。

import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
import { showConfirm } from '../../stores/promptDialogStore';
import { isSubPath, normalizePath, pathKey } from '../explorer/pathUtils';
import { getMdSourceView, getMdTipTapEditor } from '../editor-md/editorInstances';
import { forgetCachedWikiLinks, readWikiLinks } from './backlinks';
import {
  buildSnapshot,
  invalidateNoteIndex,
  isAbsoluteNotePath,
  loadNoteIndex,
  peekNoteIndex,
  rebaseEntry,
  resolveVaultRoot,
  resolveWikiTarget,
  type NoteEntry,
  type NoteIndexSnapshot,
} from './noteIndex';
import { extractWikiLinks, formatWikiLinkInner, parseWikiLinkInner, type WikiLinkParts } from './wikiLinkSyntax';

/** 一处需要更新的链接 */
interface PlannedLink {
  inner: string;
  parts: WikiLinkParts;
  /** 改名前解析到的目标 */
  target: NoteEntry;
}

/** 重命名前收集到的更新计划 */
export interface WikiRenamePlan {
  root: string;
  snapshot: NoteIndexSnapshot;
  oldPath: string;
  isDir: boolean;
  /** 受影响（被改名或位于被改名目录下）的文件：路径比较键 → 条目 */
  moved: Map<string, NoteEntry>;
  sources: Array<{ entry: NoteEntry; links: PlannedLink[] }>;
  total: number;
}

/**
 * 重命名前调用：找出仓库内指向被改名文件的全部双链。
 * 没有受影响的链接时返回 null（调用方照常重命名即可）。
 */
export async function planWikiLinkRename(oldPath: string, isDir: boolean): Promise<WikiRenamePlan | null> {
  const root = resolveVaultRoot(oldPath);
  if (!root) return null;
  const snapshot = await loadNoteIndex(root);
  const oldKey = pathKey(oldPath);
  const moved = new Map<string, NoteEntry>();
  for (const entry of snapshot.entries) {
    const key = pathKey(entry.path);
    if (isDir ? key !== oldKey && isSubPath(oldPath, entry.path) : key === oldKey) moved.set(key, entry);
  }
  if (moved.size === 0) return null;

  const sources: WikiRenamePlan['sources'] = [];
  let total = 0;
  for (const source of snapshot.entries) {
    if (!source.isMarkdown) continue;
    const links: PlannedLink[] = [];
    for (const occurrence of await readWikiLinks(source)) {
      const parts = parseWikiLinkInner(occurrence.inner);
      if (!parts.target) continue;
      const target = resolveWikiTarget(snapshot, parts.target, source.path);
      if (target && moved.has(pathKey(target.path))) links.push({ inner: occurrence.inner, parts, target });
    }
    if (links.length > 0) {
      sources.push({ entry: source, links });
      total += links.length;
    }
  }
  return total > 0 ? { root, snapshot, oldPath, isDir, moved, sources, total } : null;
}

/** 改名后的路径 */
function mapMovedPath(plan: WikiRenamePlan, newPath: string, path: string): string {
  if (!plan.isDir) return newPath;
  const oldRoot = normalizePath(plan.oldPath);
  return normalizePath(newPath) + normalizePath(path).slice(oldRoot.length);
}

/**
 * 计算新的链接目标：按原写法依次尝试（只写名称 → 仓库相对路径 → 完整路径），
 * 取第一个在改名后的索引中仍能解析到同一文件的写法。
 */
function rewriteTarget(oldTarget: string, entry: NoteEntry, snapshot: NoteIndexSnapshot, fromPath: string): string {
  const wroteMdExt = /\.(md|markdown)$/i.test(oldTarget.trim());
  const keepExt = !entry.isMarkdown || wroteMdExt;
  const relPath = keepExt ? entry.relPath : entry.relPath.replace(/\.(md|markdown)$/i, '');
  const absolute = entry.path.replace(/\\/g, '/');
  const candidates: string[] = [];
  if (isAbsoluteNotePath(oldTarget)) {
    candidates.push(keepExt ? absolute : absolute.replace(/\.(md|markdown)$/i, ''));
  } else if (!/[\\/]/.test(oldTarget)) {
    candidates.push(keepExt ? entry.name : entry.stem);
  }
  candidates.push(relPath);
  const entryKey = pathKey(entry.path);
  const valid = candidates.find((candidate) => {
    const resolved = resolveWikiTarget(snapshot, candidate, fromPath);
    return resolved !== null && pathKey(resolved.path) === entryKey;
  });
  return valid ?? relPath;
}

/** 文档 key（已打开时）及其正文是否已加载 */
function findOpenDocument(path: string): { key: string; loaded: boolean } | null {
  const target = pathKey(path);
  for (const doc of useDocumentStore.getState().documents.values()) {
    if (pathKey(doc.key) === target) return { key: doc.key, loaded: typeof doc.content === 'string' };
  }
  return null;
}

/** 按「原内部文字 → 新内部文字」改写一段 Markdown 原文 */
function rewriteMarkdown(markdown: string, replacements: Map<string, string>): string {
  let output = markdown;
  // 从后往前替换，前面的偏移不受影响
  for (const occurrence of extractWikiLinks(markdown).reverse()) {
    const next = replacements.get(occurrence.inner);
    if (next === undefined) continue;
    const start = occurrence.from + (occurrence.embed ? 3 : 2);
    output = output.slice(0, start) + next + output.slice(occurrence.to - 2);
  }
  return output;
}

/** 在已打开文档的编辑器中改写链接；编辑器未挂载时返回 false */
function rewriteOpenDocument(docKey: string, replacements: Map<string, string>): boolean {
  const viewMode = useWindowStore.getState().getTab(docKey)?.viewMode;
  const sourceView = getMdSourceView(docKey);
  if (viewMode === 'source' && sourceView) {
    const text = sourceView.state.doc.toString();
    const changes = extractWikiLinks(text)
      .filter((occurrence) => replacements.has(occurrence.inner))
      .map((occurrence) => ({
        from: occurrence.from + (occurrence.embed ? 3 : 2),
        to: occurrence.to - 2,
        insert: replacements.get(occurrence.inner)!,
      }));
    if (changes.length) sourceView.dispatch({ changes });
    return true;
  }
  const editor = getMdTipTapEditor(docKey);
  if (editor && !editor.isDestroyed) {
    const { tr } = editor.state;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'wikiLink') return true;
      const next = replacements.get(String(node.attrs.inner ?? ''));
      if (next !== undefined) tr.setNodeMarkup(pos, undefined, { ...node.attrs, inner: next });
      return false;
    });
    if (tr.docChanged) editor.view.dispatch(tr);
    return true;
  }
  return false;
}

/** 改写未打开（或编辑器未挂载）的文件 */
async function rewriteFile(path: string, replacements: Map<string, string>): Promise<void> {
  const payload = await ipc.readDocument(path);
  const content = payload.content ?? '';
  const next = rewriteMarkdown(content, replacements);
  if (next === content) return;
  await ipc.writeDocument(path, next, payload.encoding, payload.eol);
  forgetCachedWikiLinks(path);
}

/**
 * 重命名成功后调用：询问是否更新链接，确认后逐个来源改写。
 * 返回实际更新的链接数（用户取消返回 0）。
 */
export async function applyWikiLinkRename(plan: WikiRenamePlan, newPath: string): Promise<number> {
  const confirmed = await showConfirm({
    title: '同步更新双向链接？',
    description: `${plan.sources.length} 篇笔记中有 ${plan.total} 处双链指向被重命名的${plan.isDir ? '目录下的笔记' : '笔记'}，更新后链接仍指向它。`,
    confirmLabel: '更新链接',
  });
  if (!confirmed) return 0;

  // 推演改名后的索引（不必等待重新扫描），用于判断新写法能否唯一解析
  const renamedEntries = plan.snapshot.entries.map((entry) =>
    plan.moved.has(pathKey(entry.path)) ? rebaseEntry(plan.root, entry, mapMovedPath(plan, newPath, entry.path)) : entry,
  );
  const renamed = buildSnapshot(plan.root, renamedEntries);

  let updated = 0;
  const failed: string[] = [];
  for (const source of plan.sources) {
    const sourcePath = plan.moved.has(pathKey(source.entry.path))
      ? mapMovedPath(plan, newPath, source.entry.path)
      : source.entry.path;
    const replacements = new Map<string, string>();
    for (const link of source.links) {
      const newEntry = renamed.byPathKey.get(pathKey(mapMovedPath(plan, newPath, link.target.path)));
      if (!newEntry) continue;
      const target = rewriteTarget(link.parts.target, newEntry, renamed, sourcePath);
      if (target === link.parts.target) continue;
      let inner = formatWikiLinkInner({ ...link.parts, target });
      // 表格里的 `\|` 写法保持不变
      if (link.inner.includes('\\|')) inner = inner.replace('|', '\\|');
      replacements.set(link.inner, inner);
    }
    if (replacements.size === 0) continue;
    try {
      const open = findOpenDocument(sourcePath);
      if (!(open?.loaded && rewriteOpenDocument(open.key, replacements))) {
        await rewriteFile(sourcePath, replacements);
      }
      updated += source.links.filter((link) => replacements.has(link.inner)).length;
    } catch (error) {
      console.error('[wikiLink] 更新链接失败:', sourcePath, error);
      failed.push(source.entry.stem);
    }
  }

  invalidateNoteIndex();
  if (failed.length > 0) {
    showToast(`已更新 ${updated} 处链接，${failed.length} 篇笔记更新失败：${failed.slice(0, 3).join('、')}`, 'warning');
  } else if (updated > 0) {
    showToast(`已更新 ${updated} 处双向链接`, 'success');
  }
  return updated;
}

/** 收集链接的最长等待：索引已建立时只需读取各笔记的链接（多数命中缓存） */
const PLAN_TIMEOUT_MS = 5000;
/** 尚无索引时的最长等待：首次扫描大目录较慢时放弃更新链接，不拖慢重命名本身 */
const PLAN_COLD_TIMEOUT_MS = 1500;

/**
 * 重命名前调用的安全版本：超时或出错时返回 null，重命名照常进行。
 * 重命名成功后再调用 applyWikiLinkRename(plan, newPath)。
 */
export async function planWikiLinkRenameSafely(oldPath: string, isDir: boolean): Promise<WikiRenamePlan | null> {
  const root = resolveVaultRoot(oldPath);
  const timeout = root && peekNoteIndex(root) ? PLAN_TIMEOUT_MS : PLAN_COLD_TIMEOUT_MS;
  try {
    return await Promise.race([
      planWikiLinkRename(oldPath, isDir),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), timeout)),
    ]);
  } catch (error) {
    console.error('[wikiLink] 收集待更新链接失败:', error);
    return null;
  }
}
