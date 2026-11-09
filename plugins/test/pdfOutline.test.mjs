// 验证 PDF 书签展平、目标页解析与当前位置高亮的规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutline, resolveDest, currentNode, visibleNode } from '../pdf/outline.mjs';

const ref = (num) => ({ num, gen: 0 });
const doc = {
  numPages: 40,
  async getDestination(name) { return name === 'named' ? [ref(28), { name: 'FitH' }, 500] : null; },
  async getPageIndex(r) { return r.num - 1; },
};

test('展平书签保留层级与父子关系，按 count 决定展开，标题去除多余空白', () => {
  const nodes = buildOutline([
    { title: '一、调研行程\n安排', dest: [ref(2)], items: [] },
    { title: '2.江盐集团', dest: 'named', count: -2, items: [{ title: '应急预案', dest: [ref(34)], items: [] }, { title: '', dest: null, items: [] }] },
    { title: '附录', dest: [ref(40)], items: [{ title: '子项', dest: [ref(40)], items: [] }] },
  ]);
  assert.deepEqual(nodes.map((n) => [n.title, n.depth]), [['一、调研行程 安排', 0], ['2.江盐集团', 0], ['应急预案', 1], ['（无标题）', 1], ['附录', 0], ['子项', 1]]);
  assert.equal(nodes[2].parent, nodes[1]); assert.equal(nodes[1].children.length, 2);
  assert.equal(nodes[1].expanded, false);
  // 未声明 count 时只展开第一层
  assert.equal(nodes[4].expanded, true); assert.equal(nodes[5].expanded, false);
});

test('书签数量超过上限时截断，空大纲返回空数组', () => {
  assert.equal(buildOutline(Array.from({ length: 10 }, (_, i) => ({ title: `${i}`, items: [] })), 3).length, 3);
  assert.deepEqual(buildOutline(null), []);
});

test('解析显式、命名与页序号目标，越界或无效目标返回空', async () => {
  assert.deepEqual(await resolveDest(doc, [ref(5), { name: 'XYZ' }, 72, 700, null]), { index: 4, left: 72, top: 700 });
  assert.deepEqual(await resolveDest(doc, 'named'), { index: 27, left: null, top: 500 });
  assert.deepEqual(await resolveDest(doc, [3, { name: 'Fit' }]), { index: 3, left: null, top: null });
  assert.equal(await resolveDest(doc, [ref(99), { name: 'Fit' }]), null);
  assert.equal(await resolveDest(doc, 'missing'), null);
  assert.equal(await resolveDest(doc, null), null);
});

test('当前书签取起始页不晚于当前页的最后一项，折叠时落到外层祖先', () => {
  const nodes = buildOutline([
    { title: 'A', items: [] },
    { title: 'B', count: -1, items: [{ title: 'B1', items: [] }] },
  ]);
  [0, 27, 33].forEach((index, i) => { nodes[i].target = { index, left: null, top: null }; });
  assert.equal(currentNode(nodes, 10), nodes[0]);
  assert.equal(currentNode(nodes, 35), nodes[2]);
  assert.equal(visibleNode(nodes[2]), nodes[1]);
  nodes[1].expanded = true;
  assert.equal(visibleNode(nodes[2]), nodes[2]);
  assert.equal(visibleNode(null), null);
});
