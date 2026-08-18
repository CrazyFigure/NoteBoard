// NoteBoard highlightStyle 映射测试
// 验证 @lezer/highlight tag → --hljs-* 映射覆盖全部条目
// 详见 docs/09-开发路线图.md gate:4

import { describe, it, expect } from 'vitest';
import { nbHighlightStyle, SPEC } from '../../src/features/editor-code/highlightStyle';
import { tags as t } from '@lezer/highlight';

describe('highlightStyle', () => {
  it('nbHighlightStyle 应已定义', () => {
    expect(nbHighlightStyle).toBeDefined();
  });

  it('SPEC 包含 comment 映射', () => {
    const commentSpec = SPEC.find((s) => {
      const tags = Array.isArray(s.tag) ? s.tag : [s.tag];
      return tags.includes(t.comment);
    });
    expect(commentSpec).toBeDefined();
    expect(commentSpec?.color).toBe('var(--hljs-comment)');
    expect(commentSpec?.fontStyle).toBe('italic');
  });

  it('SPEC 包含 keyword 映射', () => {
    const keywordSpec = SPEC.find((s) => {
      const tags = Array.isArray(s.tag) ? s.tag : [s.tag];
      return tags.includes(t.keyword);
    });
    expect(keywordSpec).toBeDefined();
    expect(keywordSpec?.color).toBe('var(--hljs-keyword)');
  });

  it('SPEC 包含 string 映射', () => {
    const stringSpec = SPEC.find((s) => {
      const tags = Array.isArray(s.tag) ? s.tag : [s.tag];
      return tags.includes(t.string);
    });
    expect(stringSpec).toBeDefined();
    expect(stringSpec?.color).toBe('var(--hljs-string)');
  });

  it('SPEC 包含 number 映射', () => {
    const numberSpec = SPEC.find((s) => {
      const tags = Array.isArray(s.tag) ? s.tag : [s.tag];
      return tags.includes(t.number);
    });
    expect(numberSpec).toBeDefined();
    expect(numberSpec?.color).toBe('var(--hljs-number)');
  });

  it('SPEC 包含 heading 映射且加粗', () => {
    const headingSpec = SPEC.find((s) => {
      const tags = Array.isArray(s.tag) ? s.tag : [s.tag];
      return tags.includes(t.heading);
    });
    expect(headingSpec).toBeDefined();
    expect(headingSpec?.color).toBe('var(--editor-heading)');
    expect(headingSpec?.fontWeight).toBe('bold');
  });

  it('SPEC 包含 invalid 映射且有波浪下划线', () => {
    const invalidSpec = SPEC.find((s) => {
      const tags = Array.isArray(s.tag) ? s.tag : [s.tag];
      return tags.includes(t.invalid);
    });
    expect(invalidSpec).toBeDefined();
    expect(invalidSpec?.color).toBe('var(--error-500)');
    expect(invalidSpec?.textDecoration).toContain('wavy');
  });

  it('SPEC 包含 link 映射且有下划线', () => {
    const linkSpec = SPEC.find((s) => {
      const tags = Array.isArray(s.tag) ? s.tag : [s.tag];
      return tags.includes(t.link);
    });
    expect(linkSpec).toBeDefined();
    expect(linkSpec?.color).toBe('var(--hljs-link)');
    expect(linkSpec?.textDecoration).toContain('underline');
  });

  it('SPEC 包含 operator → --editor-text-secondary', () => {
    const opSpec = SPEC.find((s) => {
      const tags = Array.isArray(s.tag) ? s.tag : [s.tag];
      return tags.includes(t.operator);
    });
    expect(opSpec).toBeDefined();
    expect(opSpec?.color).toBe('var(--editor-text-secondary)');
  });

  it('SPEC 包含 punctuation → --editor-text-secondary', () => {
    const punctSpec = SPEC.find((s) => {
      const tags = Array.isArray(s.tag) ? s.tag : [s.tag];
      return tags.includes(t.punctuation);
    });
    expect(punctSpec).toBeDefined();
    expect(punctSpec?.color).toBe('var(--editor-text-secondary)');
  });

  it('SPEC 总条目数 > 15', () => {
    expect(SPEC.length).toBeGreaterThan(15);
  });
});
