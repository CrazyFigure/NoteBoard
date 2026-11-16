// 图片落盘位置决策：同级 / 统一目录两种模式、回退规则与目录名清洗（路径按 Windows 语义）
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
  sanitizeDirName,
  takeFallbackNotice,
} from '../../src/features/editor-md/imageStorage';

const SYNC = 'C:\\Notes';

function target(baseDir: string, overrides: Partial<Parameters<typeof computeImageTarget>[0]> = {}) {
  return computeImageTarget({
    baseDir,
    mode: 'global',
    imageDirName: 'img',
    globalDirName: 'assets',
    syncRoot: SYNC,
    ...overrides,
  });
}

afterEach(() => resetFallbackNoticesForTest());

describe('computeImageTarget', () => {
  it('同级模式：写入文档同级目录，引用 ./img', () => {
    const result = target('C:\\Notes\\daily', { mode: 'sibling' });
    expect(result).toMatchObject({ targetDir: 'C:\\Notes\\daily\\img', linkDir: './img', global: false });
    expect(result.fallbackReason).toBeUndefined();
  });

  it('缺省模式视为同级（旧配置无该字段）', () => {
    expect(target('C:\\Notes', { mode: undefined }).global).toBe(false);
  });

  it('统一模式：同步目录根下的文档引用 ./assets', () => {
    const result = target('C:\\Notes');
    expect(result).toMatchObject({ targetDir: 'C:\\Notes\\assets', linkDir: './assets', global: true });
  });

  it('统一模式：多级子目录中的文档写入 ../ 相对路径', () => {
    expect(target('C:\\Notes\\a').linkDir).toBe('../assets');
    expect(target('C:\\notes\\a\\b\\c').linkDir).toBe('../../../assets');
  });

  it('统一模式：位于统一目录内部的文档', () => {
    expect(target('C:\\Notes\\assets').linkDir).toBe('.');
    expect(target('C:\\Notes\\assets\\sub').linkDir).toBe('..');
  });

  it('统一模式：未设置同步目录时回退同级', () => {
    const result = target('C:\\Notes\\a', { syncRoot: '' });
    expect(result).toMatchObject({ targetDir: 'C:\\Notes\\a\\img', linkDir: './img', global: false, fallbackReason: 'no-sync-root' });
  });

  it('统一模式：同步目录外（含跨盘）的文档回退同级', () => {
    expect(target('C:\\Other').fallbackReason).toBe('outside-sync-root');
    expect(target('D:\\Notes\\a').fallbackReason).toBe('outside-sync-root');
    // 前缀相同但不是子目录
    expect(target('C:\\NotesArchive').fallbackReason).toBe('outside-sync-root');
  });

  it('多级目录名按平台分隔符落盘、按 / 写入引用', () => {
    const result = target('C:\\Notes\\a', { globalDirName: 'res/images' });
    expect(result.targetDir).toBe('C:\\Notes\\res\\images');
    expect(result.linkDir).toBe('../res/images');
    const { linkPath, diskPath } = imageTargetPaths(result, '1_shot.png');
    expect(linkPath).toBe('../res/images/1_shot.png');
    expect(diskPath).toBe('C:\\Notes\\res\\images\\1_shot.png');
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
  it('每种原因每个会话只提示一次', () => {
    expect(takeFallbackNotice('outside-sync-root')).toBeTruthy();
    expect(takeFallbackNotice('outside-sync-root')).toBeNull();
    expect(takeFallbackNotice('no-sync-root')).toBeTruthy();
    expect(takeFallbackNotice(undefined)).toBeNull();
  });
});
