// EPUB 内部路径与书籍样式作用域是渲染正确性的基础，单独覆盖边界写法。
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { resolvePath, readingChapters, chapterFragment, openBook } from '../epub/book.mjs';

// 阅读器依赖真实 DOM 接口；布局与指针捕获仍由浏览器验证，这里只模拟无布局环境缺少的接口。
const dom = new JSDOM('', { url:'http://localhost' });
for (const key of ['window', 'document', 'DOMParser', 'Element', 'HTMLInputElement', 'ShadowRoot', 'localStorage']) globalThis[key] = dom.window[key];
globalThis.innerWidth = 1200;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
dom.window.Element.prototype.scrollIntoView = function() {};
const { scopeBookCss, mount } = await import('../epub/index.mjs');

/** 生成最小 EPUB：两章共用正文文件，第三章单独文件，末尾另有不参与翻章的目录页。 */
async function sampleBook({ nav = false, noToc = false } = {}) {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>');
  zip.file('OEBPS/book.opf', `<package><metadata><title>测试书籍</title></metadata><manifest>
    <item id="body" href="body.xhtml" media-type="application/xhtml+xml"/>
    <item id="end" href="end.xhtml" media-type="application/xhtml+xml"/>
    <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" ${nav ? 'properties="nav"' : ''}/>
    ${noToc ? '' : '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'}
    </manifest><spine toc="ncx"><itemref idref="body"/><itemref idref="end"/><itemref idref="toc"/></spine>
    <guide><reference type="toc" href="toc.xhtml"/></guide></package>`);
  zip.file('OEBPS/body.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>简介</p><section><h1 id="one">第一章</h1><p>第一段</p><a href="#%E7%AC%AC%E4%BA%8C%E7%AB%A0">去第二章</a><a href="#note-later">跨章脚注</a></section><section><h1 id="第二章">第二章</h1><p>第二段</p><p id="note-later">脚注</p><script>throw 1</script><a href="end.xhtml#last">去第三章</a></section></body></html>');
  zip.file('OEBPS/end.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><a name="last"></a><h1>第三章</h1><p>第三段</p></body></html>');
  zip.file('OEBPS/toc.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><span>正文</span><ol><li><a href="body.xhtml#one">第一章</a></li><li><a href="body.xhtml#%E7%AC%AC%E4%BA%8C%E7%AB%A0">第二章</a></li></ol></li><li><a href="end.xhtml#last">第三章</a></li></ol></nav></body></html>');
  if (!noToc) zip.file('OEBPS/toc.ncx', '<ncx><navMap><navPoint><navLabel><text>第一章</text></navLabel><content src="body.xhtml#one"/></navPoint><navPoint><navLabel><text>第二章</text></navLabel><content src="body.xhtml#%E7%AC%AC%E4%BA%8C%E7%AB%A0"/></navPoint><navPoint><navLabel><text>第三章</text></navLabel><content src="end.xhtml#last"/></navPoint></navMap></ncx>');
  return zip.generateAsync({ type:'uint8array' });
}

/** 异步解压和净化完成后再断言最终章节，避免依赖任意固定延时。 */
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('章节切换未完成');
}

test('按 OPF/章节位置解析相对路径，去掉片段并解码',()=>{
  assert.equal(resolvePath('OEBPS/content.opf','Text/ch1.xhtml'),'OEBPS/Text/ch1.xhtml');
  assert.equal(resolvePath('OEBPS/Text/ch1.xhtml','../Images/a%20b.png'),'OEBPS/Images/a b.png');
  assert.equal(resolvePath('OEBPS/Text/ch1.xhtml','ch2.xhtml#note-3'),'OEBPS/Text/ch2.xhtml');
  assert.equal(resolvePath('content.opf','./ch1.xhtml'),'ch1.xhtml');
  assert.equal(resolvePath('OEBPS/Text/ch1.xhtml','#part'),'OEBPS/Text/ch1.xhtml');
  // 越过根目录的上级引用不会逃出压缩包。
  assert.equal(resolvePath('a.xhtml','../../x.css'),'x.css');
});

test('目录按书脊展开，保留未列出的正文，合并重复锚点并跳过目录页', () => {
  const spine = ['cover', 'body', 'end', 'toc'].map((path) => ({ path }));
  const item = (fragment, children = []) => ({ path:'body', fragment, label:fragment, children });
  const chapters = readingChapters(spine, [item('one', [item('one'), item('two')])], new Set(['toc']));
  assert.deepEqual(chapters.map(({ path, fragment, endFragment }) => [path, fragment, endFragment]), [['cover', '', ''], ['body', 'one', 'two'], ['body', 'two', ''], ['end', '', '']]);
});

test('章节切分保留嵌套结构，支持编码和 name 锚点，缺失或倒序结束锚点不会清空正文', () => {
  const body = new DOMParser().parseFromString('<body><section><h2 id="开始">第一章</h2><p>正文一</p></section><section><a name="two"></a><p>正文二</p></section></body>', 'text/html').body;
  const first = chapterFragment(body, { fragment:'%E5%BC%80%E5%A7%8B', endFragment:'two' });
  assert.match(first.textContent, /正文一/); assert.doesNotMatch(first.textContent, /正文二/);
  assert.ok(first.querySelector('section > h2'));
  assert.equal(chapterFragment(body, { fragment:'two', endFragment:'开始' }).textContent, '正文二');
  assert.match(chapterFragment(body, { fragment:'missing', endFragment:'missing' }).textContent, /正文一.*正文二/);
});

test('EPUB 2 NCX 和 EPUB 3 嵌套导航均识别同文件多章，并排除独立目录文档', async () => {
  for (const nav of [false, true]) {
    const book = await openBook(await sampleBook({ nav }));
    assert.equal(book.spine.length, 3); assert.equal(book.chapters.length, 3);
    assert.deepEqual(book.chapters.map((item) => item.fragment), ['one', '第二章', 'last']);
    assert.equal(book.chapters[0].endFragment, '第二章');
    assert.equal(book.chapters[1].endFragment, '');
  }
  const book = await openBook(await sampleBook({ noToc:true }));
  assert.equal(book.chapters.length, 2); assert.equal(book.toc.length, 2);
});

test('目录、工具栏、正文翻章、书内链接、高亮和进度恢复使用同一章节身份', async () => {
  localStorage.clear();
  const bytes = await sampleBook(), signal = new AbortController();
  const container = document.createElement('div'); document.body.append(container);
  let destroy = await mount({ container, name:'test.epub', bytes, signal:signal.signal, notify() {} });
  const root = container.shadowRoot, body = () => root.querySelector('.np-epub-page').shadowRoot;
  const page = () => root.querySelector('[aria-label="章节"]');
  const current = () => root.querySelector('.np-toc-item[aria-current=true]')?.textContent;
  try {
    assert.equal(root.querySelector('.np-muted').textContent, '/ 3 章');
    assert.equal(current(), '第一章'); assert.doesNotMatch(body().textContent, /第二段/);
    // 同文件链接跳转时也要切换逻辑章节，不能只寻找已截取正文中不存在的锚点。
    body().querySelector('a').click(); await until(() => current() === '第二章');
    assert.equal(current(), '第二章'); assert.match(body().textContent, /第二段/); assert.equal(body().querySelector('script'), null);
    root.querySelector('[aria-label="下一章"]').click(); await until(() => current() === '第三章');
    assert.equal(current(), '第三章'); assert.equal(root.querySelector('[aria-label="下一章"]').disabled, true);
    root.querySelector('[aria-label="上一章"]').click(); await until(() => current() === '第二章');
    body().querySelector('a').click(); await until(() => current() === '第三章');
    root.querySelectorAll('.np-toc-item')[0].click(); await until(() => current() === '第一章');
    body().querySelector('a[href="#nb-frag:note-later"]').click(); await until(() => current() === '第二章');
    assert.ok(body().querySelector('#note-later'));
    root.querySelector('.np-chapter-nav button:last-child').click(); await until(() => current() === '第三章');
    root.querySelectorAll('.np-toc-item')[1].click(); await until(() => current() === '第二章');
    root.querySelector('[role="separator"]').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true }));
    destroy();
    const saved = JSON.parse(localStorage.getItem(`nb-epub-progress:test.epub:${bytes.byteLength}`));
    assert.equal(saved.fragment, '第二章'); assert.equal(saved.tocWidth, 180);
    destroy = await mount({ container, name:'test.epub', bytes, signal:signal.signal, notify() {} });
    assert.equal(current(), '第二章'); assert.equal(root.querySelector('.np-epub').style.getPropertyValue('--np-toc-width'), '180px');
    // 快速连点只允许最后一次异步加载更新正文和选中状态。
    root.querySelectorAll('.np-toc-item')[0].click(); root.querySelectorAll('.np-toc-item')[2].click();
    await until(() => current() === '第三章'); assert.equal(current(), '第三章');
    signal.abort(); assert.equal(root.childNodes.length, 0);
  } finally { destroy(); container.remove(); }
});

test('书籍样式中的 html/body 选择器改指向正文容器，不误伤 tbody 等名称',()=>{
  assert.equal(scopeBookCss('body{margin:0}html,body p{color:red}'),'.np-epub-body{margin:0}.np-epub-body,.np-epub-body p{color:red}');
  assert.equal(scopeBookCss('tbody td{padding:0}.body{x:1}'),'tbody td{padding:0}.body{x:1}');
});
