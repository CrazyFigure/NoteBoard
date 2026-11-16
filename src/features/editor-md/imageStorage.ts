// NoteBoard 图片落盘位置决策
// 两种存放模式共用同一个目录名 settings.file.imageDirName（默认 img）：
//  - sibling：文档同级子目录 `<文档目录>/<目录名>`（默认模式）
//  - global：统一目录 `<统一目录位置>/<目录名>`；位置可随时任选，留空时跟随同步文件夹
// 同时开启同步 / 备份时，统一目录必须位于同步文件夹内才能随笔记一起同步与备份：
// 设置的位置在同步文件夹外时，新图片改存同步文件夹下的同名目录，并提示用户迁移原有图片。
// 无论哪种模式，写入 Markdown 的始终是「相对当前文档目录」的路径，
// 保证同步到其它设备 / 平台（Windows、Android、网页）后仍能解析显示。
// 统一模式下无法得到统一目录（未设置位置）或无法相对（跨盘）时回退到同级目录。

import type { ImageStorageMode, SyncConfigFile } from '../../core/ipc/types';
import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSyncStore } from '../../stores/syncStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { isSubPath, joinPath, normalizePath, pathKey, relativePathBetween } from '../explorer/pathUtils';

/** 图片目录默认名称（同级与统一两种模式共用） */
export const DEFAULT_IMAGE_DIR_NAME = 'img';

/** 统一模式回退到同级目录的原因：未设置统一目录位置 / 与统一目录跨盘无法相对 */
export type ImageFallbackReason = 'no-global-dir' | 'cross-drive';

/** 插入图片时需要提示一次的情况：回退同级，或因同步 / 备份改存同步文件夹 */
export type ImageNoticeReason = ImageFallbackReason | 'redirected-to-sync';

/** 图片落盘目标 */
export interface ImageTarget {
  /** 图片写入的目录（绝对路径，平台分隔符） */
  targetDir: string;
  /** 写入 Markdown 的目录前缀（相对文档目录，`/` 分隔，如 `./img`、`../img`） */
  linkDir: string;
  /** 是否实际使用了统一目录 */
  global: boolean;
  /** 提示文案中展示的目录名称 */
  label: string;
  /** 需要提示用户的情况 */
  notice?: ImageNoticeReason;
}

/** 同步配置中与图片目录相关的部分 */
export interface SyncSnapshot {
  /** 同步文件夹（未设置为空） */
  root: string;
  /** 多端同步或自动备份已开启：此时统一目录必须位于同步文件夹内 */
  active: boolean;
}

/** 统一目录相关的设置输入 */
export interface GlobalDirInput {
  /** 统一目录所在位置；为空时跟随同步文件夹 */
  globalRoot: string | undefined;
  imageDirName: string | undefined;
  sync: SyncSnapshot;
}

/** 计算图片目标所需的全部输入（纯数据，便于测试） */
export interface ImageTargetInput extends GlobalDirInput {
  /** 文档所在目录（未保存文档为资源管理器根目录） */
  baseDir: string;
  mode: ImageStorageMode | undefined;
}

/** 统一目录的解析结果 */
export interface GlobalDirState {
  /** 按用户设置得到的统一目录（未设置位置且无同步文件夹时为 null） */
  configuredDir: string | null;
  /** 实际使用的统一目录：同步 / 备份开启且设置的目录在同步文件夹外时，改为同步文件夹下的同名目录 */
  effectiveDir: string | null;
  /** 位置为空，跟随同步文件夹 */
  followsSync: boolean;
  /** 同步 / 备份已开启，但设置的统一目录不在同步文件夹内 */
  outsideSync: boolean;
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

/** 位置目录下的图片目录绝对路径；位置为空时返回 null */
export function globalImageDir(root: string | null | undefined, imageDirName: string | undefined): string | null {
  const base = normalizePath(root?.trim());
  if (!base) return null;
  return joinSegments(base, sanitizeDirSegments(imageDirName, DEFAULT_IMAGE_DIR_NAME));
}

/** 同步配置快照：同步文件夹已设置，且多端同步或自动备份开启时视为「同步 / 备份已开启」 */
export function syncSnapshotOf(config: SyncConfigFile | null | undefined): SyncSnapshot {
  const root = config?.sync.rootDir?.trim() ?? '';
  return { root, active: !!root && !!(config?.sync.enabled || config?.backup.autoEnabled) };
}

/** 解析统一目录：位置为空跟随同步文件夹；同步 / 备份开启时强制位于同步文件夹内 */
export function resolveGlobalDir(input: GlobalDirInput): GlobalDirState {
  const location = input.globalRoot?.trim() ?? '';
  const followsSync = !location;
  const configuredDir = globalImageDir(location || input.sync.root, input.imageDirName);
  const syncDir = globalImageDir(input.sync.root, input.imageDirName);
  const outsideSync = input.sync.active && !!configuredDir && !!syncDir && !isSubPath(input.sync.root, configuredDir);
  return { configuredDir, effectiveDir: outsideSync ? syncDir : configuredDir, followsSync, outsideSync };
}

/** 相对路径写法统一以 `./` 或 `../` 开头，与现有 `./img/x.png` 风格保持一致 */
function toLinkDir(relative: string): string {
  if (!relative) return '.';
  return relative.startsWith('..') ? relative : `./${relative}`;
}

/** 根据设置与路径计算图片落盘目标（纯函数） */
export function computeImageTarget(input: ImageTargetInput): ImageTarget {
  const segments = sanitizeDirSegments(input.imageDirName, DEFAULT_IMAGE_DIR_NAME);
  const dirName = segments.join('/');
  const sibling: ImageTarget = {
    targetDir: joinSegments(input.baseDir, segments),
    linkDir: `./${dirName}`,
    global: false,
    label: `/${dirName}`,
  };
  if (input.mode !== 'global') return sibling;

  const { effectiveDir, outsideSync } = resolveGlobalDir(input);
  if (!effectiveDir) return { ...sibling, notice: 'no-global-dir' };
  // Windows 跨盘无法写相对路径，退回同级目录保证可移植
  const relative = relativePathBetween(input.baseDir, effectiveDir);
  if (relative === null) return { ...sibling, notice: 'cross-drive' };
  return {
    targetDir: effectiveDir,
    linkDir: toLinkDir(relative),
    global: true,
    label: `统一目录 /${dirName}`,
    ...(outsideSync ? { notice: 'redirected-to-sync' as const } : {}),
  };
}

/** 目标目录下某个图片文件的 Markdown 引用路径与磁盘路径 */
export function imageTargetPaths(target: ImageTarget, fileName: string): { linkPath: string; diskPath: string } {
  return {
    linkPath: `${target.linkDir}/${fileName}`,
    diskPath: joinPath(target.targetDir, fileName),
  };
}

/** 两个目录是否相同（大小写与分隔符按平台规则比较） */
export function sameDir(left: string | null | undefined, right: string | null | undefined): boolean {
  return !!left && !!right && pathKey(left) === pathKey(right);
}

/** 读取同步配置：同步 Store 尚未加载配置时主动拉取一次，失败视为未设置 */
export async function getSyncSnapshot(): Promise<SyncSnapshot> {
  const store = useSyncStore.getState();
  if (store.config) return syncSnapshotOf(store.config);
  if (!store.initialized) {
    try {
      await store.init();
    } catch {
      // 初始化失败按未设置同步目录处理
    }
    const config = useSyncStore.getState().config;
    if (config) return syncSnapshotOf(config);
  }
  // 网页端无同步权限时不再请求，避免无意义的错误
  if (useSyncStore.getState().unavailableReason) return syncSnapshotOf(null);
  try {
    return syncSnapshotOf(await ipc.syncGetConfig());
  } catch {
    return syncSnapshotOf(null);
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
  // 只有统一模式才需要同步配置，同级模式不触发任何同步配置读取
  const sync = mode === 'global' ? await getSyncSnapshot() : syncSnapshotOf(null);
  return computeImageTarget({
    baseDir,
    mode,
    imageDirName: file.imageDirName,
    globalRoot: file.imageGlobalRoot,
    sync,
  });
}

/** 已提示过的情况：每个会话每种情况只提示一次，避免反复打扰 */
const notifiedReasons = new Set<ImageNoticeReason>();

/** 提示文案 */
const NOTICE_TEXT: Record<ImageNoticeReason, string> = {
  'no-global-dir': '尚未设置统一目录的位置，已存入文档同级目录，可在「设置 › 文件与保存 › 图片目录设置」中选择位置',
  'cross-drive': '当前文档与统一目录不在同一磁盘，已存入文档同级目录',
  'redirected-to-sync': '已开启同步 / 备份，统一目录需位于同步文件夹内，已存入同步文件夹下的统一目录；原有图片可在「设置 › 文件与保存 › 图片目录设置」中一键迁移',
};

/** 提示说明；本会话已提示过时返回 null */
export function takeFallbackNotice(reason: ImageNoticeReason | undefined): string | null {
  if (!reason || notifiedReasons.has(reason)) return null;
  notifiedReasons.add(reason);
  return NOTICE_TEXT[reason];
}

/** 测试用：重置已提示的情况 */
export function resetFallbackNoticesForTest(): void {
  notifiedReasons.clear();
}
