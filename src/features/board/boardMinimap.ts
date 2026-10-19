// NoteBoard 画板缩略图绘制
// 只画图元轮廓（形状 / 线条 / 文本块），不调用 Excalidraw 渲染器，千级图元也能在数毫秒内完成。

import type { MinimapRect, MinimapScene } from '../../components/minimap/CanvasMinimap';
import type { ExcalidrawElement } from './sceneIo';

/** 缩略图图元的最小像素尺寸，避免细小元素在缩小后消失 */
const MIN_ELEMENT_PX = 1.5;

/** 有折线点的图元：点坐标相对于图元 x / y */
function getPoints(el: ExcalidrawElement): ReadonlyArray<readonly [number, number]> | null {
  const points = el.points as ReadonlyArray<readonly [number, number]> | undefined;
  return Array.isArray(points) && points.length > 0 ? points : null;
}

/** 图元未旋转时的外接矩形；折线按实际点计算（点可能落在 x / y 左上方） */
function getElementBounds(el: ExcalidrawElement): MinimapRect {
  const points = getPoints(el);
  if (!points) {
    return {
      left: Math.min(el.x, el.x + el.width),
      top: Math.min(el.y, el.y + el.height),
      width: Math.abs(el.width),
      height: Math.abs(el.height),
    };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of points) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  return { left: el.x + minX, top: el.y + minY, width: maxX - minX, height: maxY - minY };
}

/** 透明 / 缺省颜色不绘制 */
function isPaintable(color: string | undefined): color is string {
  return !!color && color !== 'transparent';
}

/** 生成画板缩略图场景：边界覆盖全部未删除图元 */
export function createBoardMinimapScene(elements: readonly ExcalidrawElement[]): MinimapScene {
  const live = elements.filter((el) => !el.isDeleted);
  const boundsList = live.map(getElementBounds);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const b of boundsList) {
    if (b.left < left) left = b.left;
    if (b.top < top) top = b.top;
    if (b.left + b.width > right) right = b.left + b.width;
    if (b.top + b.height > bottom) bottom = b.top + b.height;
  }

  return {
    bounds: live.length > 0 ? { left, top, width: right - left, height: bottom - top } : null,
    paint: (ctx, scale) => {
      const px = 1 / scale;
      const minSize = MIN_ELEMENT_PX * px;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      live.forEach((el, index) => {
        const b = boundsList[index];
        const w = Math.max(minSize, b.width);
        const h = Math.max(minSize, b.height);
        ctx.globalAlpha = Math.max(0.15, Math.min(1, (typeof el.opacity === 'number' ? el.opacity : 100) / 100));
        // 旋转图元绕中心旋转后再画，线条点坐标同样随之旋转
        const rotated = typeof el.angle === 'number' && el.angle !== 0;
        if (rotated) {
          const cx = el.x + el.width / 2;
          const cy = el.y + el.height / 2;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(el.angle);
          ctx.translate(-cx, -cy);
        }

        const points = getPoints(el);
        if (points) {
          // 线条 / 箭头 / 手绘：按原始点连线
          ctx.beginPath();
          ctx.moveTo(el.x + points[0][0], el.y + points[0][1]);
          for (let i = 1; i < points.length; i += 1) ctx.lineTo(el.x + points[i][0], el.y + points[i][1]);
          ctx.lineWidth = Math.max(px, Math.min(el.strokeWidth || 1, 4 * px));
          ctx.strokeStyle = isPaintable(el.strokeColor) ? el.strokeColor : '#1e1e1e';
          ctx.stroke();
        } else if (el.type === 'text') {
          // 文本以浅色块示意；绑定在形状内的文本由容器代表，不重复绘制
          if (!el.containerId) {
            ctx.globalAlpha *= 0.35;
            ctx.fillStyle = isPaintable(el.strokeColor) ? el.strokeColor : '#1e1e1e';
            ctx.fillRect(b.left, b.top, w, h);
          }
        } else if (el.type === 'image') {
          ctx.fillStyle = '#94a3b8';
          ctx.fillRect(b.left, b.top, w, h);
        } else {
          // 形状：矩形 / 椭圆 / 菱形，其余类型（框架、嵌入等）按矩形处理
          ctx.beginPath();
          if (el.type === 'ellipse') {
            ctx.ellipse(b.left + w / 2, b.top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
          } else if (el.type === 'diamond') {
            ctx.moveTo(b.left + w / 2, b.top);
            ctx.lineTo(b.left + w, b.top + h / 2);
            ctx.lineTo(b.left + w / 2, b.top + h);
            ctx.lineTo(b.left, b.top + h / 2);
            ctx.closePath();
          } else {
            ctx.rect(b.left, b.top, w, h);
          }
          if (isPaintable(el.backgroundColor)) {
            ctx.fillStyle = el.backgroundColor;
            ctx.fill();
          }
          ctx.lineWidth = px;
          ctx.strokeStyle = isPaintable(el.strokeColor) ? el.strokeColor : '#1e1e1e';
          ctx.stroke();
        }

        if (rotated) ctx.restore();
      });
      ctx.globalAlpha = 1;
    },
  };
}
