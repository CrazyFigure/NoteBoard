// 自定义取色纯函数与多维表格自定义标签色派生
import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  deriveTagColors,
  hexToHsv,
  hsvToHex,
  isHexColor,
  normalizeHex,
} from '../../src/components/colorPicker/colorMath';
import { getOptionColor } from '../../src/features/bitable/bitableConverter';

describe('normalizeHex', () => {
  it('补 #、展开简写并统一小写', () => {
    expect(normalizeHex('ABC')).toBe('#aabbcc');
    expect(normalizeHex(' #3B82F6 ')).toBe('#3b82f6');
  });

  it('非法输入返回 null', () => {
    expect(normalizeHex('')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
  });

  it('isHexColor 只认 6 位十六进制', () => {
    expect(isHexColor('#a1b2c3')).toBe(true);
    expect(isHexColor('blue')).toBe(false);
  });
});

describe('HSV 互转', () => {
  it('往返不失真', () => {
    for (const hex of ['#3b82f6', '#ef4444', '#000000', '#ffffff', '#16a34a', '#facc15']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });
});

describe('deriveTagColors', () => {
  it('亮色（黄）派生的文字在底色上仍达到 AA 对比度', () => {
    const { bg, text } = deriveTagColors('#ffff00');
    expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('底色比主色浅、描边介于两者之间', () => {
    const { bg, border } = deriveTagColors('#2563eb');
    expect(contrastRatio(bg, '#ffffff')).toBeLessThan(contrastRatio(border, '#ffffff'));
  });
});

describe('getOptionColor 自定义色', () => {
  it('十六进制色派生三色，不再回落成蓝色', () => {
    const color = getOptionColor('#ff6600');
    expect(color.id).toBe('#ff6600');
    expect(color.bg).not.toBe('#eff6ff');
  });

  it('内置色与历史别名保持原样', () => {
    expect(getOptionColor('green').id).toBe('green');
    expect(getOptionColor('orange').id).toBe('amber');
    expect(getOptionColor('unknown').id).toBe('blue');
  });
});
