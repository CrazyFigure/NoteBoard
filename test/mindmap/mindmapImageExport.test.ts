// NoteBoard 思维导图图片导出辅助函数测试
// 覆盖导出画布居中留白、CSS 变量 / 渐变 / 投影解析与 color-mix 混色
// 详见 docs/09-开发路线图.md

import { describe, test, expect } from 'vitest';
import {
  computeExportFrame,
  EXPORT_PADDING,
  mixColors,
  parseBoxShadow,
  parseColor,
  parseLinearGradient,
  pathBounds,
  resolveCssVars,
} from '@/features/mindmap/mindmapImageExport';
import { computeMindmapLayout } from '@/features/mindmap/mindmapLayout';
import { createDefaultMindmap } from '@/features/mindmap/mindmapConverter';

describe('导出画布尺寸与居中', () => {
  test('包围盒四周留白相等，内容位于画布正中', () => {
    const { nodes, links, decorations } = computeMindmapLayout(createDefaultMindmap(), 'balanced', 6);
    const frame = computeExportFrame(nodes, links, decorations);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x + frame.offsetX);
      minY = Math.min(minY, n.y + frame.offsetY);
      maxX = Math.max(maxX, n.x + n.width + frame.offsetX);
      maxY = Math.max(maxY, n.y + n.height + frame.offsetY);
    }
    expect(minX).toBeCloseTo(EXPORT_PADDING);
    expect(minY).toBeCloseTo(EXPORT_PADDING);
    expect(frame.width - maxX).toBeGreaterThanOrEqual(EXPORT_PADDING - 1);
    expect(frame.height - maxY).toBeGreaterThanOrEqual(EXPORT_PADDING - 1);
  });

  test('装饰线超出节点范围时画布随之扩展（鱼骨脊柱尾部）', () => {
    const { nodes, links, decorations } = computeMindmapLayout(createDefaultMindmap(), 'fishbone', 6);
    const frame = computeExportFrame(nodes, links, decorations);
    const spine = pathBounds(decorations[0].path)!;
    expect(spine.minX + frame.offsetX).toBeGreaterThanOrEqual(EXPORT_PADDING - 0.01);
  });

  test('pathBounds 解析绝对坐标', () => {
    expect(pathBounds('M 10 20 C 5 5, 40 60, 30 25')).toEqual({ minX: 5, minY: 5, maxX: 40, maxY: 60 });
    expect(pathBounds('')).toBeNull();
  });
});

describe('样式解析', () => {
  const vars: Record<string, string> = { '--editor-accent': '#ff0000', '--empty': '' };
  const lookup = (name: string) => vars[name] ?? '';

  test('CSS 变量解析与回退值（含嵌套括号）', () => {
    expect(resolveCssVars('var(--editor-accent, #3b82f6)', lookup)).toBe('#ff0000');
    expect(resolveCssVars('var(--missing, rgba(0, 0, 0, 0.5))', lookup)).toBe('rgba(0, 0, 0, 0.5)');
    expect(resolveCssVars('var(--empty, var(--editor-accent, #000))', lookup)).toBe('#ff0000');
  });

  test('颜色解析与混色', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30, 0.5]);
    expect(parseColor('not-a-color')).toBeNull();
    expect(mixColors('#000000', '#ffffff', 50)).toBe('rgba(128, 128, 128, 1)');
    expect(mixColors('#ff0000', '#0000ff', 10)).toBe('rgba(26, 0, 230, 1)');
  });

  test('线性渐变与投影解析', () => {
    expect(parseLinearGradient('linear-gradient(135deg, #0ea5e9, #0369a1)')).toEqual({
      angle: 135,
      stops: ['#0ea5e9', '#0369a1'],
    });
    expect(parseLinearGradient('#ffffff')).toBeNull();
    expect(parseBoxShadow('0 6px 16px rgba(2, 132, 199, 0.4)')).toEqual({
      x: 0,
      y: 6,
      blur: 16,
      color: 'rgba(2, 132, 199, 0.4)',
    });
  });
});
