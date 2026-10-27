import { describe, expect, it } from 'vitest';
import {
  CREATE_FORMATS,
  DEFAULT_CREATE_FORMATS,
  createFormatLabel,
  getCreateFormat,
  isDefaultCreateFormats,
  resolveCreateFormats,
} from '../../src/features/welcome/createFormats';

describe('新建格式入口布局', () => {
  it('缺省配置回落为默认布局', () => {
    const resolved = resolveCreateFormats(undefined);
    expect(resolved.primary).toEqual(DEFAULT_CREATE_FORMATS.primary);
    expect(resolved.more).toEqual(DEFAULT_CREATE_FORMATS.more);
    expect(isDefaultCreateFormats(resolved)).toBe(true);
  });

  it('剔除未知与重复项，并把缺失格式按默认分组补到末尾', () => {
    const resolved = resolveCreateFormats({
      primary: ['sql', 'unknown', 'markdown', 'sql'],
      more: ['markdown', 'text'],
    });
    expect(resolved.primary.slice(0, 2)).toEqual(['sql', 'markdown']);
    expect(resolved.more.slice(0, 1)).toEqual(['text']);
    // 每个格式恰好出现一次
    const all = [...resolved.primary, ...resolved.more];
    expect(new Set(all).size).toBe(CREATE_FORMATS.length);
    expect(all).toHaveLength(CREATE_FORMATS.length);
    // 未出现的默认直接展示项补在直接展示末尾，默认更多项补在更多末尾
    expect(resolved.primary).toContain('bitable');
    expect(resolved.more).toContain('drawio');
  });

  it('允许某一侧为空', () => {
    const resolved = resolveCreateFormats({ primary: [], more: [...DEFAULT_CREATE_FORMATS.primary, ...DEFAULT_CREATE_FORMATS.more] });
    expect(resolved.primary).toEqual([]);
    expect(resolved.more).toHaveLength(CREATE_FORMATS.length);
  });

  it('显示名不加「新建」，附带扩展名', () => {
    expect(createFormatLabel(getCreateFormat('markdown'))).toBe('Markdown 笔记 (.md)');
    expect(createFormatLabel(getCreateFormat('drawio'))).toBe('架构图 (.drawio)');
    expect(createFormatLabel(getCreateFormat('board'))).toBe('手绘风白板 (.excalidraw)');
    expect(createFormatLabel(getCreateFormat('textdiff'))).toBe('文本对比');
  });
});
