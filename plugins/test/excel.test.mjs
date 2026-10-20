// 行列尺寸前缀和决定虚拟化与命中，调整宽高后定位必须同步更新。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Axis, columnSizes, rowSizes } from '../excel/index.mjs';

test('前缀和定位与命中，越界时夹到首尾',()=>{
  const axis=new Axis([10,20,0,30]);
  assert.equal(axis.total,60);assert.equal(axis.start(3),30);assert.equal(axis.end(1),30);
  assert.equal(axis.indexAt(-5),0);assert.equal(axis.indexAt(9.9),0);assert.equal(axis.indexAt(10),1);
  // 隐藏行列宽度为 0，命中落到其后的可见项。
  assert.equal(axis.indexAt(30),3);assert.equal(axis.indexAt(999),3);
});

test('调整尺寸只重算其后的偏移',()=>{
  const axis=new Axis([10,10,10]);
  axis.resize(1,40);
  assert.deepEqual([...axis.offsets],[0,10,50,60]);assert.equal(axis.indexAt(49),1);
});

test('列宽与行高读取文件设置，隐藏为 0，缺省使用默认值',()=>{
  assert.deepEqual(columnSizes([{wpx:80},{wch:10},{hidden:true},undefined],5),[80,75,0,100,100]);
  assert.deepEqual(rowSizes([{hpx:40},{hpt:30},{hidden:true}],4),[40,40,0,26]);
});
