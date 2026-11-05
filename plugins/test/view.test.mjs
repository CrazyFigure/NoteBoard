// 自绘下拉框在 Shadow DOM 中用真实事件顺序验证：按下选项不能让触发按钮失焦。
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

const dom=new JSDOM('<!doctype html><div id="host"></div>',{pretendToBeVisual:true});
// jsdom 不实现滚动布局；补齐接口，并记录事件异常，避免菜单打开失败仍被判断为通过。
dom.window.Element.prototype.scrollIntoView=function(){};
const eventErrors=[];
dom.window.addEventListener('error',(event)=>eventErrors.push(event.error));
Object.assign(globalThis,{window:dom.window,document:dom.window.document,ShadowRoot:dom.window.ShadowRoot,innerWidth:1024,innerHeight:768,addEventListener:()=>{},removeEventListener:()=>{}});
const view=await import('../shared/view.mjs');const {dropdown}=view;

test('按下下拉选项时阻止默认行为，菜单不因失焦提前收起',()=>{
  const root=dom.window.document.getElementById('host').attachShadow({mode:'open'});let chosen=null;
  const trigger=dropdown({options:[['','请选择'],['a','项目']],value:'',onChange:(v)=>{chosen=v;}});root.append(trigger);
  trigger.click();const option=root.querySelectorAll('.np-option')[1];assert.ok(option);
  const down=new dom.window.MouseEvent('mousedown',{bubbles:true,cancelable:true,composed:true});option.dispatchEvent(down);
  assert.equal(down.defaultPrevented,true);
  option.click();assert.equal(chosen,'a');assert.equal(trigger.value,'a');assert.equal(root.querySelector('.np-menu'),null);
  assert.deepEqual(eventErrors,[]);
});

test('沉浸阅读入口用书本图标，阅读中切换为退出图标',()=>{
  const {createView}=view;const host=dom.window.document.createElement('div');dom.window.document.body.append(host);
  let active=false;const listeners=new Set();
  const reading={get:()=>active,set:(next)=>{active=next;listeners.forEach((fn)=>fn(next));},subscribe:(fn)=>{listeners.add(fn);return()=>listeners.delete(fn);}};
  const v=createView(host,'sample.pdf',reading);const b=v.root.querySelector('.np-reading');
  const path=()=>b.querySelector('path')?.getAttribute('d')??'';
  assert.equal(b.getAttribute('aria-label'),'沉浸阅读');assert.match(path(),/^M12 7v14/);
  b.click();
  assert.equal(host.hasAttribute('data-reading'),true);assert.equal(b.getAttribute('aria-label'),'退出沉浸阅读');assert.match(path(),/^M4 14h6v6/);
  v.destroy();assert.equal(host.hasAttribute('data-reading'),false);
});
