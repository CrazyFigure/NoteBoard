// Apple 二进制/XML plist 的只读解析器：不实例化归档类，UID 仅由业务层显式解引用。
const decoder = new TextDecoder();

/** 按格式读取有界整数，拒绝精度丢失、非法偏移和深度过大的结构。 */
export function parsePlist(bytes) {
  if (decoder.decode(bytes.subarray(0, 8)) !== 'bplist00') return parseXmlPlist(decoder.decode(bytes));
  if (bytes.length < 40) throw new Error('plist 数据不完整');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const range = (at, size) => { if (!Number.isSafeInteger(at) || at < 0 || at + size > bytes.length) throw new Error('plist 数据越界'); };
  const uint = (at, size) => {
    range(at, size);
    if (size < 1 || size > 8) throw new Error('plist 整数长度无效');
    let n = 0; for (let i = 0; i < size; i++) n = n * 256 + bytes[at + i];
    if (!Number.isSafeInteger(n)) throw new Error('plist 整数过大');
    return n;
  };
  const trailer = bytes.length - 32, offsetSize = bytes[trailer + 6], refSize = bytes[trailer + 7];
  const count = uint(trailer + 8, 8), top = uint(trailer + 16, 8), table = uint(trailer + 24, 8);
  if (count > 200000 || top >= count || table + count * offsetSize > trailer) throw new Error('plist 对象表无效');
  const cache = new Map(), active = new Set();
  const read = (id, depth = 0) => {
    if (depth > 100 || id >= count || active.has(id)) throw new Error('plist 嵌套无效');
    if (cache.has(id)) return cache.get(id);
    active.add(id);
    let pos = uint(table + id * offsetSize, offsetSize);
    range(pos, 1);
    const tag = bytes[pos++], type = tag >> 4, info = tag & 15;
    let length = info, value;
    if ([4, 5, 6, 10, 13].includes(type) && info === 15) {
      range(pos, 1); const marker = bytes[pos++];
      if (marker >> 4 !== 1) throw new Error('plist 长度无效');
      const size = 2 ** (marker & 15); length = uint(pos, size); pos += size;
    }
    if (type === 0) value = info === 9 ? true : info === 8 ? false : null;
    else if (type === 1) {
      const size = 2 ** info;
      // Apple 对 64 位整数使用补码，归档中的 -1 等哨兵不能误报成超大正数。
      if (size === 8) { range(pos, 8); const integer = view.getBigInt64(pos, false); value = Number.isSafeInteger(Number(integer)) ? Number(integer) : integer; }
      else value = uint(pos, size);
    }
    else if (type === 2 || type === 3) {
      const size = type === 3 ? 8 : 2 ** info; range(pos, size);
      if (size !== 4 && size !== 8) throw new Error('plist 浮点数无效');
      value = size === 4 ? view.getFloat32(pos, false) : view.getFloat64(pos, false);
    } else if (type === 4) { range(pos, length); value = bytes.slice(pos, pos + length); }
    else if (type === 5 || type === 6) {
      range(pos, length * (type === 6 ? 2 : 1));
      value = (type === 6 ? new TextDecoder('utf-16be') : decoder).decode(bytes.subarray(pos, pos + length * (type === 6 ? 2 : 1)));
    } else if (type === 8) value = { uid: uint(pos, info + 1) };
    else if (type === 10 || type === 13) {
      if (length > 200000) throw new Error('plist 集合过大');
      range(pos, length * refSize * (type === 13 ? 2 : 1));
      const items = Array.from({ length }, (_, i) => read(uint(pos + i * refSize, refSize), depth + 1));
      if (type === 10) value = items;
      else {
        value = Object.create(null);
        items.forEach((key, i) => { value[String(key)] = read(uint(pos + (length + i) * refSize, refSize), depth + 1); });
      }
    } else throw new Error('不支持此 plist 对象类型');
    active.delete(id); cache.set(id, value); return value;
  };
  return read(top);
}

/** XML plist 使用 DOMParser，不解析外部实体；集合键写入无原型对象。 */
function parseXmlPlist(text) {
  if (/<!ENTITY\b/i.test(text)) throw new Error('plist XML 不允许自定义实体');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror') || doc.doctype?.internalSubset) throw new Error('plist XML 无效');
  let count = 0;
  const read = (node, depth = 0) => {
    if (!node || depth > 100 || ++count > 200000) throw new Error('plist 结构无效');
    const children = [...node.children], value = node.textContent ?? '';
    if (node.tagName === 'dict') {
      const result = Object.create(null);
      if (children.length % 2) throw new Error('plist 字典无效');
      for (let i = 0; i < children.length; i += 2) {
        if (children[i].tagName !== 'key') throw new Error('plist 字典缺少键');
        result[children[i].textContent] = read(children[i + 1], depth + 1);
      }
      // plutil 转换后的 UID 使用 CF$UID 字典，仍保留引用语义。
      return Object.keys(result).length === 1 && Number.isInteger(result['CF$UID']) ? { uid: result['CF$UID'] } : result;
    }
    if (node.tagName === 'array') return children.map((child) => read(child, depth + 1));
    if (node.tagName === 'data') return Uint8Array.from(atob(value.replace(/\s/g, '')), (c) => c.charCodeAt(0));
    if (node.tagName === 'integer' || node.tagName === 'real') {
      const n = Number(value); if (!Number.isFinite(n)) throw new Error('plist 数字无效'); return n;
    }
    if (node.tagName === 'true' || node.tagName === 'false') return node.tagName === 'true';
    if (node.tagName === 'string' || node.tagName === 'date') return value;
    throw new Error('不支持此 plist XML 类型');
  };
  if (doc.documentElement.tagName !== 'plist') throw new Error('不是 plist 文件');
  return read(doc.documentElement.firstElementChild);
}
