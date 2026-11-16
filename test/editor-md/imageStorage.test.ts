// 图片落盘位置决策：同级 / 统一目录两种模式、统一目录位置、同步 / 备份约束、回退规则与目录名清洗（路径按 Windows 语义）
import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ windows: true }));
vi.mock('../../src/core/platform', async (original) => ({
  ...await original<typeof import('../../src/core/platform')>(),
  get USES_WINDOWS_PATHS() { return platform.windows; },
}));

import {
  computeImageTarget,
  imageTargetPaths,
  resetFallbackNoticesForTest,
  resolveGlobalDir,
  sanitizeDirName,
  syncSnapshotOf,
  takeFallbackNotice,
} from '../../src/features/editor-md/imageStorage';
import type { SyncConfigFile } from '../../src/core/ipc/types';

const SYNC = 'C:\\Notes';
/** 同步文件夹已设置但同步、备份均未开启 */
const SYNC_IDLE = { root: SYNC, active: false };
/** 同步或自动备份已开启 */
const SYNC_ON = { root: SYNC, active: true };
const NO_SYNC = { root: '', active: false };

function target(baseDir: string, overrides: Partial<Parameters<typeof computeImageTarget>[0]> = {}) {
  return computeImageTarget({
    baseDir,
    mode: 'global',
    imageDirName: 'img',
    globalRoot: '',
    sync: SYNC_IDLE,
    ...overrides,
  });
}

afterEach(() => resetFallbackNoticesForTest());

describe('computeImageTarget', () => {
  it('同级模式：写入文档同级目录，引用 ./img', () => {
    const result = target('C:\\Notes\\daily', { mode: 'sibling' });
    expect(result).toMatchObject({ targetDir: 'C:\\Notes\\daily\\img', linkDir: './img', global: false });
    expect(result.notice).toBeUndefined();
  });

  it('缺省模式视为同级（旧配置无该字段）', () => {
    expect(target('C:\\Notes', { mode: undefined }).global).toBe(false);
  });

  it('统一模式：位置为空时跟随同步文件夹，与同级模式共用目录名', () => {
    const result = target('C:\\Notes');
    expect(result).toMatchObject({ targetDir: 'C:\\Notes\\img', linkDir: './img', global: true, label: '统一目录 /img' });
    expect(result.notice).toBeUndefined();
  });

  it('统一模式：多级子目录中的文档写入 ../ 相对路径', () => {
    expect(target('C:\\Notes\\a').linkDir).toBe('../img');
    expect(target('C:\\notes\\a\\b\\c').linkDir).toBe('../../../img');
  });

  it('统一模式：自定义目录名同时作用于统一目录', () => {
    expect(target('C:\\Notes\\a', { imageDirName: 'assets' })).toMatchObject({ targetDir: 'C:\\Notes\\assets', linkDir: '../assets' });
  });

  it('统一模式：位于统一目录内部的文档', () => {
    expect(target('C:\\Notes\\img').linkDir).toBe('.');
    expect(target('C:\\Notes\\img\\sub').linkDir).toBe('..');
  });

  it('统一模式：未设置同步文件夹时也可使用自选位置', () => {
    const result = target('C:\\Work\\a', { sync: NO_SYNC, globalRoot: 'C:\\Pictures' });
    expect(result).toMatchObject({ targetDir: 'C:\\Pictures\\img', linkDir: '../../Pictures/img', global: true });
    expect(result.notice).toBeUndefined();
  });

  it('统一模式：同步 / 备份未开启时，位置可以在同步文件夹外', () => {
    const result = target('C:\\Notes\\a', { globalRoot: 'C:\\Pictures' });
    expect(result).toMatchObject({ targetDir: 'C:\\Pictures\\img', linkDir: '../../Pictures/img', global: true });
    expect(result.notice).toBeUndefined();
  });

  it('统一模式：同步 / 备份开启且位置在同步文件夹外时，改存同步文件夹下的同名目录并提示', () => {
    const result = target('C:\\Notes\\a', { globalRoot: 'C:\\Pictures', sync: SYNC_ON });
    expect(result).toMatchObject({ targetDir: 'C:\\Notes\\img', linkDir: '../img', global: true, notice: 'redirected-to-sync' });
    // 同步文件夹外的文档同样使用同步文件夹内的统一目录（统一目录只有一个）
    expect(target('C:\\Other', { globalRoot: 'C:\\Pictures', sync: SYNC_ON })).toMatchObject({ targetDir: 'C:\\Notes\\img', linkDir: '../Notes/img' });
  });

  it('统一模式：同步 / 备份开启且位置在同步文件夹内时照常使用', () => {
    const result = target('C:\\Notes\\a', { globalRoot: 'C:\\Notes\\res', sync: SYNC_ON });
    expect(result).toMatchObject({ targetDir: 'C:\\Notes\\res\\img', linkDir: '../res/img' });
    expect(result.notice).toBeUndefined();
  });

  it('统一模式：既无位置也无同步文件夹时回退同级', () => {
    const result = target('C:\\Notes\\a', { sync: NO_SYNC });
    expect(result).toMatchObject({ targetDir: 'C:\\Notes\\a\\img', linkDir: './img', global: false, notice: 'no-global-dir' });
  });

  it('统一模式：同步文件夹外（同盘）的文档也写入相对路径', () => {
    expect(target('C:\\Other')).toMatchObject({ targetDir: 'C:\\Notes\\img', linkDir: '../Notes/img', global: true });
    // 前缀相同但不是子目录
    expect(target('C:\\NotesArchive').linkDir).toBe('../Notes/img');
  });

  it('统一模式：跨盘无法相对时回退同级', () => {
    expect(target('D:\\Notes\\a')).toMatchObject({ targetDir: 'D:\\Notes\\a\\img', global: false, notice: 'cross-drive' });
  });

  it('多级目录名按平台分隔符落盘、按 / 写入引用', () => {
    const result = target('C:\\Notes\\a', { imageDirName: 'res/images' });
    expect(result.targetDir).toBe('C:\\Notes\\res\\images');
    expect(result.linkDir).toBe('../res/images');
    const { linkPath, diskPath } = imageTargetPaths(result, '1_shot.png');
    expect(linkPath).toBe('../res/images/1_shot.png');
    expect(diskPath).toBe('C:\\Notes\\res\\images\\1_shot.png');
  });
});

describe('resolveGlobalDir', () => {
  it('位置为空跟随同步文件夹', () => {
    expect(resolveGlobalDir({ globalRoot: '', imageDirName: 'img', sync: SYNC_IDLE })).toEqual({
      configuredDir: 'C:\\Notes\\img',
      effectiveDir: 'C:\\Notes\\img',
      followsSync: true,
      outsideSync: false,
    });
  });

  it('同步 / 备份开启时，同步文件夹外的位置记为 outsideSync', () => {
    expect(resolveGlobalDir({ globalRoot: 'D:\\Pics', imageDirName: 'img', sync: SYNC_ON })).toEqual({
      configuredDir: 'D:\\Pics\\img',
      effectiveDir: 'C:\\Notes\\img',
      followsSync: false,
      outsideSync: true,
    });
  });

  it('同步文件夹本身作为位置不算在外', () => {
    expect(resolveGlobalDir({ globalRoot: 'c:\\notes', imageDirName: 'img', sync: SYNC_ON }).outsideSync).toBe(false);
  });
});

describe('syncSnapshotOf', () => {
  const config = (rootDir: string, enabled: boolean, autoEnabled: boolean) =>
    ({ sync: { rootDir, enabled }, backup: { autoEnabled } }) as unknown as SyncConfigFile;

  it('同步或自动备份任一开启即视为开启', () => {
    expect(syncSnapshotOf(config('C:\\Notes', true, false))).toEqual({ root: 'C:\\Notes', active: true });
    expect(syncSnapshotOf(config('C:\\Notes', false, true))).toEqual({ root: 'C:\\Notes', active: true });
    expect(syncSnapshotOf(config('C:\\Notes', false, false))).toEqual({ root: 'C:\\Notes', active: false });
  });

  it('未设置同步文件夹时不算开启', () => {
    expect(syncSnapshotOf(config('  ', true, true))).toEqual({ root: '', active: false });
    expect(syncSnapshotOf(null)).toEqual({ root: '', active: false });
  });
});

describe('sanitizeDirName', () => {
  it.each([
    ['', 'img'],
    ['   ', 'img'],
    ['../x', 'x'],
    ['..', 'img'],
    ['/a//b/', 'a/b'],
    ['a\\b', 'a/b'],
    ['图 片?', '图 片_'],
    ['assets. ', 'assets'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeDirName(input, 'img')).toBe(expected);
  });
});

describe('takeFallbackNotice', () => {
  it('每种情况每个会话只提示一次', () => {
    expect(takeFallbackNotice('cross-drive')).toBeTruthy();
    expect(takeFallbackNotice('cross-drive')).toBeNull();
    expect(takeFallbackNotice('no-global-dir')).toBeTruthy();
    expect(takeFallbackNotice('redirected-to-sync')).toContain('同步文件夹');
    expect(takeFallbackNotice(undefined)).toBeNull();
  });
});
