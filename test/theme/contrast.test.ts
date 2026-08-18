// NoteBoard 主题对比度测试
// 详见 docs/06-主题与设计规范.md §11
// 遍历三套主题的全部 Token 组合，断言正文类 ≥ 4.5:1，指示类 ≥ 3:1

import { describe, test, expect } from 'vitest';
import {
  REQUIRED_TOKENS,
  TEXT_PAIRS,
  UI_PAIRS,
} from '@/core/theme/tokens';
import {
  contrastRatio,
  TEXT_CONTRAST_THRESHOLD,
  UI_CONTRAST_THRESHOLD,
} from '@/core/theme/contrast';
import { THEME_TOKENS } from './tokens.fixture';
import type { ThemeId } from '@/core/ipc/types';

const THEMES: ThemeId[] = ['chen-guang', 'hu-po', 'mo-ye'];

describe('主题对比度基线', () => {
  // ── 结构完整性 ──

  test.each(THEMES)('%s 定义了全部必需 Token', (theme) => {
    const tokens = THEME_TOKENS[theme];
    const missing: string[] = [];
    for (const token of REQUIRED_TOKENS) {
      const value = tokens[token];
      if (!value || value.trim() === '') {
        missing.push(token);
      }
    }
    expect(missing).toEqual([]);
  });

  test('三套主题的 Token 键集合完全一致', () => {
    const keys = THEMES.map((theme) => new Set(Object.keys(THEME_TOKENS[theme])));
    const first = keys[0]!;
    for (let i = 1; i < keys.length; i++) {
      // 对称差为空
      const diff = [...keys[i]].filter((k) => !first.has(k));
      expect(diff).toEqual([]);
    }
  });

  // ── 正文类对比度 ≥ 4.5:1 ──

  test.each(THEMES)('%s 正文类全部 ≥ 4.5:1', (theme) => {
    const tokens = THEME_TOKENS[theme];
    const failures: string[] = [];
    for (const [fg, bg] of TEXT_PAIRS) {
      const fgValue = tokens[fg];
      const bgValue = tokens[bg];
      if (!fgValue || !bgValue) {
        failures.push(`${fg} 或 ${bg} 未定义`);
        continue;
      }
      const ratio = contrastRatio(fgValue, bgValue);
      if (ratio < TEXT_CONTRAST_THRESHOLD) {
        failures.push(
          `${fg} (${fgValue}) on ${bg} (${bgValue}): ${ratio.toFixed(2)}:1 (需 ≥ ${TEXT_CONTRAST_THRESHOLD})`,
        );
      }
    }
    if (failures.length > 0) {
      console.error(`${theme} 正文类对比度不达标:\n${failures.join('\n')}`);
    }
    expect(failures).toEqual([]);
  });

  // ── 指示器类对比度 ≥ 3:1 ──

  test.each(THEMES)('%s 指示类全部 ≥ 3:1', (theme) => {
    const tokens = THEME_TOKENS[theme];
    const failures: string[] = [];
    for (const [fg, bg] of UI_PAIRS) {
      const fgValue = tokens[fg];
      const bgValue = tokens[bg];
      if (!fgValue || !bgValue) {
        failures.push(`${fg} 或 ${bg} 未定义`);
        continue;
      }
      const ratio = contrastRatio(fgValue, bgValue);
      if (ratio < UI_CONTRAST_THRESHOLD) {
        failures.push(
          `${fg} (${fgValue}) on ${bg} (${bgValue}): ${ratio.toFixed(2)}:1 (需 ≥ ${UI_CONTRAST_THRESHOLD})`,
        );
      }
    }
    if (failures.length > 0) {
      console.error(`${theme} 指示类对比度不达标:\n${failures.join('\n')}`);
    }
    expect(failures).toEqual([]);
  });
});
