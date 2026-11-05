// NoteBoard 思维导图节点附件：多张图片与本地文件超链接
// 纯函数工具：数据规范化（兼容旧版单图 image 字段）、数量上限与文件链接路径换算。
// 详见 docs/09-开发路线图.md

import type { MindNode } from './mindmapTypes';
import { USES_WINDOWS_PATHS } from '../../core/platform';
import { basenameOf, isSubPath, normalizePath, PATH_SEP } from '../explorer/pathUtils';

/** 单个节点最多挂载的图片数量 */
export const MAX_NODE_IMAGES = 10;
/** 单个节点最多挂载的文件链接数量 */
export const MAX_NODE_FILES = 10;

/** 旧版文档的单图字段（读取时并入 images） */
type LegacyImageSource = Partial<MindNode> & { image?: unknown };

/** 只保留非空字符串，并按上限截断；结果为空时返回 undefined（序列化时省略字段） */
function cleanList(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, max);
  return list.length > 0 ? list : undefined;
}

/** 规范化节点图片：旧版 image 排在最前，再接 images，最多 10 张 */
export function normalizeNodeImages(source: LegacyImageSource): string[] | undefined {
  const legacy = typeof source.image === 'string' && source.image ? [source.image] : [];
  return cleanList([...legacy, ...(Array.isArray(source.images) ? source.images : [])], MAX_NODE_IMAGES);
}

/** 规范化节点文件链接：去重（同一路径只保留一次），最多 10 个 */
export function normalizeNodeFiles(value: unknown): string[] | undefined {
  const list = cleanList(value, Number.MAX_SAFE_INTEGER);
  if (!list) return undefined;
  return cleanList([...new Set(list.map((item) => item.trim()))], MAX_NODE_FILES);
}

/** 节点图片列表（始终返回数组，便于渲染） */
export function getNodeImages(node: MindNode): readonly string[] {
  return node.images ?? [];
}

/** 节点文件链接列表（始终返回数组，便于渲染） */
export function getNodeFiles(node: MindNode): readonly string[] {
  return node.files ?? [];
}

/**
 * 追加条目并遵守数量上限
 * @returns next 为追加后的列表；dropped 为因超出上限被忽略的数量
 */
export function appendWithLimit(
  current: readonly string[] | undefined,
  additions: readonly string[],
  max: number,
  dedupe = false,
): { next: string[]; dropped: number } {
  const next = [...(current ?? [])];
  let dropped = 0;
  for (const item of additions) {
    if (dedupe && next.includes(item)) continue;
    if (next.length >= max) {
      dropped += 1;
      continue;
    }
    next.push(item);
  }
  return { next, dropped };
}

/** 文件链接的显示名：取路径最后一段，并还原百分号编码 */
export function fileLinkName(path: string): string {
  const name = basenameOf(path.replace(/^file:[\\/]+/i, ''));
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** 路径段比较：Windows 大小写不敏感 */
function sameSegment(a: string, b: string): boolean {
  return USES_WINDOWS_PATHS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 计算文件链接的存储路径：
 * 目标与导图同处工作区（或在导图目录之下）时写相对路径（统一 `/` 分隔，跨平台可移植），
 * 否则保留绝对路径，避免导图移动后出现很长且易失效的 ../ 链。
 * @param docDir 当前导图所在目录（未保存时为空）
 * @param workspaceRoot 资源管理器根目录
 */
export function toFileLinkPath(target: string, docDir?: string | null, workspaceRoot?: string | null): string {
  if (!docDir) return target;
  const inDocDir = isSubPath(docDir, target);
  const inWorkspace = Boolean(workspaceRoot) && isSubPath(workspaceRoot, docDir) && isSubPath(workspaceRoot, target);
  if (!inDocDir && !inWorkspace) return target;

  const base = normalizePath(docDir).split(PATH_SEP).filter(Boolean);
  const dest = normalizePath(target).split(PATH_SEP).filter(Boolean);
  // 公共前缀最多到目标的父目录，最后一段始终是文件名
  let common = 0;
  while (common < base.length && common < dest.length - 1 && sameSegment(base[common], dest[common])) common += 1;
  const ups = base.length - common;
  const rest = dest.slice(common).join('/');
  return ups === 0 ? `./${rest}` : `${'../'.repeat(ups)}${rest}`;
}
