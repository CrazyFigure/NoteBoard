// NoteBoard lint 测试
// JSON / YAML / XML 语法错误诊断
// 详见 docs/09-开发路线图.md gate:4

import { describe, it, expect } from 'vitest';
import { getLinterForLanguage } from '../../src/features/editor-code/lint';
import { linter } from '@codemirror/lint';
import type { LanguageId } from '../../src/core/ipc/types';

describe('getLinterForLanguage', () => {
  it('json 返回 linter 扩展', () => {
    const ext = getLinterForLanguage('json' as LanguageId);
    expect(ext).not.toBeNull();
  });

  it('yaml 返回 linter 扩展', () => {
    const ext = getLinterForLanguage('yaml' as LanguageId);
    expect(ext).not.toBeNull();
  });

  it('xml 返回 linter 扩展', () => {
    const ext = getLinterForLanguage('xml' as LanguageId);
    expect(ext).not.toBeNull();
  });

  it('plaintext 无 linter', () => {
    const ext = getLinterForLanguage('plaintext' as LanguageId);
    expect(ext).toBeNull();
  });

  it('sql 无 linter', () => {
    const ext = getLinterForLanguage('sql' as LanguageId);
    expect(ext).toBeNull();
  });

  it('markdown 无 linter', () => {
    const ext = getLinterForLanguage('markdown' as LanguageId);
    expect(ext).toBeNull();
  });
});
