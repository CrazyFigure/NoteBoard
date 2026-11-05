// 有界 protobuf / Apple LZ4 / TPL 读取；不扫描猜测浮点数，未知编码交给预览回退。
import { NOTE_LIMIT } from '../shared/noteArchive.mjs';
const text = new TextDecoder();

/** protobuf uint64 只用于跳过未知字段；真正用于长度和键的值必须可安全表示。 */
function varint(bytes, cursor) {
  let value = 0n;
  for (let i = 0; i < 10 && cursor.at < bytes.length; i++) {
    const b = bytes[cursor.at++]; value |= BigInt(b & 127) << BigInt(i * 7);
    if (!(b & 128)) return value;
  }
  throw new Error('Goodnotes varint 损坏');
}

/** 保留重复字段，检查全部 wire 边界；不递归尝试解码任意字节串。 */
export function wire(bytes) {
  const fields = new Map(), cursor = { at: 0 }, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (cursor.at < bytes.length) {
    const tag = Number(varint(bytes, cursor)), kind = tag & 7, number = Math.floor(tag / 8);
    if (!Number.isSafeInteger(tag) || number < 1) throw new Error('Goodnotes 字段无效');
    let value;
    if (kind === 0) value = varint(bytes, cursor);
    else if (kind === 2) {
      const size = Number(varint(bytes, cursor));
      if (!Number.isSafeInteger(size) || cursor.at + size > bytes.length) throw new Error('Goodnotes 字段越界');
      value = bytes.subarray(cursor.at, cursor.at + size); cursor.at += size;
    } else if (kind === 5 || kind === 1) {
      const size = kind === 5 ? 4 : 8;
      if (cursor.at + size > bytes.length) throw new Error('Goodnotes 数字越界');
      value = size === 4 ? view.getFloat32(cursor.at, true) : view.getFloat64(cursor.at, true); cursor.at += size;
    } else throw new Error('Goodnotes wire 类型不支持');
    const list = fields.get(number) ?? []; list.push(value); fields.set(number, list);
  }
  return fields;
}

/** 每个 journal 是带 varint 长度的消息序列，记录数量也受预算约束。 */
export function records(bytes) {
  const result = [], cursor = { at: 0 };
  while (cursor.at < bytes.length) {
    const size = Number(varint(bytes, cursor));
    if (!Number.isSafeInteger(size) || cursor.at + size > bytes.length || result.length >= 200000) throw new Error('Goodnotes 日志无效或过大');
    result.push(bytes.subarray(cursor.at, cursor.at + size)); cursor.at += size;
  }
  return result;
}
export const field = (fields, number) => fields.get(number)?.[0];
export const stringField = (fields, number) => field(fields, number) instanceof Uint8Array ? text.decode(field(fields, number)) : '';

/** Apple 分帧 LZ4 的块共享 64KB 历史；为每个 blob 预核算预算，拒绝错误回溯。 */
export function appleLz4(bytes) {
  if (text.decode(bytes.subarray(0, 4)) === 'tpl\0') return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), blocks = [];
  let at = 0, total = 0, ended = false;
  while (at + 4 <= bytes.length) {
    const magic = text.decode(bytes.subarray(at, at + 4)); at += 4;
    if (magic === 'bv4$') { ended = true; break; }
    if (!['bv41', 'bv4-'].includes(magic) || at + 4 > bytes.length) throw new Error('不支持此 Goodnotes 压缩格式');
    const size = view.getUint32(at, true); at += 4;
    let packed = size;
    if (magic === 'bv41') { if (at + 4 > bytes.length) throw new Error('LZ4 帧损坏'); packed = view.getUint32(at, true); at += 4; }
    total += size;
    if (total > NOTE_LIMIT || at + packed > bytes.length) throw new Error('LZ4 数据过大或损坏');
    blocks.push({ start: at, packed, size, raw: magic === 'bv4-' }); at += packed;
  }
  if (!ended || at !== bytes.length) throw new Error('LZ4 缺少结束标记');
  const out = new Uint8Array(total); let pos = 0;
  for (const block of blocks) {
    const end = block.start + block.packed, expected = pos + block.size; let source = block.start;
    if (block.raw) { out.set(bytes.subarray(source, end), pos); pos = expected; continue; }
    const length = (base) => {
      let n = base;
      if (base === 15) { let b; do { if (source >= end) throw new Error('LZ4 长度损坏'); b = bytes[source++]; n += b; } while (b === 255); }
      return n;
    };
    while (source < end) {
      const token = bytes[source++], literals = length(token >> 4);
      if (source + literals > end || pos + literals > expected) throw new Error('LZ4 字面量越界');
      out.set(bytes.subarray(source, source + literals), pos); pos += literals; source += literals;
      if (source === end) break;
      if (source + 2 > end) throw new Error('LZ4 偏移损坏');
      const offset = bytes[source] | bytes[source + 1] << 8; source += 2;
      const match = length(token & 15) + 4;
      if (!offset || offset > pos || pos + match > expected) throw new Error('LZ4 回溯越界');
      for (let i = 0; i < match; i++, pos++) out[pos] = out[pos - offset];
    }
    if (pos !== expected) throw new Error('LZ4 块长度不匹配');
  }
  return out;
}

/** TPL 仅接受已知类型签名，逐段校验长度；未知结构不使用启发式坐标扫描。 */
export function tplSections(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 9 || text.decode(bytes.subarray(0, 4)) !== 'tpl\0' || view.getUint32(4, true) !== bytes.length) throw new Error('TPL 头损坏');
  const end = bytes.indexOf(0, 8);
  if (end < 0 || end > 1024) throw new Error('TPL 签名无效');
  const signature = text.decode(bytes.subarray(8, end)), sections = []; let at = end + 1, consumed = '';
  for (const match of signature.matchAll(/A\(S\([vu]+\)\)|A\([vuf]\)|[vu]/g)) {
    const token = match[0]; consumed += token;
    const array = token.startsWith('A('), struct = token.startsWith('A(S(');
    const spec = struct ? token.slice(4, -2) : array ? token[2] : token;
    let count = 1;
    if (array) { if (at + 4 > bytes.length) throw new Error('TPL 长度缺失'); count = view.getUint32(at, true); at += 4; }
    const stride = [...spec].reduce((sum, type) => sum + (type === 'v' ? 2 : 4), 0);
    if (count > 1000000 || at + count * stride > bytes.length) throw new Error('TPL 数组越界');
    const values = [];
    for (let i = 0; i < count; i++) {
      const item = [];
      for (const type of spec) { item.push(type === 'v' ? view.getUint16(at, true) : view.getFloat32(at, true)); at += type === 'v' ? 2 : 4; }
      values.push(struct ? item : item[0]);
    }
    sections.push({ array, struct, spec, values });
  }
  if (consumed !== signature || at !== bytes.length) throw new Error('尚不支持此 TPL 笔迹结构');
  return sections;
}

/** 依据类型签名定位路径；压感笔保留每点宽度，铅笔使用已验证的段端点。 */
export function strokePoints(bytes) {
  const sections = tplSections(appleLz4(bytes));
  // 只有首个标志数组定义采样布局，后续数组是段编码，不能混入位标志判断。
  const tilt = sections.find((s) => s.array && s.spec === 'v')?.values.some((n) => n & 4) ?? false;
  const floats = sections.filter((s) => s.array && !s.struct && s.spec === 'u');
  if (floats.length >= 2) {
    const values = floats[1].values, stride = tilt ? 9 : 3;
    if (values.length % stride) throw new Error('Goodnotes 压感路径长度无效');
    const result = [];
    for (let i = 0; i < values.length; i += stride) { result.push(values.slice(i, i + 3)); if (tilt) result.push(values.slice(i + 3, i + 6)); }
    return result;
  }
  const width = sections.find((s) => !s.array && s.spec === 'u')?.values[0] ?? 1;
  const segments = sections.find((s) => s.struct && s.spec.length === 11 && s.values.length)
    ?? sections.find((s) => s.struct && s.spec === 'uuuu' && s.values.length);
  if (!segments) return [];
  const pencil = segments.spec.length === 11, first = pencil ? 1 : 0, last = pencil ? 6 : 2;
  return [...segments.values.map((v) => [v[first], v[first + 1], width]),
    [segments.values.at(-1)[last], segments.values.at(-1)[last + 1], width]];
}
