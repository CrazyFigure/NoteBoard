// NoteBoard 图片落盘位置决策
// 两种存放模式：
//  - sibling：文档同级子目录（默认，目录名 settings.file.imageDirName，默认 img）
//  - global：同步目录根下的统一目录（目录名 settings.file.globalImageDirName，默认 assets）
// 无论哪种模式，写入 Markdown 的始终是「相对当前文档目录」的路径，
// 保证同步到其它设备 / 平台（Windows、Android、网页）后仍能解析显示。
// 统一模式下，文档不在同步目录内（含未设置同步目录、跨盘等无法相对的情况）时回退到同级目录。

import type { ImageStorageMode } from '../../core/ipc/types';
import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSyncStore } from '../../stores/syncStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { isSubPath, joinPath, normalizePath, relativePathBetween } from '../explorer/pathUtils';

/** 同级图片目录默认名称 */
export const DEFAULT_IMAGE_DIR_NAME = 'img';
/** 统一图片目录默认名称 */
export const DEFAULT_GLOBAL_IMAGE_DIR_NAME = 'assets';

/** 统一模式回退到同级目录的原因 */
export type ImageFallbackReason = 'no-sync-root' | 'outside-sync-root';

/** 图片落盘目标 */
export interface ImageTarget {
  /** 图片写入的目录（绝对路径，平台分隔符） */
  targetDir: string;
  /** 写入 Markdown 的目录前缀（相对文档目录，`/` 分隔，如 `./img`、`../assets`） */
  linkDir: string;
  /** 是否实际使用了统一目录 */
  global: boolean;
  /** 提示文案中展示的目录名称 */
  label: string;
  /** 统一模式下回退到同级目录的原因 */
  fallbackReason?: ImageFallbackReason;
}

/** 计算图片目标所需的全部输入（纯数据，便于测试） */
export interface ImageTargetInput {
  /** 文档所在目录（未保存文档为资源管理器根目录） */
  baseDir: string;
  mode: ImageStorageMode | undefined;
  imageDirName: string | undefined;
  globalDirName: string | undefined;
  /** 同步目录根（未设置为空） */
  syncRoot: string | undefined;
}

// Windows 文件名禁止字符与 ASCII 控制字符上限，目录名中统一替换为下划线
const WINDOWS_INVALID_DIR_CHARS = new Set('<>:"|?*');
const ASCII_CONTROL_CHARACTER_MAX = 0x1f;

/** 替换单级目录名中的非法字符 */
function replaceInvalidDirChars(segment: string): string {
  return Array.from(segment, (character) =>
    character.charCodeAt(0) <= ASCII_CONTROL_CHARACTER_MAX || WINDOWS_INVALID_DIR_CHARS.has(character) ? '_' : character,
  ).join('');
}

/**
 * 清洗目录名设置：允许用 `/` 写多级子目录，去除首尾空白与分隔符，
 * 丢弃空段、`.` 与 `..`（禁止跳出基准目录），清洗后为空时使用默认值。
 * 返回各级目录名数组。
 */
export function sanitizeDirSegments(name: string | null | undefined, fallback: string): string[] {
  const segments = String(name ?? '')
    .split(/[\\/]+/)
    .map((segment) => replaceInvalidDirChars(segment.trim()).replace(/[. ]+$/, ''))
    .filter((segment) => segment && segment !== '.' && segment !== '..');
  return segments.length ? segments : [fallback];
}

/** 清洗后的目录名（`/` 分隔），用于提示文案与设置展示 */
export function sanitizeDirName(name: string | null | undefined, fallback: string): string {
  return sanitizeDirSegments(name, fallback).join('/');
}

/** 将多级目录名按平台分隔符拼到基准目录下 */
function joinSegments(baseDir: string, segments: string[]): string {
  return segments.reduce((dir, segment) => joinPath(dir, segment), baseDir);
}

/** 文档同级图片目录的绝对路径 */
export function siblingImageDir(docDir: string, imageDirName: string | undefined): string {
  return joinSegments(docDir, sanitizeDirSegments(imageDirName, DEFAULT_IMAGE_DIR_NAME));
}

/** 统一图片目录的绝对路径；未设置同步目录时返回 null */
export function globalImageDir(syncRoot: string | null | undefined, globalDirName: string | undefined): string | null {
  const root = normalizePath(syncRoot);
  if (!root) return null;
  return joinSegments(root, sanitizeDirSegments(globalDirName, DEFAULT_GLOBAL_IMAGE_DIR_NAME));
}

/** 相对路径写法统一以 `./` 或 `../` 开头，与现有 `./img/x.png` 风格保持一致 */
function toLinkDir(relative: string): string {
  if (!relative) return '.';
  return relative.startsWith('..') ? relative : `./${relative}`;
}

/** 根据设置与路径计算图片落盘目标（纯函数） */
export function computeImageTarget(input: ImageTargetInput): ImageTarget {
  const siblingSegments = sanitizeDirSegments(input.imageDirName, DEFAULT_IMAGE_DIR_NAME);
  const sibling: ImageTarget = {
    targetDir: joinSegments(input.baseDir, siblingSegments),
    linkDir: `./${siblingSegments.join('/')}`,
    global: false,
    label: `/${siblingSegments.join('/')}`,
  };
  if (input.mode !== 'global') return sibling;

  const globalDir = globalImageDir(input.syncRoot, input.globalDirName);
  if (!globalDir) return { ...sibling, fallbackReason: 'no-sync-root' };
  // 文档必须位于同步目录内：同步到其它设备后相对路径依然成立
  if (!isSubPath(input.syncRoot, input.baseDir)) return { ...sibling, fallbackReason: 'outside-sync-root' };
  const relative = relativePathBetween(input.baseDir, globalDir);
  if (relative === null) return { ...sibling, fallbackReason: 'outside-sync-root' };
  return {
    targetDir: globalDir,
    linkDir: toLinkDir(relative),
    global: true,
    label: `统一目录 /${sanitizeDirName(input.globalDirName, DEFAULT_GLOBAL_IMAGE_DIR_NAME)}`,
  };
}

/** 目标目录下某个图片文件的 Markdown 引用路径与磁盘路径 */
export function imageTargetPaths(target: ImageTarget, fileName: string): { linkPath: string; diskPath: string } {
  return {
    linkPath: `${target.linkDir}/${fileName}`,
    diskPath: joinPath(target.targetDir, fileName),
  };
}

/** 读取同步目录根：同步 Store 尚未加载配置时主动拉取一次，失败视为未设置 */
export async function getSyncRootDir(): Promise<string> {
  const store = useSyncStore.getState();
  let root = store.config?.sync.rootDir?.trim();
  if (root !== undefined) return root;
  if (!store.initialized) {
    try {
      await store.init();
    } catch {
      // 初始化失败按未设置同步目录处理
    }
    root = useSyncStore.getState().config?.sync.rootDir?.trim();
    if (root !== undefined) return root;
  }
  // 网页端无同步权限时不再请求，避免无意义的错误
  if (useSyncStore.getState().unavailableReason) return '';
  try {
    return (await ipc.syncGetConfig()).sync.rootDir?.trim() ?? '';
  } catch {
    return '';
  }
}

/** 当前文档的图片基准目录：已保存文档取所在目录，未保存时退回资源管理器根目录 */
export function imageBaseDir(docKey: string): string | null {
  const currentDoc = useDocumentStore.getState().getDocument(docKey);
  return currentDoc?.dirPath || useExplorerStore.getState().root || null;
}

/**
 * 解析当前文档插入图片的落盘目标；没有任何基准目录（新建未保存且未打开文件夹）时返回 null，
 * 由调用方使用 Base64 等兼容方案。
 */
export async function resolveImageTarget(docKey: string): Promise<ImageTarget | null> {
  const baseDir = imageBaseDir(docKey);
  if (!baseDir) return null;
  const file = useSettingsStore.getState().settings.file;
  const mode = file.imageStorageMode ?? 'sibling';
  // 只有统一模式才需要同步目录，同级模式不触发任何同步配置读取
  const syncRoot = mode === 'global' ? await getSyncRootDir() : '';
  return computeImageTarget({
    baseDir,
    mode,
    imageDirName: file.imageDirName,
    globalDirName: file.globalImageDirName,
    syncRoot,
  });
}

/** 已提示过的回退原因：每个会话每种原因只提示一次，避免反复打扰 */
const notifiedFallbacks = new Set<ImageFallbackReason>();

/** 回退说明；本会话已提示过时返回 null */
export function takeFallbackNotice(reason: ImageFallbackReason | undefined): string | null {
  if (!reason || notifiedFallbacks.has(reason)) return null;
  notifiedFallbacks.add(reason);
  return reason === 'no-sync-root'
    ? '未设置同步文件夹，统一图片目录暂不可用，已存入文档同级目录'
    : '当前文档不在同步文件夹内，已存入文档同级目录';
}

/** 测试用：重置已提示的回退原因 */
export function resetFallbackNoticesForTest(): void {
  notifiedFallbacks.clear();
}
