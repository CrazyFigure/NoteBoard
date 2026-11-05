// NoteBoard 反向链接
// 扫描仓库内全部 Markdown 笔记中的双链，找出指向当前文档的引用。
// 每个文件的提取结果按（修改时间, 大小）缓存，只有变化过的文件才重新读取；
// 已打开的文档直接使用内存中的最新内容（未保存的修改同样计入）。

import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { pathKey } from '../explorer/pathUtils';
import { loadNoteIndex, resolveVaultRoot, resolveWikiTarget, type NoteEntry, type NoteIndexSnapshot } from './noteIndex';
import { extractWikiLinks, parseWikiLinkInner, type WikiLinkOccurrence } from './wikiLinkSyntax';

/** 超过该大小的文件不参与扫描（几乎不可能是手写笔记，且读取代价高） */
const MAX_SCANNED_FILE_SIZE = 2 * 1024 * 1024;
/** 并发读取文件数 */
const READ_CONCURRENCY = 6;
/** 上下文片段最大长度 */
const SNIPPET_MAX_LENGTH = 160;

/** 一处引用 */
export interface BacklinkItem {
  /** 从 0 开始的行号 */
  line: number;
  /** 该链接是来源文件中的第几个双链（从 0 开始，可视化模式按此定位节点） */
  occurrence: number;
  /** 所在行的上下文片段 */
  snippet: string;
}

/** 同一来源文件的引用 */
export interface BacklinkGroup {
  path: string;
  name: string;
  relPath: string;
  items: BacklinkItem[];
}

interface CachedLinks {
  mtime: number;
  size: number;
  links: WikiLinkOccurrence[];
}

/** 路径比较键 → 提取结果 */
const linkCache = new Map<string, CachedLinks>();

/** 已打开文档的内存内容（含未保存修改）；未加载正文的返回 null */
function openDocumentContent(path: string): string | null {
  const key = pathKey(path);
  for (const doc of useDocumentStore.getState().documents.values()) {
    if (pathKey(doc.key) === key && typeof doc.content === 'string') return doc.content;
  }
  return null;
}

/** 读取单个笔记中的双链（命中缓存时不读盘；已打开的文档用内存内容） */
export async function readWikiLinks(entry: NoteEntry): Promise<WikiLinkOccurrence[]> {
  const openContent = openDocumentContent(entry.path);
  if (openContent !== null) return extractWikiLinks(openContent);
  const key = pathKey(entry.path);
  const cached = linkCache.get(key);
  if (cached && cached.mtime === entry.mtime && cached.size === entry.size) return cached.links;
  if (entry.size > MAX_SCANNED_FILE_SIZE) return [];
  try {
    const payload = await ipc.readDocument(entry.path);
    const links = extractWikiLinks(payload.content ?? '');
    linkCache.set(key, { mtime: entry.mtime, size: entry.size, links });
    return links;
  } catch {
    // 文件在扫描期间被删除或不可读：视为无链接
    return [];
  }
}

/** 截取引用所在行，链接靠后时向前省略 */
function snippetOf(occurrence: WikiLinkOccurrence): string {
  const text = occurrence.lineText.trim()
    // 去掉列表、引用、标题等行首标记，片段更易读
    .replace(/^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*|#{1,6}\s+)+/, '');
  if (text.length <= SNIPPET_MAX_LENGTH) return text;
  const at = text.indexOf(`[[${occurrence.inner}]]`);
  const start = Math.max(0, Math.min(at - 40, text.length - SNIPPET_MAX_LENGTH));
  const clipped = text.slice(start, start + SNIPPET_MAX_LENGTH);
  return `${start > 0 ? '…' : ''}${clipped}${start + SNIPPET_MAX_LENGTH < text.length ? '…' : ''}`;
}

/** 在快照内找出指向目标文件的全部引用 */
async function collectFromSnapshot(
  snapshot: NoteIndexSnapshot,
  targetPath: string,
  signal?: AbortSignal,
): Promise<BacklinkGroup[]> {
  const targetKey = pathKey(targetPath);
  const sources = snapshot.entries.filter((entry) => entry.isMarkdown && pathKey(entry.path) !== targetKey);
  const groups: BacklinkGroup[] = [];

  for (let start = 0; start < sources.length; start += READ_CONCURRENCY) {
    if (signal?.aborted) return [];
    const batch = sources.slice(start, start + READ_CONCURRENCY);
    const results = await Promise.all(batch.map(readWikiLinks));
    batch.forEach((source, index) => {
      const items: BacklinkItem[] = [];
      results[index].forEach((occurrence, occurrenceIndex) => {
        const parts = parseWikiLinkInner(occurrence.inner);
        if (!parts.target) return;
        const resolved = resolveWikiTarget(snapshot, parts.target, source.path);
        if (resolved && pathKey(resolved.path) === targetKey) {
          items.push({ line: occurrence.line, occurrence: occurrenceIndex, snippet: snippetOf(occurrence) });
        }
      });
      if (items.length > 0) {
        groups.push({ path: source.path, name: source.stem, relPath: source.relPath, items });
      }
    });
  }

  // 最近修改的来源排在前面
  const mtimeOf = new Map(sources.map((entry) => [entry.path, entry.mtime]));
  return groups.sort((left, right) => (mtimeOf.get(right.path) ?? 0) - (mtimeOf.get(left.path) ?? 0));
}

/** 收集指向指定文档的反向链接 */
export async function collectBacklinks(targetPath: string, signal?: AbortSignal): Promise<BacklinkGroup[]> {
  const root = resolveVaultRoot(targetPath);
  if (!root) return [];
  const snapshot = await loadNoteIndex(root);
  return collectFromSnapshot(snapshot, targetPath, signal);
}

/** 文件被本模块以外的流程改写后丢弃其缓存（索引中的修改时间可能尚未刷新） */
export function forgetCachedWikiLinks(path: string): void {
  linkCache.delete(pathKey(path));
}

/** 仅测试：清空缓存 */
export function resetBacklinkCacheForTest(): void {
  linkCache.clear();
}
