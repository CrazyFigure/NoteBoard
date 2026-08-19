// NoteBoard 排版设置与宽度解析单元测试
import { describe, test, expect } from 'vitest';
import {
  resolveContentWidth,
  contentWidthToPercent,
  CONTENT_WIDTH_MAP,
  CONTENT_WIDTH_PERCENT_MAP,
  applyTypography,
} from '@/core/theme/applyTheme';

describe('排版设置与编辑区宽度解析', () => {
  // 预设宽度解析测试
  test('正确解析预设宽度名称为对应 CSS 宽度', () => {
    expect(resolveContentWidth('narrow')).toBe('65%');
    expect(resolveContentWidth('standard')).toBe('80%');
    expect(resolveContentWidth('wide')).toBe('92%');
    expect(resolveContentWidth('full')).toBe('100%');
  });

  // 自定义百分比或单位解析测试
  test('正确解析自定义百分比或带单位的字符串', () => {
    expect(resolveContentWidth('75%')).toBe('75%');
    expect(resolveContentWidth('50%')).toBe('50%');
    expect(resolveContentWidth('1200px')).toBe('1200px');
    expect(resolveContentWidth('85')).toBe('85%');
  });

  // 空值或异常回退测试
  test('空值或未识别输入回退至默认 80%', () => {
    expect(resolveContentWidth(undefined)).toBe('80%');
    expect(resolveContentWidth('')).toBe('80%');
  });

  // 预设档位转滑动条百分比数值测试
  test('正确将预设档位转为滑动条百分比数值', () => {
    expect(contentWidthToPercent('narrow')).toBe(65);
    expect(contentWidthToPercent('standard')).toBe(80);
    expect(contentWidthToPercent('wide')).toBe(92);
    expect(contentWidthToPercent('full')).toBe(100);
  });

  // 自定义字符串转百分比数值测试
  test('正确将自定义字符串转为限制在 40~100 范围的数值', () => {
    expect(contentWidthToPercent('77%')).toBe(77);
    expect(contentWidthToPercent('20%')).toBe(40); // 截断到下界 40
    expect(contentWidthToPercent('120%')).toBe(100); // 截断到上界 100
  });

  // CSS 变量注入测试
  test('applyTypography 正确注入 --content-max-width CSS 变量', () => {
    // 注入自定义宽度
    applyTypography({ contentWidth: '78%' });
    expect(document.documentElement.style.getPropertyValue('--content-max-width')).toBe('78%');

    // 注入预设宽度
    applyTypography({ contentWidth: 'wide' });
    expect(document.documentElement.style.getPropertyValue('--content-max-width')).toBe('92%');
  });
});
