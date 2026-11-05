// 验证 PDF.js 范围合并、失败与取消时的实际读取量，防止退回整文件复制。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRangeTransport } from '../pdf/range.mjs';

class Transport {
  constructor(size) { this.length=size;this.delivered=[]; }
  onDataRange(begin, bytes) { this.delivered.push({begin,bytes}); }
}
const tick=()=>new Promise((resolve)=>setImmediate(resolve));

test('512 MiB PDF 的小范围原样交付，合并范围每次读盘不超过 1 MiB 且串行执行',async()=>{
  const reads=[],errors=[],small=new Uint8Array([37,80,68,70]);let active=0,peak=0;
  const source={size:512*1024*1024,async read(begin,end){active++;peak=Math.max(peak,active);reads.push([begin,end]);await tick();active--;return end-begin===4?small:new Uint8Array(end-begin).fill(7);}};
  const transport=createRangeTransport(Transport,source,new AbortController().signal,(e)=>errors.push(e));
  transport.requestDataRange(0,4);transport.requestDataRange(100,100+2*1024*1024+8);
  for(let i=0;i<8;i++)await tick();
  assert.equal(transport.delivered[0].bytes,small);
  assert.equal(transport.delivered[1].bytes.length,2*1024*1024+8);
  assert.equal(transport.delivered[1].bytes.at(-1),7);
  assert.equal(reads.length,4);assert.ok(reads.every(([b,e])=>e-b<=1024*1024));
  assert.equal(peak,1);assert.deepEqual(errors,[]);
});

test('取消正在读取的范围后不再读取排队请求，也不回传过期结果',async()=>{
  const controller=new AbortController();let finish,calls=0;
  const source={size:100,read(){calls++;return new Promise((resolve)=>{finish=resolve;});}};
  const transport=createRangeTransport(Transport,source,controller.signal,()=>assert.fail('取消不能报错'));
  transport.requestDataRange(0,8);transport.requestDataRange(8,16);await tick();
  controller.abort();finish(new Uint8Array(8));await tick();
  assert.equal(calls,1);assert.deepEqual(transport.delivered,[]);
});

test('短读与非法范围只报一次错误并停止后续请求',async()=>{
  for(const invalid of [false,true]){
    const errors=[];let calls=0;
    const transport=createRangeTransport(Transport,{size:100,async read(){calls++;return new Uint8Array(1);}},new AbortController().signal,(e)=>errors.push(e));
    transport.requestDataRange(invalid?-1:0,8);transport.requestDataRange(8,16);await tick();
    assert.equal(calls,invalid?0:1);assert.equal(errors.length,1);assert.deepEqual(transport.delivered,[]);
  }
});
