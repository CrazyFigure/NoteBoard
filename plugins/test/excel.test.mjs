// 行列尺寸前缀和决定虚拟化与命中，调整宽高后定位必须同步更新。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Axis, columnSizes, rowSizes } from '../excel/index.mjs';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {JSDOM} from 'jsdom';
import {cleanOpenXml} from '../shared/openXml.mjs';

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

test('外链清理后 Excel 仍可读取 STORE 与 DEFLATE 混合压缩的工作簿',async()=>{
  const dom=new JSDOM(''),parser=globalThis.DOMParser,serializer=globalThis.XMLSerializer;
  globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;
  try{
    const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['中文',42]]),'数据');
    const zip=await JSZip.loadAsync(XLSX.write(book,{type:'array',bookType:'xlsx'}));
    zip.file('xl/media/unused.bin',new Uint8Array([0,255,128]));
    zip.file('xl/_rels/unused.xml.rels','<Relationships><Relationship TargetMode="External" Target="https://example.com"/></Relationships>');
    const bytes=await cleanOpenXml(await zip.generateAsync({type:'uint8array',compression:'STORE'}),undefined,{maxBytes:256*1024*1024});
    const parsed=XLSX.read(bytes,{type:'array'});
    assert.equal(parsed.Sheets['数据'].A1.v,'中文');assert.equal(parsed.Sheets['数据'].B1.v,42);
  }finally{globalThis.DOMParser=parser;globalThis.XMLSerializer=serializer;dom.window.close();}
});
