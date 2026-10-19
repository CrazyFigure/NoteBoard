// 导图显示策略回归：自动折叠不改正文，视口裁剪不丢跨屏连线或边缘节点。
import { describe, expect, it } from 'vitest';
import type { MindNode } from '@/features/mindmap/mindmapTypes';
import type { LayoutNode } from '@/features/mindmap/mindmapLayout';
import { createInitialMindmapView } from '@/features/mindmap/mindmapView';
import { getMindmapViewport, isMindmapNodeVisible, isMindmapLinkVisible } from '@/features/mindmap/mindmapViewport';
import { cloneMindmapTree, stringifyMindmapJson } from '@/features/mindmap/mindmapTree';

/** 构造均匀三级树，避免单层全叶子无法体现折叠下级分支。 */
function tree(count: number): MindNode {
  const nodes: MindNode[] = Array.from({ length: count }, (_, index) => ({ id: `${index}`, text: `${index}`, isExpanded: true, children: [] }));
  for (let index = 1; index < count; index += 1) nodes[Math.floor((index - 1) / 5)].children.push(nodes[index]);
  return nodes[0];
}

describe('思维导图显示与深树保护', () => {
  it('500 个节点保持原状态，501 个节点只折叠显示副本', () => {
    const small = tree(500);
    expect(createInitialMindmapView(small)).toBe(small);
    const large = tree(501);
    const view = createInitialMindmapView(large);
    expect(view).not.toBe(large);
    expect(view.children.every((child) => !child.isExpanded)).toBe(true);
    expect(large.children.every((child) => child.isExpanded)).toBe(true);
    expect(view.children[0].children).toBe(large.children[0].children);
  });

  it('仅克隆副本，不共享可变子节点和富文本格式', () => {
    const original = tree(3);
    original.children[0].marks = [{ start: 0, end: 1, bold: true }];
    const copy = cloneMindmapTree(original);
    copy.children[0].marks![0].bold = false;
    expect(original.children[0].marks[0].bold).toBe(true);
    expect(stringifyMindmapJson(copy, true)).toBe(JSON.stringify(copy, null, 2));
  });

  it('跨过视口的连线即使两个端点不在屏幕内仍被保留', () => {
    const viewport = getMindmapViewport({ x: 0, y: 0 }, 1, 800, 600);
    const left = { x: -1_000, y: 100, width: 100, height: 30 } as LayoutNode;
    const right = { x: 2_000, y: 100, width: 100, height: 30 } as LayoutNode;
    expect(isMindmapNodeVisible(left, viewport)).toBe(false);
    expect(isMindmapNodeVisible(right, viewport)).toBe(false);
    expect(isMindmapLinkVisible({ from: left, to: right, path: '' }, viewport)).toBe(true);
    expect(isMindmapNodeVisible({ ...left, x: viewport.left - left.width }, viewport)).toBe(true);
  });
});
