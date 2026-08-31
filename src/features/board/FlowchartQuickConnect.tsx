// NoteBoard 流程图快速连线与节点延伸悬浮组件
// 选中单个图形时在四周展示方向指示箭头与候选图形面板（矩形、圆角矩形、圆形、菱形）

import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { ExcalidrawElement } from './sceneIo';
import {
  isFlowchartBindableNode,
  createFlowchartNodeAndArrow,
  type FlowchartDirection,
  type FlowchartShapeType,
} from './flowchartExtension';
import { Tooltip } from '../../components/Tooltip';

interface FlowchartQuickConnectProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appState: any;
  elements: readonly ExcalidrawElement[];
  theme: 'light' | 'dark';
}

/** 候选形状配置项 */
interface ShapeOption {
  type: FlowchartShapeType;
  label: string;
  renderIcon: () => React.ReactNode;
}

const SHAPE_OPTIONS: ShapeOption[] = [
  {
    type: 'rectangle',
    label: '矩形 (Rectangle)',
    renderIcon: () => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="5" width="18" height="14" rx="1" />
      </svg>
    ),
  },
  {
    type: 'rounded-rectangle',
    label: '圆角矩形 (Rounded)',
    renderIcon: () => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="5" width="18" height="14" rx="6" />
      </svg>
    ),
  },
  {
    type: 'ellipse',
    label: '圆形 / 椭圆 (Circle)',
    renderIcon: () => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <ellipse cx="12" cy="12" rx="9" ry="7" />
      </svg>
    ),
  },
  {
    type: 'diamond',
    label: '菱形 / 判断 (Diamond)',
    renderIcon: () => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="12,3 21,12 12,21 3,12" />
      </svg>
    ),
  },
];

export function FlowchartQuickConnect({
  api,
  appState,
  elements,
  theme,
}: FlowchartQuickConnectProps) {
  // 当前激活/悬浮的方向
  const [hoveredDirection, setHoveredDirection] = useState<FlowchartDirection | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 清理计时器
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  // 提取选中的单个元素
  const selectedElement = useMemo(() => {
    if (!appState || !elements) return null;
    const selectedIds = appState.selectedElementIds ? Object.keys(appState.selectedElementIds) : [];
    // 仅在选中有且仅有 1 个元素且未在拖拽或文本编辑时激活
    if (selectedIds.length !== 1) return null;
    if (appState.editingElement || appState.resizingElement || appState.draggingElement) return null;
    if (appState.viewModeEnabled) return null;

    const el = elements.find((e) => e.id === selectedIds[0]);
    if (!isFlowchartBindableNode(el)) return null;
    return el;
  }, [appState, elements]);

  // 当选中元素变化时重置悬停方向
  useEffect(() => {
    setHoveredDirection(null);
  }, [selectedElement?.id]);

  if (!selectedElement || !api) {
    return null;
  }

  // 计算选中图形在当前画布视口内的屏幕像素位置与尺寸
  const zoom = typeof appState.zoom === 'number' ? appState.zoom : (appState.zoom?.value ?? 1);
  const scrollX = appState.scrollX ?? 0;
  const scrollY = appState.scrollY ?? 0;

  const left = (selectedElement.x + scrollX) * zoom;
  const top = (selectedElement.y + scrollY) * zoom;
  const width = selectedElement.width * zoom;
  const height = selectedElement.height * zoom;

  // 鼠标移入/移出方向手柄的处理
  const handleMouseEnterDirection = (dir: FlowchartDirection) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setHoveredDirection(dir);
  };

  const handleMouseLeaveDirection = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setHoveredDirection(null);
    }, 350);
  };

  // 执行创建节点与连线操作
  const handleCreateShape = (direction: FlowchartDirection, shapeType: FlowchartShapeType) => {
    const sceneElements = api.getSceneElements ? api.getSceneElements() : elements;
    const result = createFlowchartNodeAndArrow(
      selectedElement,
      direction,
      shapeType,
      sceneElements,
    );

    // 保持当前视口并选中新创建的节点
    api.updateScene({
      elements: result.elements,
      appState: {
        ...appState,
        selectedElementIds: { [result.newNodeId]: true },
      },
    });

    setHoveredDirection(null);
  };

  // 快捷点击方向箭头：默认使用与源节点相同形状或矩形
  const handleQuickArrowClick = (direction: FlowchartDirection, e: React.MouseEvent) => {
    e.stopPropagation();
    let defaultShape: FlowchartShapeType = 'rectangle';
    if (selectedElement.type === 'ellipse') defaultShape = 'ellipse';
    else if (selectedElement.type === 'diamond') defaultShape = 'diamond';
    else if (selectedElement.roundness) defaultShape = 'rounded-rectangle';

    handleCreateShape(direction, defaultShape);
  };

  const isDark = theme === 'dark';
  const arrowColor = isDark ? 'rgba(92, 179, 255, 0.65)' : 'rgba(24, 144, 255, 0.65)';
  const arrowHoverColor = isDark ? '#40a9ff' : '#1890ff';

  // 渲染候选图形面板
  const renderShapeMenu = (direction: FlowchartDirection) => {
    if (hoveredDirection !== direction) return null;

    // 面板相对于方向手柄的定位
    const menuStyle: React.CSSProperties = {
      position: 'absolute',
      display: 'flex',
      gap: 4,
      padding: '4px 6px',
      borderRadius: 8,
      background: isDark ? 'rgba(30, 34, 42, 0.95)' : 'rgba(255, 255, 255, 0.95)',
      backdropFilter: 'blur(10px)',
      boxShadow: isDark
        ? '0 6px 18px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.12)'
        : '0 6px 18px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.08)',
      zIndex: 20,
      pointerEvents: 'auto',
      animation: 'flowchartMenuFadeIn 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
    };

    if (direction === 'right') {
      menuStyle.flexDirection = 'column';
      menuStyle.left = 'calc(100% + 8px)';
      menuStyle.top = '50%';
      menuStyle.transform = 'translateY(-50%)';
    } else if (direction === 'left') {
      menuStyle.flexDirection = 'column';
      menuStyle.right = 'calc(100% + 8px)';
      menuStyle.top = '50%';
      menuStyle.transform = 'translateY(-50%)';
    } else if (direction === 'down') {
      menuStyle.flexDirection = 'row';
      menuStyle.top = 'calc(100% + 8px)';
      menuStyle.left = '50%';
      menuStyle.transform = 'translateX(-50%)';
    } else if (direction === 'up') {
      menuStyle.flexDirection = 'row';
      menuStyle.bottom = 'calc(100% + 8px)';
      menuStyle.left = '50%';
      menuStyle.transform = 'translateX(-50%)';
    }

    return (
      <div
        style={menuStyle}
        onMouseEnter={() => {
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        }}
        onMouseLeave={handleMouseLeaveDirection}
      >
        {SHAPE_OPTIONS.map((shape) => {
          const tooltipSide = direction === 'up' ? 'bottom' : direction === 'down' ? 'top' : direction === 'left' ? 'right' : 'left';
          return (
            <Tooltip
              key={shape.type}
              content={`向${direction === 'right' ? '右' : direction === 'left' ? '左' : direction === 'down' ? '下' : '上'}延伸: ${shape.label}`}
              side={tooltipSide}
              sideOffset={6}
            >
              <button
                type="button"
                aria-label={`向${direction === 'right' ? '右' : direction === 'left' ? '左' : direction === 'down' ? '下' : '上'}延伸: ${shape.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCreateShape(direction, shape.type);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  border: 'none',
                  background: 'transparent',
                  color: isDark ? '#e6edf3' : '#24292f',
                  cursor: 'pointer',
                  transition: 'background 0.12s ease, transform 0.12s ease',
                  padding: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.06)';
                  e.currentTarget.style.transform = 'scale(1.1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.transform = 'scale(1)';
                }}
                onMouseDown={(e) => {
                  e.currentTarget.style.transform = 'scale(0.92)';
                }}
                onMouseUp={(e) => {
                  e.currentTarget.style.transform = 'scale(1.1)';
                }}
              >
                {shape.renderIcon()}
              </button>
            </Tooltip>
          );
        })}
      </div>
    );
  };

  // 基础方向手柄样式
  const handleBaseStyle: React.CSSProperties = {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'auto',
    cursor: 'pointer',
    zIndex: 10,
    userSelect: 'none',
  };

  return (
    <>
      <style>{`
        @keyframes flowchartMenuFadeIn {
          from { opacity: 0; transform: scale(0.92); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>

      {/* 四周方向手柄与弹出菜单 */}
      {/* 1. 右侧手柄 */}
      <div
        style={{
          ...handleBaseStyle,
          left: left + width + 14,
          top: top + height / 2,
          transform: 'translateY(-50%)',
        }}
        onMouseEnter={() => handleMouseEnterDirection('right')}
        onMouseLeave={handleMouseLeaveDirection}
      >
        <button
          type="button"
          aria-label="向右延伸流程图节点 (点击快捷生成 / 悬浮选择图形)"
          onClick={(e) => handleQuickArrowClick('right', e)}
          style={{
            background: hoveredDirection === 'right' ? arrowHoverColor : 'transparent',
            border: 'none',
            borderRadius: '50%',
            width: 26,
            height: 26,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
            transition: 'all 0.15s ease',
            boxShadow: hoveredDirection === 'right' ? '0 2px 8px rgba(24, 144, 255, 0.4)' : 'none',
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill={hoveredDirection === 'right' ? '#ffffff' : arrowColor}
            style={{ transform: 'rotate(0deg)', transition: 'fill 0.15s ease' }}
          >
            <path d="M5 12h14M13 6l6 6-6 6" stroke={hoveredDirection === 'right' ? '#ffffff' : arrowColor} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {renderShapeMenu('right')}
      </div>

      {/* 2. 下方手柄 */}
      <div
        style={{
          ...handleBaseStyle,
          left: left + width / 2,
          top: top + height + 14,
          transform: 'translateX(-50%)',
        }}
        onMouseEnter={() => handleMouseEnterDirection('down')}
        onMouseLeave={handleMouseLeaveDirection}
      >
        <button
          type="button"
          aria-label="向下延伸流程图节点 (点击快捷生成 / 悬浮选择图形)"
          onClick={(e) => handleQuickArrowClick('down', e)}
          style={{
            background: hoveredDirection === 'down' ? arrowHoverColor : 'transparent',
            border: 'none',
            borderRadius: '50%',
            width: 26,
            height: 26,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
            transition: 'all 0.15s ease',
            boxShadow: hoveredDirection === 'down' ? '0 2px 8px rgba(24, 144, 255, 0.4)' : 'none',
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill={hoveredDirection === 'down' ? '#ffffff' : arrowColor}
            style={{ transform: 'rotate(90deg)', transition: 'fill 0.15s ease' }}
          >
            <path d="M5 12h14M13 6l6 6-6 6" stroke={hoveredDirection === 'down' ? '#ffffff' : arrowColor} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {renderShapeMenu('down')}
      </div>

      {/* 3. 左侧手柄 */}
      <div
        style={{
          ...handleBaseStyle,
          left: left - 14,
          top: top + height / 2,
          transform: 'translate(-100%, -50%)',
        }}
        onMouseEnter={() => handleMouseEnterDirection('left')}
        onMouseLeave={handleMouseLeaveDirection}
      >
        <button
          type="button"
          aria-label="向左延伸流程图节点 (点击快捷生成 / 悬浮选择图形)"
          onClick={(e) => handleQuickArrowClick('left', e)}
          style={{
            background: hoveredDirection === 'left' ? arrowHoverColor : 'transparent',
            border: 'none',
            borderRadius: '50%',
            width: 26,
            height: 26,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
            transition: 'all 0.15s ease',
            boxShadow: hoveredDirection === 'left' ? '0 2px 8px rgba(24, 144, 255, 0.4)' : 'none',
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill={hoveredDirection === 'left' ? '#ffffff' : arrowColor}
            style={{ transform: 'rotate(180deg)', transition: 'fill 0.15s ease' }}
          >
            <path d="M5 12h14M13 6l6 6-6 6" stroke={hoveredDirection === 'left' ? '#ffffff' : arrowColor} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {renderShapeMenu('left')}
      </div>

      {/* 4. 上方手柄 */}
      <div
        style={{
          ...handleBaseStyle,
          left: left + width / 2,
          top: top - 14,
          transform: 'translate(-50%, -100%)',
        }}
        onMouseEnter={() => handleMouseEnterDirection('up')}
        onMouseLeave={handleMouseLeaveDirection}
      >
        <button
          type="button"
          aria-label="向上延伸流程图节点 (点击快捷生成 / 悬浮选择图形)"
          onClick={(e) => handleQuickArrowClick('up', e)}
          style={{
            background: hoveredDirection === 'up' ? arrowHoverColor : 'transparent',
            border: 'none',
            borderRadius: '50%',
            width: 26,
            height: 26,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
            transition: 'all 0.15s ease',
            boxShadow: hoveredDirection === 'up' ? '0 2px 8px rgba(24, 144, 255, 0.4)' : 'none',
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill={hoveredDirection === 'up' ? '#ffffff' : arrowColor}
            style={{ transform: 'rotate(270deg)', transition: 'fill 0.15s ease' }}
          >
            <path d="M5 12h14M13 6l6 6-6 6" stroke={hoveredDirection === 'up' ? '#ffffff' : arrowColor} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {renderShapeMenu('up')}
      </div>
    </>
  );
}
