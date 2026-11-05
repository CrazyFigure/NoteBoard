// 缩略图重点验证真实坐标关系、缓存边界和生命周期，防止改变图纸的缩放或重复生成大场景。
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountMinimap, minimapLayout, needsMinimap, imageContentBounds } from '../cad/minimap.mjs';

const bounds = { minX: 100, minY: 200, maxX: 1100, maxY: 700 };
let dom, frames, nextFrame, host, api, renderer, state, captures, failCapture, contexts;

/** 用坐标变换模拟 CAD 渲染器；尺寸为 CSS 像素，位图为 2 倍 DPR。 */
beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="host"></div>', { url: 'https://noteboard.test', pretendToBeVisual: true });
  Object.assign(globalThis, { document: dom.window.document, localStorage: dom.window.localStorage, devicePixelRatio: 2 });
  frames = new Map(); nextFrame = 0; captures = 0; failCapture = false; contexts = new Map();
  globalThis.requestAnimationFrame = (fn) => { frames.set(++nextFrame, fn); return nextFrame; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    if (!contexts.has(this)) contexts.set(this, { draws: [], setTransform() {}, getImageData: () => raster(400, 200), drawImage(...args) { this.draws.push(args); } });
    return contexts.get(this);
  };
  host = document.getElementById('host');
  const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 800; host.append(canvas);
  Object.defineProperties(canvas, { clientWidth: { value: 800 }, clientHeight: { value: 400 } });
  state = { centerX: 600, centerY: 450, scale: 4 };
  renderer = {
    canvas, getBounds: () => ({ ...bounds }), getViewState: () => ({ ...state }),
    setViewState: (next) => { state = { ...next }; api?.sync(); },
    screenToWorld: ({ x, y }) => ({ x: state.centerX + (x - 400) / state.scale, y: state.centerY - (y - 200) / state.scale }),
    captureCanvas: () => { captures++; if (failCapture) throw new Error('截图失败'); const source = document.createElement('canvas'); source.width = 1600; source.height = 800; return source; },
  };
});
afterEach(() => { api?.destroy(); api = null; dom.window.close(); });

function flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); }
function mount() { api = mountMinimap(host, renderer); flush(); return host.querySelector('.cad-minimap'); }
function pointer(node, type, x, y, id = 1) {
  const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: id }); node.dispatchEvent(event); flush();
}
function preparePointer(panel) {
  const width = parseFloat(panel.style.width), height = parseFloat(panel.style.height);
  panel.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
  panel.setPointerCapture = () => {}; panel.hasPointerCapture = () => false;
}

/** 构造真实 RGBA 采样；背景和前景可切换，避免依赖私有图纸作为测试夹具。 */
function raster(width, height, regions = [], background = 255, foreground = 0) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = background; data[i + 1] = background; data[i + 2] = background; data[i + 3] = 255; }
  for (const [left, top, right, bottom] of regions) for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const offset = (y * width + x) * 4; data[offset] = foreground; data[offset + 1] = foreground; data[offset + 2] = foreground;
  }
  return { data, width, height };
}

test('按实际像素去除大片空白，保留远处孤立的真实几何及深色主题细线', () => {
  const regions = [[70, 60, 90, 80], [10, 20, 11, 21]];
  assert.deepEqual(imageContentBounds(raster(100, 100, regions)), { left: 9, top: 19, right: 91, bottom: 81 });
  assert.deepEqual(imageContentBounds(raster(100, 100, regions, 25, 60)), { left: 9, top: 19, right: 91, bottom: 81 });
  assert.equal(imageContentBounds(raster(100, 100)), null);
});

test('图形偏在原始截图角落时重新居中，裁剪后的导航仍使用正确世界坐标', () => {
  // 模拟图纸实际边界被原点占位坐标撑大，而真正的可见线条仅在右下角。
  renderer.getBounds = () => ({ minX: -10000, minY: -10000, maxX: 10000, maxY: 10000 });
  state.centerX = 6000; state.centerY = -5000;
  const context = dom.window.HTMLCanvasElement.prototype.getContext;
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    const ctx = context.call(this); ctx.getImageData = () => raster(400, 200, [[240, 130, 280, 170]]); return ctx;
  };
  const panel = mount(); preparePointer(panel);
  const capturesContext = [...contexts.values()].find((ctx) => ctx.draws.some((args) => args.length === 9));
  assert.ok(capturesContext, '最终缓存从原截图裁剪区域重采样，不能直接放大小采样图');
  const cropCall = capturesContext.draws.find((args) => args.length === 9);
  assert.equal(cropCall[1], 956); assert.equal(cropCall[2], 516);
  // 面板中心对应裁剪后内容的世界中心，Y 轴与截图方向相反，缩放必须保持原样。
  pointer(panel, 'pointerdown', parseFloat(panel.style.width) / 2, parseFloat(panel.style.height) / 2);
  assert.ok(Math.abs(state.centerX - 6521.739130434784) < 1e-8);
  assert.ok(Math.abs(state.centerY - -5434.782608695653) < 1e-8);
  assert.equal(state.scale, 4);
});

test('适合窗口时不截图；放大后出现，截图始终恢复原中心和缩放', () => {
  state.scale = .7; const panel = mount();
  assert.equal(panel.hidden, true); assert.equal(captures, 0);
  state.scale = 4; const saved = { ...state }; api.sync(); flush();
  assert.equal(panel.hidden, false); assert.equal(captures, 1); assert.deepEqual(state, saved);
  const box = panel.querySelector('.cad-minimap-viewport');
  assert.equal(parseFloat(box.style.width), 36.8); assert.equal(parseFloat(box.style.height), 18.4);
  assert.equal(frames.size, 0, '截图内的临时视野事件不能递归排队');
});

test('平移和缩放只更新视口，不再截图；主题失效后才重新生成有界缓存', () => {
  const panel = mount(), canvas = panel.querySelector('canvas'), draws = contexts.get(canvas).draws;
  const count = draws.length;
  state.centerX += 20; api.sync(); api.sync(); flush();
  assert.equal(captures, 1); assert.equal(draws.length, count);
  state.scale = 5; api.sync(); flush(); assert.equal(captures, 1);
  api.invalidate(); flush(); assert.equal(captures, 2);
  // 第一处 drawImage 使用的是低分辨率缓存，临时全尺寸截图已立即清空。
  const cache = contexts.get(canvas).draws.at(-1)[0];
  assert.ok(cache.width <= 400 && cache.height <= 300);
});

test('隐藏后不生成缓存，重新挂载记住选择，并能从右下角恢复显示', () => {
  mount(); host.querySelector('[aria-label="隐藏缩略图"]').click();
  assert.equal(host.querySelector('.cad-minimap').hidden, true);
  assert.equal(localStorage.getItem('nb-minimap-visible:cad'), '0');
  api.invalidate(); state.centerX += 10; api.sync(); flush(); assert.equal(captures, 1);
  api.destroy(); api = null; mount(); assert.equal(captures, 1);
  const show = host.querySelector('[aria-label="显示缩略图"]'); assert.equal(show.hidden, false);
  show.click(); assert.equal(host.querySelector('.cad-minimap').hidden, false);
  assert.equal(captures, 2); assert.equal(localStorage.getItem('nb-minimap-visible:cad'), '1');
});

test('点击与拖动正确转换 Y 轴，保持缩放并限制导航中心在图纸范围内', () => {
  const panel = mount(); preparePointer(panel);
  const map = minimapLayout(bounds, { minX: 500, maxX: 700, minY: 400, maxY: 500 });
  // 图纸左上角，应导航到世界坐标 (100, 700)。
  pointer(panel, 'pointerdown', map.x, map.y);
  assert.deepEqual(state, { centerX: 100, centerY: 700, scale: 4 });
  pointer(panel, 'pointermove', 2000, 2000);
  assert.deepEqual(state, { centerX: 1100, centerY: 200, scale: 4 });
  pointer(panel, 'pointerup', 2000, 2000); assert.equal(panel.hasAttribute('data-dragging'), false);
});

test('在视口框内拖动保留抓取偏移，取消后重新适配映射', () => {
  const panel = mount(); preparePointer(panel);
  pointer(panel, 'pointerdown', 110, 54); assert.equal(state.centerX, 600);
  pointer(panel, 'pointermove', 120, 54);
  assert.ok(Math.abs(state.centerX - (600 + 10 / .184)) < 1e-8);
  pointer(panel, 'pointercancel', 120, 54); assert.equal(panel.hasAttribute('data-dragging'), false);
});

test('按钮不触发导航，键盘方向与世界坐标一致', () => {
  const panel = mount(), saved = { ...state };
  pointer(panel.querySelector('button'), 'pointerdown', 20, 20); assert.deepEqual(state, saved);
  panel.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' })); flush();
  assert.deepEqual(state, { ...saved, centerY: 460 });
});

test('视野完全移出图纸时视口框仍在面板内', () => {
  state.centerX = 3000; state.centerY = -2000; const panel = mount();
  const box = panel.querySelector('.cad-minimap-viewport');
  const [x, y] = box.style.transform.match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.ok(x >= 0 && y >= 0);
  assert.ok(x + parseFloat(box.style.width) <= parseFloat(panel.style.width));
  assert.ok(y + parseFloat(box.style.height) <= parseFloat(panel.style.height));
});

test('截图失败也恢复主图，关闭后取消刷新并释放全部位图', () => {
  failCapture = true; const saved = { ...state }, panel = mount();
  assert.deepEqual(state, saved); assert.equal(panel.hidden, true);
  failCapture = false; api.sync(); flush(); assert.equal(panel.hidden, false);
  api.invalidate(); assert.equal(frames.size, 1); api.destroy();
  assert.equal(frames.size, 0); assert.equal(host.querySelector('.cad-minimap'), null);
  for (const canvas of contexts.keys()) assert.equal(canvas.width, 0);
});

test('按重叠比例与回差自动出现，细长图纸面板不缩成一条线', () => {
  const vp = { minX: 100, maxX: 700, minY: 200, maxY: 500 };
  assert.equal(needsMinimap(bounds, vp), false);
  assert.equal(needsMinimap(bounds, vp, true), true);
  assert.equal(needsMinimap(bounds, { ...vp, maxX: 500 }), true);
  const map = minimapLayout({ minX: 0, minY: 0, maxX: 5000, maxY: 10 }, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  assert.equal(map.width, 200); assert.equal(map.height, 48);
});
