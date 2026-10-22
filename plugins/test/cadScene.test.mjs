// 大图纸扩容必须同时覆盖完整显示、预算边界和循环引用，不能只改常量。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAD_LIMITS, prepareScene, canvasOptionsForScene, resolveInitialFit } from '../cad/scene.mjs';

/** 构造只含必需字段的图纸，不依赖私有业务图纸作为仓库夹具。 */
const drawing = (entities = [], blocks = {}) => ({ format: 'dxf', entities, blocks, layers: {}, metadata: {}, warnings: [] });
const line = () => ({ type: 'LINE', kind: 'line', startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } });
const insert = (name, extra = {}) => ({ type: 'INSERT', kind: 'insert', blockName: name, ...extra });

test('十几万源实体和近五十万展开实体可完整通过，模型空间重复定义及未用块被剔除', () => {
  const block = { name: 'Valve', entities: [line(), line(), line()] };
  const roots = Array.from({ length: 178_000 }, (_, i) => i < 100_000 ? insert('VALVE') : line());
  const doc = drawing(roots, { VALVE: block, valve: block, '*MODEL_SPACE': { entities: roots }, unused: { entities: [insert('unused')] } });
  const scene = prepareScene(doc);
  assert.equal(scene.stats.sourceEntities, 178_003);
  assert.equal(scene.stats.expandedEntities, 478_000);
  assert.equal(scene.stats.blocks, 1);
  assert.equal(doc.entities.length, 178_000);
  assert.deepEqual(Object.keys(doc.blocks), ['VALVE', 'valve']);
  assert.equal(scene.large, true);
  assert.equal(doc.blocks.VALVE, doc.blocks.valve);
  assert.equal(canvasOptionsForScene(scene, true).powerPreference, 'high-performance');
});

test('引用次数参与几何预算，共享块通过记忆化计算且不会无界展开', () => {
  const block = { entities: [line()] };
  const doc = drawing([insert('a', { insertRowCount: 1_000_000 })], { a: block });
  assert.equal(prepareScene(doc).stats.expandedEntities, 1_000_001);
  assert.throws(() => prepareScene(drawing([insert('a', { insertRowCount: 2_000_000 })], { a: block })), /展开实体数/);
  assert.throws(() => prepareScene(drawing([insert('a', { insertRowCount: Infinity })], { a: block })), /阵列实例数/);
});

test('循环块及超深块明确报错，恰好 32 层完整保留，缓存块在更深路径同样受限', () => {
  assert.throws(() => prepareScene(drawing([insert('a')], { a: { entities: [insert('a')] } })), /循环块/);
  const blocks = {};
  for (let i = 0; i < CAD_LIMITS.insertDepth; i++) blocks[String(i)] = { entities: i === 31 ? [line()] : [insert(String(i + 1))] };
  const scene = prepareScene(drawing([insert('0')], blocks));
  assert.equal(scene.stats.depth, 32);
  assert.equal(scene.stats.expandedEntities, 33);
  blocks.extra = { entities: [insert('0')] };
  assert.throws(() => prepareScene(drawing([insert('0'), insert('extra')], blocks)), /块嵌套层数/);
});

test('几何预算覆盖路径、填充与样条，重复引用的曲线也受绘制预算约束', () => {
  const entity = { type: 'PATH', commands: [{ cmd: 'L', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }], loops: [{ vertices: [{ x: 2, y: 2 }] }], controlPoints: [{ x: 3, y: 3 }], fitPoints: [{ x: 4, y: 4 }] };
  assert.equal(prepareScene(drawing([entity])).stats.geometryPoints, 6);
  const block = { entities: [{ type: 'CIRCLE', kind: 'circle' }] };
  assert.throws(() => prepareScene(drawing([insert('a', { insertRowCount: 300_000 })], { a: block })), /绘制几何量/);
});

test('保留图中及块属性文字，移除非显示缓存与未引用定义', () => {
  const attr = { type: 'ATTRIB', text: '阀门编号', xdata: [{ cache: 'unused' }] };
  const doc = drawing([insert('Valve', { attribs: [attr] }), { type: 'TEXT', text: '<script>原样显示</script>', name: 'unused' }], {
    Valve: { entities: [{ type: 'TEXT', text: '泵站' }] },
    unused: { entities: [{ type: 'TEXT', text: '未使用文字' }] },
  });
  doc.xrecords = [{ cache: 'unused' }];
  const scene = prepareScene(doc);
  assert.equal(scene.document.entities[0].attribs[0].text, '阀门编号');
  assert.equal(scene.document.entities[1].text, '<script>原样显示</script>');
  assert.equal(scene.document.blocks.Valve.entities[0].text, '泵站');
  assert.equal(scene.document.blocks.unused, undefined);
  assert.equal(attr.xdata, undefined);
  assert.equal(doc.xrecords, undefined);
});

test('大图需要 WebGL，小图仍支持 Canvas2D 兼容模式', () => {
  const small = prepareScene(drawing([line()]));
  assert.equal(canvasOptionsForScene(small, false).maxCurveSegments, 96);
  assert.throws(() => canvasOptionsForScene({ large: true }, false), /WebGL/);
});

test('保存视口落在空白处时补偿目标点偏移，已有内容的视口保持原样', () => {
  const doc = drawing([{ ...line(), startPoint: { x: 100, y: 200 }, endPoint: { x: 101, y: 201 } }]);
  doc.savedView = { source: 'vport', sceneTransformApplied: true, center: { x: 0, y: 0 }, target: { x: 100, y: 200 }, viewHeight: 10, aspectRatio: 1 };
  assert.equal(resolveInitialFit(doc), 'auto');
  assert.deepEqual(doc.savedView.center, { x: 100, y: 200 });
  assert.equal(resolveInitialFit(doc), 'auto');
  assert.deepEqual(doc.savedView.center, { x: 100, y: 200 });
  doc.savedView = { ...doc.savedView, center: { x: -500, y: -500 } };
  assert.equal(resolveInitialFit(doc), 'extents');
});

test('块插入点位于原视口但内部几何在远处时，仍按实际块边界修正空白视口', () => {
  const doc = drawing([insert('a', { insertionPoint: { x: 0, y: 0 } })], { a: { name: 'a', entities: [{ ...line(), startPoint: { x: 100, y: 200 }, endPoint: { x: 101, y: 201 } }] } });
  doc.savedView = { source: 'vport', sceneTransformApplied: true, center: { x: 0, y: 0 }, target: { x: 100, y: 200 }, viewHeight: 10, aspectRatio: 1 };
  assert.equal(resolveInitialFit(doc), 'auto');
  assert.deepEqual(doc.savedView.center, { x: 100, y: 200 });
});
