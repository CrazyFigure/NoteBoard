// NoteBoard docKind 映射测试
// 详见 docs/08-数据契约与持久化.md §5.2

import { describe, test, expect } from 'vitest';
import {
  KIND_BY_EXT,
  LANGUAGE_BY_EXT,
  extFromPath,
  kindFromPath,
  languageFromPath,
  savePolicyOf,
  isEditable,
} from '@/core/docKind';
import type { DocumentKind } from '@/core/ipc/types';

describe('docKind 扩展名映射', () => {
  test('KIND_BY_EXT 覆盖全部点名格式与图片格式', () => {
    const requiredExts = [
      'md',
      'markdown',
      'txt',
      'sql',
      'json',
      'yaml',
      'yml',
      'xml',
      'excalidraw',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'ico',
      'svg',
      'bmp',
    ];
    for (const ext of requiredExts) {
      expect(KIND_BY_EXT[ext]).toBeDefined();
    }
  });

  test('每个 kind 的 savePolicy 推导正确', () => {
    expect(savePolicyOf('markdown')).toBe('auto');
    expect(savePolicyOf('board')).toBe('auto');
    expect(savePolicyOf('code')).toBe('manual');
    expect(savePolicyOf('image')).toBe('manual');
    expect(savePolicyOf('unsupported')).toBe('manual');
  });

  test('extFromPath 正确提取扩展名', () => {
    expect(extFromPath('test.md')).toBe('md');
    expect(extFromPath('D:\\notes\\test.MD')).toBe('md');
    expect(extFromPath('noext')).toBe('');
    expect(extFromPath('path.to/file.json')).toBe('json');
    expect(extFromPath('avatar.PNG')).toBe('png');
    expect(extFromPath('banner.webp')).toBe('webp');
    expect(extFromPath('icon.ico')).toBe('ico');
  });

  test('kindFromPath 路径推断', () => {
    expect(kindFromPath('D:\\notes\\test.md')).toBe<DocumentKind>('markdown');
    expect(kindFromPath('schema.sql')).toBe<DocumentKind>('code');
    expect(kindFromPath('config.yaml')).toBe<DocumentKind>('code');
    expect(kindFromPath('diagram.excalidraw')).toBe<DocumentKind>('board');
    expect(kindFromPath('photo.png')).toBe<DocumentKind>('image');
    expect(kindFromPath('animation.gif')).toBe<DocumentKind>('image');
    expect(kindFromPath('modern.webp')).toBe<DocumentKind>('image');
    expect(kindFromPath('app.ico')).toBe<DocumentKind>('image');
    expect(kindFromPath('vector.svg')).toBe<DocumentKind>('image');
    expect(kindFromPath('unknown.xyz')).toBe<DocumentKind>('code');
  });

  test('languageFromPath 路径推断', () => {
    expect(languageFromPath('test.md')).toBe('markdown');
    expect(languageFromPath('schema.sql')).toBe('sql');
    expect(languageFromPath('config.yaml')).toBe('yaml');
    expect(languageFromPath('config.yml')).toBe('yaml');
    expect(languageFromPath('data.xml')).toBe('xml');
    expect(languageFromPath('notes.txt')).toBe('plaintext');
    expect(languageFromPath('unknown.xyz')).toBe('plaintext');
  });

  test('isEditable 判断', () => {
    expect(isEditable('markdown')).toBe(true);
    expect(isEditable('code')).toBe(true);
    expect(isEditable('board')).toBe(true);
    expect(isEditable('image')).toBe(false);
    expect(isEditable('unsupported')).toBe(false);
  });
});
