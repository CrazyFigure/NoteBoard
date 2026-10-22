// EPUB 结构解析：container → OPF → 清单/书脊/目录；只读取压缩包内资源，不访问网络。
import JSZip from 'jszip';

const MAX_ENTRIES = 10000, MAX_TOTAL = 256 * 1024 * 1024;

/** 按 EPUB 内部路径规则解析相对地址；越过根目录的 .. 被忽略，结果不含片段。 */
export function resolvePath(base, href) {
  const clean = href.split('#')[0];
  // 纯锚点引用仍属于当前文档，不能退回到文档所在目录。
  if (!clean) return base;
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch { /* 保留原始写法 */ }
  const parts = decoded.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** 片段允许百分号编码；无效编码保留原文，兼容旧书的锚点名称。 */
export function decodeFragment(fragment = '') {
  try { return decodeURIComponent(fragment); } catch { return fragment; }
}

/** 按书脊顺序把目录锚点展开为阅读章节，排除独立导航页并保留未列入目录的正文。 */
export function readingChapters(spine, toc, navigationPaths = new Set()) {
  const targets = new Map();
  const walk = (items) => { for (const item of items) {
    if (item.path && !navigationPaths.has(item.path)) {
      const entries = targets.get(item.path) ?? [];
      const fragment = decodeFragment(item.fragment);
      // 父子目录或别名可能指向同一位置，同一锚点只参与一次翻章。
      if (!entries.some((entry) => entry.fragment === fragment)) entries.push({ path:item.path, fragment, label:item.label });
      targets.set(item.path, entries);
    }
    walk(item.children ?? []);
  } };
  walk(toc);
  return spine.flatMap((item, spineIndex) => {
    if (navigationPaths.has(item.path)) return [];
    const entries = targets.get(item.path) ?? [{ path:item.path, fragment:'', label:`第 ${spineIndex + 1} 章` }];
    return entries.map((entry, index) => ({ ...entry, spineIndex, endFragment:entries[index + 1]?.fragment ?? '' }));
  });
}

/** 同时支持 id 与旧式 name 锚点，不把书籍中的特殊字符拼接进 CSS 选择器。 */
export function findAnchor(root, fragment) {
  const name = decodeFragment(fragment);
  return name ? Array.from(root.querySelectorAll('[id],[name]')).find((node) => node.id === name || node.getAttribute('name') === name) : null;
}

/** 单文件多章节按相邻目录锚点截取，保留跨容器的结构；缺失或倒序锚点不截断正文。 */
export function chapterFragment(body, chapter) {
  const start = findAnchor(body, chapter.fragment), end = findAnchor(body, chapter.endFragment);
  const range = body.ownerDocument.createRange();
  range.selectNodeContents(body);
  if (start) range.setStartBefore(start);
  if (end && (!start || (start.compareDocumentPosition(end) & 4))) range.setEndBefore(end);
  return range.cloneContents();
}

const xml = (text) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('电子书结构数据损坏');
  return doc;
};
const byName = (root, name) => Array.from(root.getElementsByTagNameNS('*', name));

/** 读取书籍元信息、书脊顺序与目录树；DRM 加密的正文直接拒绝。 */
export async function openBook(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw new Error('电子书内部文件过多，无法打开');
  let total = 0;
  for (const entry of entries) { total += entry._data?.uncompressedSize ?? 0; if (total > MAX_TOTAL) throw new Error('电子书解压后超过 256 MB，无法打开'); }
  const read = async (path, type = 'string') => { const file = zip.file(path); if (!file) throw new Error(`电子书缺少文件：${path}`); return file.async(type); };

  const container = xml(await read('META-INF/container.xml'));
  const opfPath = byName(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('电子书缺少内容清单');
  const encryption = zip.file('META-INF/encryption.xml');
  const encrypted = new Set();
  if (encryption) {
    // 仅字体混淆（IDPF/Adobe）可以容忍；正文或图片被加密说明受 DRM 保护。
    for (const data of byName(xml(await encryption.async('string')), 'EncryptedData')) {
      const method = byName(data, 'EncryptionMethod')[0]?.getAttribute('Algorithm') ?? '';
      const uri = byName(data, 'CipherReference')[0]?.getAttribute('URI');
      if (uri) encrypted.add(resolvePath('', uri));
      if (uri && !/obfuscation|fonts/i.test(method) && !/\.(otf|ttf|woff2?)$/i.test(uri)) throw new Error('此电子书受 DRM 保护，无法打开');
    }
  }
  const opf = xml(await read(opfPath));
  const metadata = byName(opf, 'metadata')[0];
  const title = metadata ? byName(metadata, 'title')[0]?.textContent?.trim() : '';
  const creator = metadata ? byName(metadata, 'creator')[0]?.textContent?.trim() : '';
  const manifest = new Map();
  for (const item of byName(opf, 'item')) {
    const id = item.getAttribute('id'), href = item.getAttribute('href');
    if (id && href) manifest.set(id, { id, path:resolvePath(opfPath, href), type:item.getAttribute('media-type') ?? '', properties:item.getAttribute('properties') ?? '' });
  }
  const spineNode = byName(opf, 'spine')[0];
  const spine = byName(opf, 'itemref').map((ref) => manifest.get(ref.getAttribute('idref'))).filter((item) => item && /x?html/.test(item.type));
  if (!spine.length) throw new Error('电子书没有可阅读的章节');

  // 目录优先使用 EPUB 3 导航文档，缺失时回退到 EPUB 2 的 NCX。
  let toc = [];
  const nav = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'));
  if (nav && zip.file(nav.path)) {
    const doc = new DOMParser().parseFromString(await read(nav.path), 'application/xhtml+xml');
    const navs = byName(doc, 'nav');
    const tocNav = navs.find((node) => /toc/.test(node.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? node.getAttribute('epub:type') ?? '')) ?? navs[0];
    const walk = (list) => Array.from(list?.children ?? []).filter((li) => li.localName === 'li').map((li) => {
      const link = Array.from(li.children).find((child) => child.localName === 'a' || child.localName === 'span');
      const href = link?.getAttribute('href');
      return { label:(link?.textContent ?? '').replace(/\s+/g, ' ').trim(), path:href ? resolvePath(nav.path, href) : '', fragment:href?.split('#')[1] ?? '', children:walk(Array.from(li.children).find((child) => child.localName === 'ol')) };
    });
    toc = walk(tocNav && Array.from(tocNav.children).find((child) => child.localName === 'ol'));
  }
  if (!toc.length) {
    const ncx = manifest.get(spineNode?.getAttribute('toc') ?? '') ?? [...manifest.values()].find((item) => item.type === 'application/x-dtbncx+xml');
    if (ncx && zip.file(ncx.path)) {
      const doc = xml(await read(ncx.path));
      const walk = (parent) => Array.from(parent?.children ?? []).filter((node) => node.localName === 'navPoint').map((point) => {
        const src = byName(point, 'content')[0]?.getAttribute('src') ?? '';
        return { label:(byName(point, 'text')[0]?.textContent ?? '').trim(), path:src ? resolvePath(ncx.path, src) : '', fragment:src.split('#')[1] ?? '', children:walk(point) };
      });
      toc = walk(byName(doc, 'navMap')[0]);
    }
  }
  // 导航文档是辅助入口，不能成为正常阅读时的“下一章”。EPUB 2 通过 guide 标明目录页。
  const navigationPaths = new Set(nav ? [nav.path] : []);
  for (const ref of byName(opf, 'reference')) if (ref.getAttribute('type') === 'toc' && ref.getAttribute('href')) navigationPaths.add(resolvePath(opfPath, ref.getAttribute('href')));
  const chapters = readingChapters(spine, toc, navigationPaths);
  if (!chapters.length) throw new Error('电子书没有可阅读的章节');
  // 没有目录时按有效阅读章节生成列表，保证始终可以跳转。
  if (!toc.length) toc = chapters.map((item) => ({ ...item, children:[] }));
  const types = new Map([...manifest.values()].map((item) => [item.path, item.type]));
  return { zip, title, creator, spine, chapters, toc, types, encrypted, read:(path, type) => read(path, type) };
}
