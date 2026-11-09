// 画板字体提示文案：只有 Excalifont 的中文回退到小赖
import { describe, expect, it } from 'vitest';

import { describeBoardFont } from '@/features/board/BoardFontTooltip';

describe('describeBoardFont', () => {
  it('Excalifont 按小赖安装状态给出说明', () => {
    expect(describeBoardFont(5, true)).toBe('手绘 Excalifont · 中文显示为小赖手写体');
    expect(describeBoardFont(5, false)).toContain('下载小赖');
  });

  it('其它字体的中文显示为系统字体', () => {
    for (const id of [6, 7, 8]) expect(describeBoardFont(id, true)).toContain('中文显示为系统字体');
  });

  it('未知字体不显示提示', () => {
    expect(describeBoardFont(99, true)).toBeNull();
  });
});
