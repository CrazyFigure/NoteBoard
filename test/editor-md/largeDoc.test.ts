// NoteBoard 大文档判定测试
// 详见 docs/09-开发路线图.md 7.15, gate:7

import { describe, it, expect } from 'vitest';
import {
  judgeLargeDoc,
  shouldSkipCodeBlockHighlight,
  shouldUseHighlightAuto,
  shouldConfirmBeforeOpen,
  THRESHOLDS,
} from '../../src/features/editor-md/largeDoc';

describe('largeDoc 判定', () => {
  describe('judgeLargeDoc', () => {
    it('正常文档 → isLarge=false, suggestedMode=visual', () => {
      const content = 'Hello World';
      const verdict = judgeLargeDoc(content);

      expect(verdict.isLarge).toBe(false);
      expect(verdict.suggestedMode).toBe('visual');
      expect(verdict.charCount).toBe(11);
    });

    it('接近 visual 阈值但未超过 → 仍为 visual', () => {
      const content = 'a'.repeat(THRESHOLDS.VISUAL_MODE_LIMIT);
      const verdict = judgeLargeDoc(content);

      expect(verdict.isLarge).toBe(false);
      expect(verdict.suggestedMode).toBe('visual');
    });

    it('超过 visual 阈值 → isLarge=true, suggestedMode=source', () => {
      const content = 'a'.repeat(THRESHOLDS.VISUAL_MODE_LIMIT + 1);
      const verdict = judgeLargeDoc(content);

      expect(verdict.isLarge).toBe(true);
      expect(verdict.suggestedMode).toBe('source');
      expect(verdict.threshold).toBe(THRESHOLDS.VISUAL_MODE_LIMIT);
    });

    it('超过 section 阈值 → suggestedMode=section', () => {
      const content = 'a'.repeat(THRESHOLDS.SECTION_MODE_LIMIT + 1);
      const verdict = judgeLargeDoc(content);

      expect(verdict.isLarge).toBe(true);
      expect(verdict.suggestedMode).toBe('section');
      expect(verdict.threshold).toBe(THRESHOLDS.SECTION_MODE_LIMIT);
    });

    it('空文档 → isLarge=false', () => {
      const verdict = judgeLargeDoc('');

      expect(verdict.isLarge).toBe(false);
      expect(verdict.charCount).toBe(0);
    });

    it('提前 return：大文档不需要完整扫描', () => {
      // 超过 section 阈值的文档应该在第一次比较就 return
      const content = 'a'.repeat(THRESHOLDS.SECTION_MODE_LIMIT + 1);
      const verdict = judgeLargeDoc(content);

      // 应该是 section 模式，而不是继续检查 visual
      expect(verdict.suggestedMode).toBe('section');
    });
  });

  describe('shouldSkipCodeBlockHighlight', () => {
    it('短代码块 → 不跳过高亮', () => {
      expect(shouldSkipCodeBlockHighlight('const x = 1;')).toBe(false);
    });

    it('超过 20k → 跳过高亮', () => {
      const code = 'a'.repeat(THRESHOLDS.SINGLE_BLOCK_LIMIT + 1);
      expect(shouldSkipCodeBlockHighlight(code)).toBe(true);
    });

    it('刚好 20k → 不跳过', () => {
      const code = 'a'.repeat(THRESHOLDS.SINGLE_BLOCK_LIMIT);
      expect(shouldSkipCodeBlockHighlight(code)).toBe(false);
    });
  });

  describe('shouldUseHighlightAuto', () => {
    it('≤5k → 可以用 highlightAuto', () => {
      expect(shouldUseHighlightAuto('const x = 1;')).toBe(true);
    });

    it('>5k → 不用 highlightAuto', () => {
      const code = 'a'.repeat(THRESHOLDS.HIGHLIGHT_AUTO_LIMIT + 1);
      expect(shouldUseHighlightAuto(code)).toBe(false);
    });
  });

  describe('shouldConfirmBeforeOpen', () => {
    it('<50MB → 不弹确认框', () => {
      expect(shouldConfirmBeforeOpen(1024)).toBe(false);
      expect(shouldConfirmBeforeOpen(50 * 1024 * 1024)).toBe(false);
    });

    it('>50MB → 弹确认框', () => {
      expect(shouldConfirmBeforeOpen(50 * 1024 * 1024 + 1)).toBe(true);
    });
  });
});
