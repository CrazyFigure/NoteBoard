// NoteBoard 思维导图键盘导航与节点配色测试
// 覆盖方向键在各布局下的目标节点、选中节点移回画面的平移量，以及节点颜色的校验与自动对比色
// 详见 docs/09-开发路线图.md

import { describe, expect, test } from 'vitest';
import { computeMindmapLayout } from '@/features/mindmap/mindmapLayout';
import { findNavigationTarget, panToRevealRect } from '@/features/mindmap/mindmapKeyboardNav';
import { normalizeNodeColor, readableTextOn } from '@/features/mindmap/mindmapNodeColors';
import { parseMindmapDocument } from '@/features/mindmap/mindmapConverter';
import type { MindNode, MindmapLayout } from '@/features/mindmap/mindmapTypes';

/** root → a(a1, a2, a3) / b / c(c1) */
const createTree = (): MindNode => ({
  id: 'root', text: '中心', isExpanded: true,
  children: [
    {
      id: 'a', text: '分支 A', isExpanded: true,
      children: [
        { id: 'a1', text: 'A1', isExpanded: true, children: [] },
        { id: 'a2', text: 'A2', isExpanded: true, children: [] },
        { id: 'a3', text: 'A3', isExpanded: true, children: [] },
      ],
    },
    { id: 'b', text: '分支 B', isExpanded: true, children: [] },
    { id: 'c', text: '分支 C', isExpanded: true, children: [{ id: 'c1', text: 'C1', isExpanded: true, children: [] }] },
  ],
});

const navigate = (layout: MindmapLayout, from: string, dir: 'left' | 'right' | 'up' | 'down') => {
  const { nodes } = computeMindmapLayout(createTree(), layout, 6);
  return findNavigationTarget(nodes, from, dir)?.node.id ?? null;
};

describe('思维导图方向键导航', () => {
  test('向右逻辑图：右进子节点、左回父节点、上下切换同级', () => {
    // 中心主题与 a、b 距离相等时取靠前的子节点
    expect(navigate('right', 'root', 'right')).toBe('a');
    expect(navigate('right', 'a', 'right')).toBe('a2');
    expect(navigate('right', 'a3', 'left')).toBe('a');
    expect(navigate('right', 'a', 'down')).toBe('b');
    expect(navigate('right', 'b', 'up')).toBe('a');
    expect(navigate('right', 'a1', 'down')).toBe('a2');
    // 中心主题左侧没有节点
    expect(navigate('right', 'root', 'left')).toBeNull();
  });

  test('向左逻辑图方向镜像', () => {
    expect(navigate('left', 'root', 'left')).toBe('a');
    expect(navigate('left', 'a2', 'right')).toBe('a');
    expect(navigate('left', 'root', 'right')).toBeNull();
  });

  test('向下组织图：下进子节点、上回父节点、左右切换同级', () => {
    expect(navigate('tree', 'root', 'down')).toBe('a');
    expect(navigate('tree', 'a1', 'up')).toBe('a');
    expect(navigate('tree', 'a', 'right')).toBe('b');
    expect(navigate('tree', 'b', 'left')).toBe('a');
  });

  test('缩进树按画面顺序上下移动', () => {
    expect(navigate('indent-right', 'root', 'down')).toBe('a');
    expect(navigate('indent-right', 'a', 'down')).toBe('a1');
    expect(navigate('indent-right', 'a3', 'down')).toBe('b');
    expect(navigate('indent-right', 'b', 'up')).toBe('a3');
  });

  test('各布局中每个方向键都不会选中自身', () => {
    const layouts: MindmapLayout[] = ['right', 'left', 'balanced', 'tree', 'tree-up', 'indent-right', 'indent-left', 'timeline', 'fishbone'];
    for (const layout of layouts) {
      const { nodes } = computeMindmapLayout(createTree(), layout, 6);
      for (const n of nodes) {
        for (const dir of ['left', 'right', 'up', 'down'] as const) {
          expect(findNavigationTarget(nodes, n.node.id, dir)?.node.id).not.toBe(n.node.id);
        }
      }
    }
  });
});

describe('选中节点移回画面', () => {
  const rect = { x: 0, y: 0, width: 100, height: 40 };

  test('已在画面内时保持原平移', () => {
    const pan = { x: 100, y: 100 };
    expect(panToRevealRect(pan, rect, 1, 800, 600, 48)).toBe(pan);
  });

  test('超出右侧 / 下方时只平移到留出边距', () => {
    expect(panToRevealRect({ x: 750, y: 580 }, rect, 1, 800, 600, 48)).toEqual({ x: 652, y: 512 });
  });

  test('超出左侧 / 上方时按缩放换算', () => {
    expect(panToRevealRect({ x: -300, y: -300 }, { ...rect, x: 100, y: 100 }, 2, 800, 600, 48)).toEqual({ x: -152, y: -152 });
  });

  test('节点比画面还大时贴齐起始边', () => {
    expect(panToRevealRect({ x: 500, y: 0 }, { x: 0, y: 0, width: 1000, height: 40 }, 1, 800, 600, 48).x).toBe(0);
  });
});

describe('节点颜色', () => {
  test('只接受十六进制色并统一为 6 位小写', () => {
    expect(normalizeNodeColor('#ABC')).toBe('#aabbcc');
    expect(normalizeNodeColor('#3B82F6')).toBe('#3b82f6');
    expect(normalizeNodeColor('red')).toBeUndefined();
    expect(normalizeNodeColor('url(x)')).toBeUndefined();
    expect(normalizeNodeColor(12)).toBeUndefined();
  });

  test('背景色自动取对比度更高的文字颜色', () => {
    expect(readableTextOn('#fee2e2')).toBe('#1f2937');
    expect(readableTextOn('#ffffff')).toBe('#1f2937');
    expect(readableTextOn('#1e293b')).toBe('#ffffff');
    expect(readableTextOn('#3b82f6')).toBe('#ffffff');
  });

  test('读取文档时保留合法颜色、丢弃非法颜色，且不影响子节点', () => {
    const parsed = parseMindmapDocument(JSON.stringify({
      version: 1,
      root: {
        id: 'root', text: '中心', fillColor: '#FEE2E2', textColor: 'javascript:alert(1)',
        children: [{ id: 'a', text: 'A', children: [] }],
      },
    }));
    expect(parsed.fillColor).toBe('#fee2e2');
    expect(parsed.textColor).toBeUndefined();
    expect(parsed.children[0].fillColor).toBeUndefined();
  });
});
