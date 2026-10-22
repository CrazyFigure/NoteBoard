// 用完整 DOCX 解析与渲染验证页数，确保去重既能修复多页，也不会吞掉真实空页。
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { parseAsync, renderDocument } from 'docx-preview';
import { deduplicatePageBreaks } from '../word/pagination.mjs';
import { markPageNumberFields, updatePageNumberFields } from '../word/pageFields.mjs';

const dom = new JSDOM('');
// 测试中的页面节点来自同一个 DOM，库所需全局接口另外显式安装。
const { document } = dom.window;
for (const key of ['window', 'document', 'DOMParser', 'Node']) globalThis[key] = dom.window[key];
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const paragraph = (body) => `<w:p><w:r>${body}</w:r></w:p>`;
const text = (value) => `<w:t>${value}</w:t>`;
const manual = '<w:br w:type="page"/>', cached = '<w:lastRenderedPageBreak/>';

/** 构造可独立渲染的最小 Word 包，验证与插件相同的历史分页选项。 */
async function render(body) {
  const zip = new JSZip();
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  const options = { ignoreLastRenderedPageBreak:false, renderAltChunks:false };
  const doc = await parseAsync(await zip.generateAsync({ type:'uint8array' }), options);
  deduplicatePageBreaks(doc);
  const host = document.createElement('div');
  await renderDocument(doc, host, host, options);
  return Array.from(host.querySelectorAll('section.docx>article'), (article) => article.textContent);
}

test('手动分页后下一段页首的历史标记不再额外产生空页', async () => {
  const pages = await render(paragraph(text('第一页') + manual) + paragraph(cached + text('第二页') + manual) + paragraph(cached + text('第三页')));
  assert.deepEqual(pages, ['第一页', '第二页', '第三页']);
});

test('仅有历史分页的真实边界仍然分页，正文保持完整', async () => {
  assert.deepEqual(await render(paragraph(text('上一页') + cached + text('下一页'))), ['上一页', '下一页']);
});

test('连续手动分页保留用户有意插入的空白页', async () => {
  assert.deepEqual(await render(paragraph(text('第一页') + manual) + paragraph(manual) + paragraph(cached + text('第三页'))), ['第一页', '', '第三页']);
});

test('空段落占据版面，不能越过空段落消除后续历史分页', async () => {
  assert.deepEqual(await render(paragraph(text('第一页') + manual) + '<w:p/>' + paragraph(cached + text('第三页'))), ['第一页', '', '第三页']);
});

test('超链接和书签之间的重复标记去重，链接中的正文不丢失', async () => {
  const body = paragraph(text('第一页') + manual) + `<w:p><w:bookmarkStart w:id="1" w:name="section"/><w:hyperlink><w:r>${cached}${text('第二页')}</w:r></w:hyperlink><w:bookmarkEnd w:id="1"/></w:p>`;
  assert.deepEqual(await render(body), ['第一页', '第二页']);
});

test('页脚域按每页更新顺序页码和总页数，普通数字及其它域保持原样', async () => {
  const zip = new JSZip();
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="footer" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraph(text('第一页') + manual)}${paragraph(cached + text('第二页'))}<w:sectPr><w:footerReference w:type="default" r:id="footer"/></w:sectPr></w:body></w:document>`);
  const field = (code, value) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>${code}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r>${text(value)}</w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  zip.file('word/footer1.xml', `<w:ftr xmlns:w="${W}"><w:p><w:r>${text('第 ')}</w:r>${field(' PAGE ', '1')}<w:r>${text(' 页 / 共 ')}</w:r>${field(' NUMPAGES ', '99')}<w:r>${text(' 页；2026；')}</w:r>${field(' DATE ', '日期缓存')}</w:p></w:ftr>`);
  const options = { ignoreLastRenderedPageBreak:false };
  const doc = await parseAsync(await zip.generateAsync({ type:'uint8array' }), options);
  deduplicatePageBreaks(doc);markPageNumberFields(doc);
  const host = document.createElement('div');await renderDocument(doc, host, host, options);updatePageNumberFields(host);
  assert.deepEqual([...host.querySelectorAll('section.docx>footer')].map((footer) => footer.textContent), ['第 1 页 / 共 2 页；2026；日期缓存', '第 2 页 / 共 2 页；2026；日期缓存']);
});
