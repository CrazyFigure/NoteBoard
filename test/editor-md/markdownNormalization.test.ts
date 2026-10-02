// NoteBoard Markdown 规范化决策与差异摘要测试

import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeNormalizationDiff,
  moveNormalizationChoice,
  rememberNormalizationChoice,
  resetNormalizationMemory,
  resolveNormalizationPolicy,
} from '../../src/features/editor-md/markdownNormalization';

describe('规范化策略', () => {
  beforeEach(() => {
    resetNormalizationMemory();
  });

  it('未设置时默认每次询问', () => {
    expect(resolveNormalizationPolicy('a.md', undefined)).toBe('ask');
  });

  it('全局设置生效', () => {
    expect(resolveNormalizationPolicy('a.md', 'always')).toBe('always');
    expect(resolveNormalizationPolicy('a.md', 'never')).toBe('never');
  });

  it('会话内记住的选择优先于全局设置，且只作用于对应文档', () => {
    rememberNormalizationChoice('a.md', 'source');
    expect(resolveNormalizationPolicy('a.md', 'always')).toBe('never');
    expect(resolveNormalizationPolicy('b.md', 'ask')).toBe('ask');
    rememberNormalizationChoice('b.md', 'normalize');
    expect(resolveNormalizationPolicy('b.md', 'never')).toBe('always');
  });

  it('文档身份迁移时记忆跟随', () => {
    rememberNormalizationChoice('untitled:1', 'normalize');
    moveNormalizationChoice('untitled:1', 'C:\\notes\\a.md');
    expect(resolveNormalizationPolicy('untitled:1', 'ask')).toBe('ask');
    expect(resolveNormalizationPolicy('C:\\notes\\a.md', 'ask')).toBe('always');
  });
});

describe('差异摘要', () => {
  it('按整行给出差异块并分类', async () => {
    const original = '# 标题\n\n* a\n* b\n\n正文 _强调_ 文本\n';
    const normalized = '# 标题\n\n- a\n- b\n\n正文 *强调* 文本\n';
    const result = await computeNormalizationDiff(original, normalized);
    expect(result.hunks.length).toBe(2);
    expect(result.hunks[0]).toMatchObject({ before: '* a\n* b', after: '- a\n- b', line: 3 });
    const categories = Object.fromEntries(result.categories.map((item) => [item.category, item.count]));
    expect(categories['list-marker']).toBe(1);
    expect(categories.emphasis).toBe(1);
  });

  it('无差异时返回空结果', async () => {
    const result = await computeNormalizationDiff('same\n', 'same\n');
    expect(result.hunks).toEqual([]);
    expect(result.categories).toEqual([]);
  });
});
