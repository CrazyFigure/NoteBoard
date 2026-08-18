// NoteBoard 流程图快捷连线与节点延伸算法
// 支持矩形、圆角矩形、圆形、菱形四种基础节点向上下左右快速延伸与箭头双向绑定

import type { ExcalidrawElement } from './sceneIo';

/** 流程图支持的快捷节点类型 */
export type FlowchartShapeType = 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'diamond';

/** 延伸方向 */
export type FlowchartDirection = 'up' | 'down' | 'left' | 'right';

/** 默认节点间距 (像素) */
export const DEFAULT_NODE_GAP = 80;

/** 生成唯一的元素 ID */
export function generateElementId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 判断某个元素是否为可延伸连接的图形节点
 */
export function isFlowchartBindableNode(element: ExcalidrawElement | null | undefined): boolean {
  if (!element || element.isDeleted) return false;
  // 支持矩形、圆角矩形、椭圆、菱形
  return ['rectangle', 'ellipse', 'diamond'].includes(element.type);
}

export interface CreateNodeResult {
  /** 更新后的完整元素列表 */
  elements: ExcalidrawElement[];
  /** 新生成的节点元素 ID */
  newNodeId: string;
  /** 新生成的箭头元素 ID */
  arrowId: string;
}

/**
 * 根据源节点、方向与目标形状，快速创建新节点与连接箭头，并建立双向绑定
 */
export function createFlowchartNodeAndArrow(
  sourceElement: ExcalidrawElement,
  direction: FlowchartDirection,
  targetShape: FlowchartShapeType,
  existingElements: readonly ExcalidrawElement[],
  gap: number = DEFAULT_NODE_GAP,
): CreateNodeResult {
  const newNodeId = generateElementId();
  const arrowId = generateElementId();

  // 1. 计算新节点的尺寸（继承源节点尺寸，若太小则保持最低可用尺寸）
  const nodeWidth = Math.max(sourceElement.width || 120, 60);
  const nodeHeight = Math.max(sourceElement.height || 60, 40);

  // 2. 根据方向计算新节点的坐标 (x, y)
  let targetX = sourceElement.x;
  let targetY = sourceElement.y;

  // 箭头起点和终点世界坐标
  let arrowStartX = 0;
  let arrowStartY = 0;
  let arrowEndX = 0;
  let arrowEndY = 0;

  switch (direction) {
    case 'right':
      targetX = sourceElement.x + sourceElement.width + gap;
      targetY = sourceElement.y + (sourceElement.height - nodeHeight) / 2;
      arrowStartX = sourceElement.x + sourceElement.width;
      arrowStartY = sourceElement.y + sourceElement.height / 2;
      arrowEndX = targetX;
      arrowEndY = targetY + nodeHeight / 2;
      break;
    case 'left':
      targetX = sourceElement.x - nodeWidth - gap;
      targetY = sourceElement.y + (sourceElement.height - nodeHeight) / 2;
      arrowStartX = sourceElement.x;
      arrowStartY = sourceElement.y + sourceElement.height / 2;
      arrowEndX = targetX + nodeWidth;
      arrowEndY = targetY + nodeHeight / 2;
      break;
    case 'down':
      targetX = sourceElement.x + (sourceElement.width - nodeWidth) / 2;
      targetY = sourceElement.y + sourceElement.height + gap;
      arrowStartX = sourceElement.x + sourceElement.width / 2;
      arrowStartY = sourceElement.y + sourceElement.height;
      arrowEndX = targetX + nodeWidth / 2;
      arrowEndY = targetY;
      break;
    case 'up':
      targetX = sourceElement.x + (sourceElement.width - nodeWidth) / 2;
      targetY = sourceElement.y - nodeHeight - gap;
      arrowStartX = sourceElement.x + sourceElement.width / 2;
      arrowStartY = sourceElement.y;
      arrowEndX = targetX + nodeWidth / 2;
      arrowEndY = targetY + nodeHeight;
      break;
  }

  // 3. 构建新图形元素（继承源节点样式风格）
  const isRounded = targetShape === 'rounded-rectangle';
  const excalidrawType = isRounded ? 'rectangle' : targetShape;

  const targetNode: ExcalidrawElement = {
    id: newNodeId,
    type: excalidrawType,
    x: targetX,
    y: targetY,
    width: nodeWidth,
    height: nodeHeight,
    angle: 0,
    strokeColor: sourceElement.strokeColor || '#1e1e1e',
    backgroundColor: sourceElement.backgroundColor || 'transparent',
    fillStyle: sourceElement.fillStyle || 'solid',
    strokeWidth: sourceElement.strokeWidth || 1,
    strokeStyle: sourceElement.strokeStyle || 'solid',
    roughness: sourceElement.roughness ?? 1,
    opacity: sourceElement.opacity ?? 100,
    groupIds: [],
    frameId: null,
    // Excalidraw 圆角类型 (2: proportional, 3: adaptive)
    roundness: isRounded ? { type: 3 } : null,
    seed: Math.floor(Math.random() * 2000000000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2000000000),
    isDeleted: false,
    // 双向绑定：新节点关联该箭头
    boundElements: [{ id: arrowId, type: 'arrow' }],
    updated: Date.now(),
    link: null,
    locked: false,
    customData: {},
  };

  // 4. 构建连接箭头元素
  const deltaX = arrowEndX - arrowStartX;
  const deltaY = arrowEndY - arrowStartY;

  const arrowElement: ExcalidrawElement = {
    id: arrowId,
    type: 'arrow',
    x: arrowStartX,
    y: arrowStartY,
    width: Math.abs(deltaX) || 1,
    height: Math.abs(deltaY) || 1,
    angle: 0,
    strokeColor: sourceElement.strokeColor || '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: sourceElement.strokeWidth || 1,
    strokeStyle: 'solid',
    roughness: sourceElement.roughness ?? 1,
    opacity: sourceElement.opacity ?? 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 2 },
    seed: Math.floor(Math.random() * 2000000000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2000000000),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    // 箭头的相对坐标点集合
    points: [
      [0, 0],
      [deltaX, deltaY],
    ],
    lastCommittedPoint: null,
    // Excalidraw 绑定起点和终点
    startBinding: {
      elementId: sourceElement.id,
      focus: 0,
      gap: 4,
    },
    endBinding: {
      elementId: newNodeId,
      focus: 0,
      gap: 4,
    },
    startArrowhead: null,
    endArrowhead: 'arrow',
    elbowed: false,
  };

  // 5. 更新源节点的 boundElements 列表
  const prevBoundElements = Array.isArray(sourceElement.boundElements) ? sourceElement.boundElements : [];
  const updatedSourceElement: ExcalidrawElement = {
    ...sourceElement,
    boundElements: [...prevBoundElements, { id: arrowId, type: 'arrow' }],
    version: (sourceElement.version || 1) + 1,
    versionNonce: Math.floor(Math.random() * 2000000000),
    updated: Date.now(),
  };

  // 6. 组合新的元素列表
  const newElements = existingElements.map((el) => {
    if (el.id === sourceElement.id) {
      return updatedSourceElement;
    }
    return el;
  });

  newElements.push(targetNode, arrowElement);

  return {
    elements: newElements,
    newNodeId,
    arrowId,
  };
}
