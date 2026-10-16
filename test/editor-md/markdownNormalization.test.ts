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

  it.each([
    ['行尾空格', '- 设计取舍。 \n', '- 设计取舍。\n', 'trailing-whitespace'],
    ['多余空行', 'a\n\n\n\nb\n', 'a\n\nb\n', 'whitespace'],
    ['有序列表重新编号', '1. a\n1. b\n', '1. a\n2. b\n', 'list-number'],
    ['分隔线', 'a\n\n***\n\nb\n', 'a\n\n---\n\nb\n', 'horizontal-rule'],
    ['缩进代码块', 'a\n\n    code\n\nb\n', 'a\n\n```\ncode\n```\n\nb\n', 'code-fence'],
    ['表格', '|a|b|\n|-|-|\n', '| a   | b   |\n| --- | --- |\n', 'table'],
    ['自动链接', '<https://a.com>\n', '[https://a.com](https://a.com)\n', 'link'],
    ['br 换行', 'a<br>b\n', 'a  \nb\n', 'line-break'],
    ['有序列表续段缩进', '1. a\n\n  b\n', '1. a\n\n   b\n', 'list-indent'],
    ['实体写为字符', 'a &copy; b\n', 'a © b\n', 'entity'],
    ['不间断空格写为实体', 'a b\n', 'a&nbsp;b\n', 'entity'],
  ])('逐处分类：%s', async (_name, original, normalized, category) => {
    const result = await computeNormalizationDiff(original, normalized);
    expect(result.hunks.map((hunk) => hunk.category)).toEqual([category]);
  });

  it('无差异时返回空结果', async () => {
    const result = await computeNormalizationDiff('same\n', 'same\n');
    expect(result.hunks).toEqual([]);
    expect(result.categories).toEqual([]);
  });
});
