// EPUB 内部路径与书籍样式作用域是渲染正确性的基础，单独覆盖边界写法。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePath } from '../epub/book.mjs';
import { scopeBookCss } from '../epub/index.mjs';

test('按 OPF/章节位置解析相对路径，去掉片段并解码',()=>{
  assert.equal(resolvePath('OEBPS/content.opf','Text/ch1.xhtml'),'OEBPS/Text/ch1.xhtml');
  assert.equal(resolvePath('OEBPS/Text/ch1.xhtml','../Images/a%20b.png'),'OEBPS/Images/a b.png');
  assert.equal(resolvePath('OEBPS/Text/ch1.xhtml','ch2.xhtml#note-3'),'OEBPS/Text/ch2.xhtml');
  assert.equal(resolvePath('content.opf','./ch1.xhtml'),'ch1.xhtml');
  // 越过根目录的上级引用不会逃出压缩包。
  assert.equal(resolvePath('a.xhtml','../../x.css'),'x.css');
});

test('书籍样式中的 html/body 选择器改指向正文容器，不误伤 tbody 等名称',()=>{
  assert.equal(scopeBookCss('body{margin:0}html,body p{color:red}'),'.np-epub-body{margin:0}.np-epub-body,.np-epub-body p{color:red}');
  assert.equal(scopeBookCss('tbody td{padding:0}.body{x:1}'),'tbody td{padding:0}.body{x:1}');
});
