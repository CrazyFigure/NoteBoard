// NoteBoard 流程图快速延伸与双向绑定算法单元测试
// 验证上下左右延伸坐标、4 种基础图形类型与箭头双向绑定关系

import { describe, it, expect } from 'vitest';
import {
  isFlowchartBindableNode,
  createFlowchartNodeAndArrow,
  DEFAULT_NODE_GAP,
} from '../../src/features/board/flowchartExtension';
import type { ExcalidrawElement } from '../../src/features/board/sceneIo';

describe('流程图快速延伸与双向绑定算法 (flowchartExtension)', () => {
  // 模拟一个基础源矩形节点
  const mockSourceNode: ExcalidrawElement = {
    id: 'source-1',
    type: 'rectangle',
    x: 100,
    y: 100,
    width: 140,
    height: 70,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: '#ffc9c9',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 12345,
    version: 1,
    versionNonce: 67890,
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
  };

  it('isFlowchartBindableNode 能够准确判断可绑定的流程图节点类型', () => {
    expect(isFlowchartBindableNode(mockSourceNode)).toBe(true);
    expect(isFlowchartBindableNode({ ...mockSourceNode, type: 'ellipse' })).toBe(true);
    expect(isFlowchartBindableNode({ ...mockSourceNode, type: 'diamond' })).toBe(true);

    // 不支持非闭合/辅助图形
    expect(isFlowchartBindableNode({ ...mockSourceNode, type: 'arrow' })).toBe(false);
    expect(isFlowchartBindableNode({ ...mockSourceNode, type: 'line' })).toBe(false);
    expect(isFlowchartBindableNode({ ...mockSourceNode, type: 'freedraw' })).toBe(false);

    // 已删除元素不应被判定为可绑定
    expect(isFlowchartBindableNode({ ...mockSourceNode, isDeleted: true })).toBe(false);
    expect(isFlowchartBindableNode(null)).toBe(false);
    expect(isFlowchartBindableNode(undefined)).toBe(false);
  });

  it('向右延伸 (right) 正确计算新节点坐标与箭头绑定', () => {
    const existing = [mockSourceNode];
    const result = createFlowchartNodeAndArrow(mockSourceNode, 'right', 'rounded-rectangle', existing);

    expect(result.elements.length).toBe(3); // 原节点(已更新boundElements) + 新节点 + 箭头

    const updatedSource = result.elements.find((e) => e.id === mockSourceNode.id)!;
    const targetNode = result.elements.find((e) => e.id === result.newNodeId)!;
    const arrow = result.elements.find((e) => e.id === result.arrowId)!;

    // 1. 验证新节点位置在源节点右侧
    expect(targetNode.x).toBe(mockSourceNode.x + mockSourceNode.width + DEFAULT_NODE_GAP);
    expect(targetNode.y).toBe(mockSourceNode.y); // 同高居中
    expect(targetNode.width).toBe(mockSourceNode.width);
    expect(targetNode.height).toBe(mockSourceNode.height);
    expect(targetNode.type).toBe('rectangle');
    expect(targetNode.roundness).toEqual({ type: 3 });

    // 2. 验证样式继承
    expect(targetNode.strokeColor).toBe(mockSourceNode.strokeColor);
    expect(targetNode.backgroundColor).toBe(mockSourceNode.backgroundColor);
    expect(targetNode.strokeWidth).toBe(mockSourceNode.strokeWidth);

    // 3. 验证箭头起点与终点绑定
    expect(arrow.type).toBe('arrow');
    expect(arrow.startBinding).toEqual({
      elementId: mockSourceNode.id,
      focus: 0,
      gap: 4,
    });
    expect(arrow.endBinding).toEqual({
      elementId: targetNode.id,
      focus: 0,
      gap: 4,
    });

    // 4. 验证双向绑定注册
    expect(updatedSource.boundElements).toEqual([{ id: arrow.id, type: 'arrow' }]);
    expect(targetNode.boundElements).toEqual([{ id: arrow.id, type: 'arrow' }]);
  });

  it('向下延伸 (down) 正确计算新节点坐标与菱形节点属性', () => {
    const existing = [mockSourceNode];
    const result = createFlowchartNodeAndArrow(mockSourceNode, 'down', 'diamond', existing);

    const targetNode = result.elements.find((e) => e.id === result.newNodeId)!;
    const arrow = result.elements.find((e) => e.id === result.arrowId)!;

    expect(targetNode.type).toBe('diamond');
    expect(targetNode.x).toBe(mockSourceNode.x);
    expect(targetNode.y).toBe(mockSourceNode.y + mockSourceNode.height + DEFAULT_NODE_GAP);
    expect(targetNode.roundness).toBeNull();

    const startBinding = arrow.startBinding as { elementId?: string } | undefined;
    const endBinding = arrow.endBinding as { elementId?: string } | undefined;
    expect(startBinding?.elementId).toBe(mockSourceNode.id);
    expect(endBinding?.elementId).toBe(targetNode.id);
  });

  it('向左延伸 (left) 与向上延伸 (up) 坐标计算正确', () => {
    // 向左
    const resultLeft = createFlowchartNodeAndArrow(mockSourceNode, 'left', 'ellipse', [mockSourceNode]);
    const targetLeft = resultLeft.elements.find((e) => e.id === resultLeft.newNodeId)!;
    expect(targetLeft.type).toBe('ellipse');
    expect(targetLeft.x).toBe(mockSourceNode.x - mockSourceNode.width - DEFAULT_NODE_GAP);

    // 向上
    const resultUp = createFlowchartNodeAndArrow(mockSourceNode, 'up', 'rectangle', [mockSourceNode]);
    const targetUp = resultUp.elements.find((e) => e.id === resultUp.newNodeId)!;
    expect(targetUp.type).toBe('rectangle');
    expect(targetUp.y).toBe(mockSourceNode.y - mockSourceNode.height - DEFAULT_NODE_GAP);
  });

  it('连续延伸时正确累加源节点的 boundElements 列表', () => {
    // 第一次延伸：向右
    const step1 = createFlowchartNodeAndArrow(mockSourceNode, 'right', 'rectangle', [mockSourceNode]);
    const sourceAfterStep1 = step1.elements.find((e) => e.id === mockSourceNode.id)!;
    expect(sourceAfterStep1.boundElements?.length).toBe(1);

    // 第二次延伸：向下
    const step2 = createFlowchartNodeAndArrow(sourceAfterStep1, 'down', 'ellipse', step1.elements);
    const sourceAfterStep2 = step2.elements.find((e) => e.id === mockSourceNode.id)!;
    expect(sourceAfterStep2.boundElements?.length).toBe(2);
    expect(sourceAfterStep2.boundElements).toEqual([
      { id: step1.arrowId, type: 'arrow' },
      { id: step2.arrowId, type: 'arrow' },
    ]);
  });
});
