// 自绘下拉框在 Shadow DOM 中用真实事件顺序验证：按下选项不能让触发按钮失焦。
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

const dom=new JSDOM('<!doctype html><div id="host"></div>',{pretendToBeVisual:true});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,ShadowRoot:dom.window.ShadowRoot,innerWidth:1024,innerHeight:768,addEventListener:()=>{},removeEventListener:()=>{}});
const {dropdown}=await import('../shared/view.mjs');

test('按下下拉选项时阻止默认行为，菜单不因失焦提前收起',()=>{
  const root=dom.window.document.getElementById('host').attachShadow({mode:'open'});let chosen=null;
  const trigger=dropdown({options:[['','请选择'],['a','项目']],value:'',onChange:(v)=>{chosen=v;}});root.append(trigger);
  trigger.click();const option=root.querySelectorAll('.np-option')[1];assert.ok(option);
  const down=new dom.window.MouseEvent('mousedown',{bubbles:true,cancelable:true,composed:true});option.dispatchEvent(down);
  assert.equal(down.defaultPrevented,true);
  option.click();assert.equal(chosen,'a');assert.equal(trigger.value,'a');assert.equal(root.querySelector('.np-menu'),null);
});
