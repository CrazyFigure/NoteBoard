// NoteBoard 双链跳转
// 解析目标 → 打开文档 → 可选滚动到标题；目标不存在（例如同步尚未带来另一端）时只提示，不自动新建。
// 解析顺序：仓库索引 → 已打开的文档（可能在仓库外）→ 写了路径的目标直接探测磁盘（支持仓库外的相对 / 完整路径）。

import { NodeSelection } from '@tiptap/pm/state';
import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
import { joinPath, pathKey } from '../explorer/pathUtils';
import { getMdSourceView, getMdTipTapEditor } from '../editor-md/editorInstances';
import {
  absoluteTargetPath,
  createExternalEntry,
  loadNoteIndex,
  notifyNoteIndexChanged,
  peekNoteIndex,
  resolveAmongEntries,
  resolveVaultRoot,
  resolveWikiTarget,
  type NoteEntry,
} from './noteIndex';
import { extractHeadings, parseWikiLinkInner, wikiLinkLabel, type NoteHeading } from './wikiLinkSyntax';

/** 链接的解析状态 */
export type WikiLinkResolution =
  | { status: 'resolved'; entry: NoteEntry }
  /** 指向当前文档内的标题（`[[#标题]]`） */
  | { status: 'self' }
  | { status: 'missing' }
  /** 索引尚未就绪（首次构建中）或仓库外路径正在探测 */
  | { status: 'pending' };

/** 文档在磁盘上的路径（未保存的新文档返回 null） */
export function docPathOf(docKey: string): string | null {
  const tabPath = useWindowStore.getState().getTab(docKey)?.path;
  if (tabPath) return tabPath;
  const doc = useDocumentStore.getState().getDocument(docKey);
  if (doc?.dirPath) return joinPath(doc.dirPath, doc.displayName);
  return null;
}

/** 已打开的文档（可能位于仓库外），作为解析与补全的补充候选 */
export function openDocumentEntries(): NoteEntry[] {
  const entries: NoteEntry[] = [];
  for (const tab of useWindowStore.getState().tabs) {
    if (tab.path) entries.push(createExternalEntry(tab.path));
  }
  return entries;
}

// ── 仓库外路径探测 ──

/** 探测结果的有效期：过期后后台重新探测，期间沿用旧结果 */
const PROBE_TTL_MS = 15000;

interface ProbeResult {
  /** 实际存在的路径（可能补了 .md）；null 表示不存在 */
  path: string | null;
  /** 最近一次探测完成的时间；0 表示首次探测尚未完成 */
  at: number;
  pending: boolean;
}

const probes = new Map<string, ProbeResult>();

/** 依次探测原路径与补 .md 的路径 */
async function probeExistingFile(absolute: string): Promise<string | null> {
  for (const candidate of [absolute, `${absolute}.md`]) {
    try {
      const result = await ipc.pathExists(candidate);
      if (result.exists && !result.isDir) return candidate;
    } catch {
      // 无权限等视为不存在
    }
  }
  return null;
}

/**
 * 同步读取探测结果：undefined 表示尚未探测完成（已在后台启动）。
 * 探测完成后通知订阅者，链接样式随之更新。
 */
function probedPath(absolute: string): string | null | undefined {
  const key = pathKey(absolute);
  const cached = probes.get(key);
  if (!cached || (!cached.pending && Date.now() - cached.at > PROBE_TTL_MS)) {
    const previous = cached?.at ? cached.path : undefined;
    probes.set(key, { path: cached?.path ?? null, at: cached?.at ?? 0, pending: true });
    void probeExistingFile(absolute).then((path) => {
      probes.set(key, { path, at: Date.now(), pending: false });
      if (previous !== path) notifyNoteIndexChanged();
    });
    return previous;
  }
  // 首次探测进行中：结果未知
  return cached.at === 0 ? undefined : cached.path;
}

/** 同步解析（使用当前可用的索引，供链接样式使用） */
export function resolveWikiLinkNow(inner: string, docKey: string): WikiLinkResolution {
  const parts = parseWikiLinkInner(inner);
  if (!parts.target) return { status: 'self' };
  const fromPath = docPathOf(docKey);
  const root = resolveVaultRoot(fromPath);
  const snapshot = root ? peekNoteIndex(root) : null;
  const indexed = snapshot ? resolveWikiTarget(snapshot, parts.target, fromPath) : null;
  if (indexed) return { status: 'resolved', entry: indexed };

  const opened = resolveAmongEntries(openDocumentEntries(), parts.target, fromPath);
  if (opened) return { status: 'resolved', entry: opened };

  const absolute = absoluteTargetPath(parts.target, fromPath);
  if (absolute) {
    const probed = probedPath(absolute);
    if (probed === undefined) return { status: 'pending' };
    if (probed) return { status: 'resolved', entry: createExternalEntry(probed) };
  }
  if (root && !snapshot) return { status: 'pending' };
  return { status: 'missing' };
}

/** 异步解析：未找到时强制刷新一次索引再试（刚同步到达的文件也能命中），最后探测仓库外路径 */
export async function resolveWikiLinkFresh(target: string, fromPath: string | null): Promise<NoteEntry | null> {
  const root = resolveVaultRoot(fromPath);
  if (root) {
    const snapshot = await loadNoteIndex(root);
    const entry = resolveWikiTarget(snapshot, target, fromPath);
    if (entry) return entry;
  }
  const opened = resolveAmongEntries(openDocumentEntries(), target, fromPath);
  if (opened) return opened;
  const absolute = absoluteTargetPath(target, fromPath);
  if (absolute) {
    const path = await probeExistingFile(absolute);
    probes.set(pathKey(absolute), { path, at: Date.now(), pending: false });
    if (path) return createExternalEntry(path);
  }
  if (root) {
    const refreshed = await loadNoteIndex(root, { fresh: true });
    return resolveWikiTarget(refreshed, target, fromPath);
  }
  return null;
}

// ── 读取目标笔记 ──

/** 读取笔记正文：已打开的文档用内存中的最新内容（含未保存修改） */
export async function readNoteText(entry: NoteEntry): Promise<string> {
  const key = pathKey(entry.path);
  for (const doc of useDocumentStore.getState().documents.values()) {
    if (pathKey(doc.key) === key && typeof doc.content === 'string') return doc.content;
  }
  const payload = await ipc.readDocument(entry.path);
  return payload.content ?? '';
}

/** 标题列表缓存：路径 + 修改时间 → 标题 */
const headingCache = new Map<string, NoteHeading[]>();

/** 读取笔记的标题列表（选择 `#标题` 用）；非 Markdown 或读取失败返回空列表 */
export async function loadNoteHeadings(entry: NoteEntry): Promise<NoteHeading[]> {
  if (!entry.isMarkdown) return [];
  const cacheKey = `${pathKey(entry.path)}:${entry.mtime}:${entry.size}`;
  const cached = headingCache.get(cacheKey);
  if (cached) return cached;
  try {
    const headings = extractHeadings(await readNoteText(entry));
    // 已打开的文档内容随时变化，不缓存
    if (entry.mtime > 0) {
      if (headingCache.size > 200) headingCache.clear();
      headingCache.set(cacheKey, headings);
    }
    return headings;
  } catch {
    return [];
  }
}

// ── 打开后定位 ──

/** 标题文字比较：忽略大小写与首尾空白 */
function sameHeading(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** 在已挂载的编辑器中滚动到指定标题；成功返回 true */
export function revealHeading(docKey: string, heading: string): boolean {
  const editor = getMdTipTapEditor(docKey);
  if (editor && !editor.isDestroyed && editor.view.dom.isConnected) {
    let targetPos: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (targetPos !== null) return false;
      if (node.type.name === 'heading' && sameHeading(node.textContent, heading)) {
        targetPos = pos;
        return false;
      }
      return true;
    });
    if (targetPos !== null) {
      const pos: number = targetPos;
      editor.commands.focus();
      editor.commands.setTextSelection(Math.min(pos + 1, editor.state.doc.content.size));
      requestAnimationFrame(() => {
        const dom = editor.view.nodeDOM(pos);
        if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else editor.commands.scrollIntoView();
      });
      return true;
    }
  }

  const view = getMdSourceView(docKey);
  if (view && view.dom.isConnected) {
    const { doc } = view.state;
    for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
      const line = doc.line(lineNumber);
      const match = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line.text);
      if (match && sameHeading(match[1], heading)) {
        view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
        view.focus();
        return true;
      }
    }
  }
  return false;
}

/**
 * 定位到文档中的第 occurrence 个双链（反向链接片段点击时使用）。
 * 可视化模式按双链节点的文档顺序选中；源码模式跳到对应行。成功返回 true。
 */
export function revealWikiOccurrence(docKey: string, occurrence: number, line: number): boolean {
  const editor = getMdTipTapEditor(docKey);
  const tab = useWindowStore.getState().getTab(docKey);
  if (editor && !editor.isDestroyed && editor.view.dom.isConnected && tab?.viewMode !== 'source') {
    let index = 0;
    let targetPos: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (targetPos !== null) return false;
      if (node.type.name === 'wikiLink') {
        if (index === occurrence) targetPos = pos;
        index += 1;
      }
      return true;
    });
    if (targetPos !== null) {
      const pos: number = targetPos;
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
      editor.view.focus();
      requestAnimationFrame(() => {
        const dom = editor.view.nodeDOM(pos);
        if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return true;
    }
  }
  const view = getMdSourceView(docKey);
  if (view && view.dom.isConnected && line < view.state.doc.lines) {
    const target = view.state.doc.line(line + 1);
    view.dispatch({ selection: { anchor: target.from, head: target.to }, scrollIntoView: true });
    view.focus();
    return true;
  }
  return false;
}

/** 打开文档后等待编辑器挂载再执行定位（最多等待约 4 秒） */
export function whenDocumentReady(path: string, reveal: (docKey: string) => boolean): void {
  const startedAt = Date.now();
  const attempt = () => {
    const targetKey = [...useDocumentStore.getState().documents.keys()].find((key) => pathKey(key) === pathKey(path));
    if (targetKey && reveal(targetKey)) return;
    if (Date.now() - startedAt < 4000) window.setTimeout(attempt, 120);
  };
  window.setTimeout(attempt, 60);
}

/** 在 NoteBoard 中打开文件 */
export async function openNotePath(path: string): Promise<boolean> {
  const { openDocument } = await import('../editor-code/orchestration/openDocument');
  const result = await openDocument(path);
  return result !== 'failed';
}

// 短时防抖：同一链接连击只打开一次
let lastOpen = { inner: '', at: 0 };

/** 跳转到双链目标 */
export async function openWikiLink(inner: string, fromDocKey: string): Promise<void> {
  const now = Date.now();
  if (lastOpen.inner === inner && now - lastOpen.at < 400) return;
  lastOpen = { inner, at: now };

  const parts = parseWikiLinkInner(inner);
  if (!parts.target) {
    if (parts.heading && !revealHeading(fromDocKey, parts.heading)) {
      showToast(`当前文档中没有标题「${parts.heading}」`, 'warning');
    }
    return;
  }

  const fromPath = docPathOf(fromDocKey);
  let entry: NoteEntry | null = null;
  try {
    entry = await resolveWikiLinkFresh(parts.target, fromPath);
  } catch (error) {
    console.error('[wikiLink] 解析双链失败:', error);
  }
  if (!entry) {
    // 另一端可能还没同步到本机：只提示，不擅自新建（避免与稍后同步到达的文件冲突）
    showToast(`未找到「${wikiLinkLabel({ ...parts, alias: '', heading: '' })}」，可能尚未同步到本机`, 'warning');
    return;
  }

  try {
    if (!(await openNotePath(entry.path))) return;
    if (parts.heading) whenDocumentReady(entry.path, (key) => revealHeading(key, parts.heading));
  } catch (error) {
    console.error('[wikiLink] 打开双链目标失败:', error);
    showToast(`无法打开「${entry.name}」`, 'error');
  }
}

/** 仅测试：清空探测缓存 */
export function resetWikiLinkProbesForTest(): void {
  probes.clear();
}
