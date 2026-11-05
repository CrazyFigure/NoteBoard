// 只隔离 PDF 引擎，实际笔记视图验证切页、异步资源竞态和卸载释放；真实 PDF 另做浏览器验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
const dom = new JSDOM('', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'Element', 'ShadowRoot']) globalThis[key] = dom.window[key];
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.innerWidth = 1200; globalThis.innerHeight = 800;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
dom.window.Element.prototype.scrollIntoView = function () {};
let disconnected = 0, created = 0, revoked = 0;
globalThis.ResizeObserver = class { observe() {} disconnect() { disconnected++; } };
URL.createObjectURL = () => `blob:test-${++created}`; URL.revokeObjectURL = () => { revoked++; };
const result = await build({ entryPoints: [fileURLToPath(new URL('../shared/noteView.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{
  name: 'test-pdf-engine', setup(builder) {
    builder.onResolve({ filter: /\/pdf\/index\.mjs$/ }, () => ({ path: 'pdf', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export async function mount({container,signal}){container.textContent="PDF附件";return ()=>{container.textContent="";};}' }));
  },
}] });
const { mountNotebook, inkSvg } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const makePage = (x = 10) => ({ width: 600, height: 800, label: '笔迹', strokes: [{ points: [[x, 20, 2], [x + 20, 40, 4]], color: [0, 0, 0], opacity: 1 }] });
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

test('SVG 保留透明度、每点宽度及退化点，名称作为文本而非代码', () => {
  const page = makePage(); page.label = '<script>evil</script>';
  page.strokes.push({ points: [[20, 30, 2], [20, 30, 4]], color: [1, 2, 3], opacity: .5 });
  const svg = inkSvg(page);
  assert.equal(svg.querySelectorAll('script').length, 0); assert.equal(svg.getAttribute('aria-label'), page.label);
  assert.equal(svg.querySelector('circle').getAttribute('r'), '2'); assert.equal(svg.querySelector('circle').getAttribute('opacity'), '0.5');
  assert.match(svg.querySelector('path').getAttribute('d'), /^M.+Z$/);
});

test('翻页更新笔迹，关闭释放观察器和 Shadow DOM，重复清理无副作用', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const controller = new AbortController(), before = disconnected;
  const destroy = await mountNotebook({ container, name: '<script>标题</script>', signal: controller.signal }, async () => ({ pages: [makePage(), makePage(100)], resources: [], warnings: ['只读兼容解析'] }));
  const root = container.shadowRoot, first = root.querySelector('.np-note-paper path').getAttribute('d');
  root.querySelector('[aria-label="下一页"]').click(); await wait();
  assert.notEqual(root.querySelector('.np-note-paper path').getAttribute('d'), first);
  assert.equal(root.querySelector('[aria-label="页码"]').value, '2');
  assert.equal(root.querySelectorAll('script').length, 0);
  controller.abort(); destroy();
  assert.equal(root.childNodes.length, 0); assert.equal(disconnected, before + 1); container.remove();
});

test('预览和附件明确区分，切换资源回收 Blob，关闭后迟到读取不回填', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const controller = new AbortController(); let complete;
  const resources = [{ label: '内嵌预览（通常仅首页）', preview: true, read: async () => new Uint8Array([137, 80, 78, 71]) },
    { label: '附件 · 延迟', read: () => new Promise((resolve) => { complete = resolve; }) }];
  const before = revoked;
  const destroy = await mountNotebook({ container, name: '测试', signal: controller.signal }, async () => ({ pages: [], resources, warnings: ['仅为预览或附件'] }));
  const root = container.shadowRoot;
  assert.match(root.querySelector('img').alt, /不能代表完整笔记/);
  const choose = root.querySelector('[aria-label="查看笔迹或内嵌资源"]'); choose.click();
  root.querySelectorAll('[role="option"]')[1].click();
  assert.equal(revoked, before + 1);
  controller.abort(); complete(new Uint8Array([137, 80, 78, 71])); await wait();
  assert.equal(root.childNodes.length, 0); destroy(); container.remove();
});
