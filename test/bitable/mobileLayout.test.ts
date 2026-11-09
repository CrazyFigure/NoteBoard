// NoteBoard 多维表格移动端布局纯函数单元测试
// 覆盖横屏滚动收起工具栏的方向判定、竖屏固定列数限制与甘特左侧栏宽度压缩

import { describe, test, expect } from 'vitest';
import { fitPaneWidths, limitFrozenCount, trackChromeScroll, type ScrollTrack } from '../../src/features/bitable/useMobileLayout';

/** 依次喂入滚动位置，返回最后一个非 null 的判定 */
function feed(track: ScrollTrack, tops: number[]): boolean | null {
  let result: boolean | null = null;
  for (const top of tops) {
    const next = trackChromeScroll(track, top);
    if (next !== null) result = next;
  }
  return result;
}

describe('trackChromeScroll', () => {
  test('向下累计超过阈值才收起', () => {
    const track = { anchor: 40, last: 40 };
    expect(feed(track, [45, 50, 55])).toBeNull();
    expect(feed(track, [70])).toBe(true);
  });

  test('向上滚动累计超过阈值展开，方向反转时重新起算', () => {
    const track = { anchor: 100, last: 100 };
    expect(feed(track, [130, 160])).toBe(true);
    // 小幅回拉不展开
    expect(feed(track, [150])).toBeNull();
    // 继续向上累计到阈值
    expect(feed(track, [130])).toBe(false);
  });

  test('回到顶部区域始终展开', () => {
    const track = { anchor: 20, last: 20 };
    expect(trackChromeScroll(track, 4)).toBe(false);
  });
});

describe('limitFrozenCount', () => {
  test('桌面（无视口宽度）保持设置值', () => {
    expect(limitFrozenCount([240, 160], 2, 50, null)).toBe(2);
  });

  test('固定列总宽超过视口 60% 时从右往左减少', () => {
    // 393 * 0.6 = 235.8：序号列 50 + 首列 160 = 210 可固定，再加 160 超出
    expect(limitFrozenCount([160, 160, 160], 3, 50, 393)).toBe(1);
    // 首列就超出预算时不固定任何列
    expect(limitFrozenCount([240, 160], 2, 50, 393)).toBe(0);
    // 横屏宽度足够时全部保留
    expect(limitFrozenCount([160, 160], 2, 50, 852)).toBe(2);
  });
});

describe('fitPaneWidths', () => {
  test('宽度足够或桌面端原样返回', () => {
    const widths = [200, 120];
    expect(fitPaneWidths(widths, 44, null)).toBe(widths);
    expect(fitPaneWidths(widths, 44, 852)).toBe(widths);
  });

  test('窄屏按比例压缩到半屏以内，且每列不低于最小宽度', () => {
    const fitted = fitPaneWidths([240], 44, 393);
    expect(44 + fitted[0]).toBeLessThanOrEqual(393 * 0.5);
    expect(fitPaneWidths([240, 200, 160], 44, 360).every((w) => w >= 90)).toBe(true);
  });
});
