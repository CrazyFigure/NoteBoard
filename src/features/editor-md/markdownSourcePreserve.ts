// NoteBoard Markdown 顶层块原文保留
// 进入可视化时不再整篇规范化：解析时记录每个顶层块的原文与内容指纹，
// 序列化时内容未变的块逐字写回原文（含块间空行、引用定义等无节点内容），
// 只有被编辑过的块按序列化器规则重写。
// 共享文档规则：后台准备与主线程共用，禁止引入界面、store 或原生 API。

import type { JSONContent } from '@tiptap/core';

/** 一个顶层原文条目：对应解析时一个 token 生成的连续 count 个顶层节点。 */
export interface SourceBlockEntry {
  /** 与前一条目之间的原文（空行、引用定义等不生成节点的内容） */
  gap: string;
  /** 条目自身原文（不含尾部换行，space 条目除外） */
  raw: string;
  /** 生成的顶层节点数 */
  count: number;
  /** 每个节点的内容指纹 */
  hashes: number[];
  /** 由多余空行生成的空段落条目 */
  space?: boolean;
  /** 间隔中的无节点内容（引用定义等，不含空行）；失去原位置时单独写回 */
  defs?: string;
  /** defs 中含有实际生效的内容（而非全是被忽略的重复定义） */
  defsEffective?: boolean;
}

/** 文档级原文记录：存放在 doc 属性 sourceBlocks 上，随文档快照、worker 结果一起传递。 */
export interface SourceBlocks {
  entries: SourceBlockEntry[];
  /** 最后一个条目之后的原文（末尾换行、文末引用定义等） */
  tail: string;
  /** 文末原文中的无节点内容 */
  tailDefs?: string;
  tailDefsEffective?: boolean;
}

/** 序列化时写在临时 JSON 上的标记（只存在于序列化副本，不进入编辑器文档）。 */
export const SOURCE_RAW_ATTR = '__sourceRaw';
export const SOURCE_GAP_ATTR = '__sourceGap';
export const SOURCE_SKIP_ATTR = '__sourceSkip';
export const SOURCE_ORPHAN_ATTR = '__sourceOrphan';
export const SOURCE_ORPHAN_AFTER_ATTR = '__sourceOrphanAfter';
export const SOURCE_TAIL_ATTR = '__sourceTail';

/** 根层 token 记录：原文与实际生成的顶层节点数 */
interface TopLevelUnit {
  raw: string;
  type: string;
  count: number;
  /** 被词法器忽略的重复引用定义：不影响文档语义 */
  ignored?: boolean;
}

type AnyFunction = (...args: unknown[]) => unknown;

/** 解析结果的节点数：null 不生成节点，数组按长度，单个对象算 1 个。 */
function countParsed(result: unknown): number {
  if (result === null || result === undefined) return 0;
  return Array.isArray(result) ? result.length : 1;
}

/**
 * 在一次同步解析期间记录根层 token 与节点数。
 * 临时包装 MarkdownManager 的 parseTokens / parseToken / createImplicitEmptyParagraphsFromSpace，
 * 用嵌套深度只记录根文档那一层，结束后恢复原方法；方法缺失时返回 null（放弃原文保留）。
 */
export function recordTopLevelTokens<T>(manager: object, parse: () => T): { parsed: T; units: TopLevelUnit[] | null } {
  const target = manager as Record<string, unknown>;
  const names = ['parseTokens', 'parseToken', 'createImplicitEmptyParagraphsFromSpace'] as const;
  const originals = names.map((name) => target[name]);
  if (originals.some((fn) => typeof fn !== 'function')) return { parsed: parse(), units: null };
  const ownDescriptors = names.map((name) => Object.getOwnPropertyDescriptor(target, name));
  const [parseTokens, parseToken, createSpace] = originals as AnyFunction[];
  const units: TopLevelUnit[] = [];
  // listDepth：parseTokens 嵌套层数；tokenDepth：parseToken 嵌套层数（列表等会直接递归 parseToken）
  let listDepth = 0;
  let tokenDepth = 0;
  target.parseTokens = function (this: unknown, ...args: unknown[]) {
    listDepth += 1;
    try {
      return parseTokens.apply(this, args);
    } finally {
      listDepth -= 1;
    }
  };
  target.parseToken = function (this: unknown, ...args: unknown[]) {
    const isRoot = listDepth === 1 && tokenDepth === 0;
    tokenDepth += 1;
    let result: unknown;
    try {
      result = parseToken.apply(this, args);
    } finally {
      tokenDepth -= 1;
    }
    if (isRoot) {
      const token = args[0] as { raw?: string; type?: string } | undefined;
      units.push({ raw: token?.raw ?? '', type: token?.type ?? '', count: countParsed(result) });
    }
    return result;
  };
  target.createImplicitEmptyParagraphsFromSpace = function (this: unknown, ...args: unknown[]) {
    const result = createSpace.apply(this, args);
    if (listDepth === 1 && tokenDepth === 0) {
      const token = args[0] as { raw?: string } | undefined;
      units.push({ raw: token?.raw ?? '', type: 'space', count: countParsed(result) });
    }
    return result;
  };
  try {
    return { parsed: parse(), units };
  } finally {
    // 恢复原状：原本是实例自有属性的写回，否则删除包装让原型方法重新生效
    names.forEach((name, index) => {
      const descriptor = ownDescriptors[index];
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else delete target[name];
    });
  }
}

/** cyrb53：53 位字符串哈希，主线程与 worker 结果一致。 */
function cyrb53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 最小的 ProseMirror 节点接口（避免共享规则依赖具体 Node 实现） */
export interface PreservableNode {
  type: { name: string };
  attrs: Record<string, unknown>;
  childCount: number;
  toJSON(): JSONContent;
  forEach(callback: (child: PreservableNode, offset: number, index: number) => void): void;
}

// PM 节点不可变：未改动的块保持同一对象，指纹只需计算一次
const hashCache = new WeakMap<object, number>();

/** 顶层节点的内容指纹：基于 schema 规范化后的完整 JSON（含属性与标记）。 */
export function hashBlockNode(node: PreservableNode): number {
  const cached = hashCache.get(node);
  if (cached !== undefined) return cached;
  const hash = cyrb53(JSON.stringify(node.toJSON()));
  hashCache.set(node, hash);
  return hash;
}

// 非 space 条目尾部的换行与空白归入下一个间隔，块原文本身不带结尾换行
const TRAILING_BREAK = /\n[\n \t]*$/;

// 引用定义行：`[标签]: 地址`；其后的标题可另起一行（以空白或引号、括号开头）
const LINK_DEFINITION_LINE = /^ {0,3}\[(?:\\.|[^\]\\])+\]:/;
const LINK_DEFINITION_CONTINUATION = /^[ \t]+\S|^["'(]/;

/** 判断一段被词法器吞掉的原文是否只由引用定义与空行组成 */
function isLinkDefinitions(text: string): boolean {
  const lines = text.split('\n');
  let sawDefinition = false;
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (LINK_DEFINITION_LINE.test(line)) sawDefinition = true;
    else if (!sawDefinition || !LINK_DEFINITION_CONTINUATION.test(line)) return false;
  }
  return sawDefinition;
}

/**
 * 由根层 token 记录生成原文条目。
 * 原文拼接必须与解析输入（换行统一为 LF）逐字一致，节点数必须与文档顶层节点数一致，否则放弃保留。
 */
export function buildSourceBlocks(units: TopLevelUnit[] | null, markdown: string, doc: PreservableNode): SourceBlocks | null {
  if (!units) return null;
  const source = markdown.replace(/\r\n?/g, '\n');
  // 逐段核对原文：词法器按 raw 长度推进，拼接必须与原文一致。
  // 个别第三方分词器（如任务列表）在文末无换行时会在 raw 末尾多补换行，按原文截掉。
  // 词法器还会直接吞掉重复标签的引用定义（不生成 token），这段原文补为不生成节点的间隔。
  let position = 0;
  const aligned: TopLevelUnit[] = [];
  for (const unit of units) {
    if (!source.startsWith(unit.raw, position)) {
      const skippedEnd = source.indexOf(unit.raw, position);
      if (skippedEnd > position && isLinkDefinitions(source.slice(position, skippedEnd))) {
        aligned.push({ raw: source.slice(position, skippedEnd), type: 'def', count: 0, ignored: true });
        position = skippedEnd;
      } else {
        const actual = source.slice(position, position + unit.raw.length);
        const overflow = unit.raw.slice(actual.length);
        if (position + unit.raw.length <= source.length || !unit.raw.startsWith(actual) || !/^\n+$/.test(overflow)) return null;
        unit.raw = actual;
      }
    }
    aligned.push(unit);
    position += unit.raw.length;
  }
  if (position < source.length && isLinkDefinitions(source.slice(position))) {
    aligned.push({ raw: source.slice(position), type: 'def', count: 0, ignored: true });
    position = source.length;
  }
  if (position !== source.length) return null;
  units = aligned;

  const children: PreservableNode[] = [];
  doc.forEach((child) => children.push(child));
  const entries: SourceBlockEntry[] = [];
  let gap = '';
  let defs: string[] = [];
  let defsEffective = false;
  // 间隔中的无节点内容：全部保留文字，同时记录其中是否有实际生效的定义
  const takeDefs = (): { defs?: string; defsEffective?: boolean } => {
    const text = defs.filter(Boolean).join('\n');
    const result = text ? { defs: text, ...(defsEffective ? { defsEffective: true } : {}) } : {};
    defs = [];
    defsEffective = false;
    return result;
  };
  let cursor = 0;
  for (const unit of units) {
    if (unit.count === 0) {
      // 不生成节点的内容（引用定义、普通空行）并入下一条目之前的间隔
      gap += unit.raw;
      if (unit.type !== 'space') {
        const lines = meaningfulLines(unit.raw);
        defs.push(lines);
        if (lines && !unit.ignored) defsEffective = true;
      }
      continue;
    }
    const entryDefs = takeDefs();
    if (cursor + unit.count > children.length) return null;
    const hashes = children.slice(cursor, cursor + unit.count).map(hashBlockNode);
    cursor += unit.count;
    if (unit.type === 'space') {
      entries.push({ gap, raw: unit.raw, count: unit.count, hashes, space: true, ...entryDefs });
      gap = '';
      continue;
    }
    const trailing = TRAILING_BREAK.exec(unit.raw)?.[0] ?? '';
    entries.push({ gap, raw: unit.raw.slice(0, unit.raw.length - trailing.length), count: unit.count, hashes, ...entryDefs });
    gap = trailing;
  }
  if (cursor !== children.length) return null;
  const tail = takeDefs();
  return { entries, tail: gap, ...(tail.defs ? { tailDefs: tail.defs, ...(tail.defsEffective ? { tailDefsEffective: true } : {}) } : {}) };
}

// ── 序列化：对齐原条目与当前顶层节点 ──

// Myers 差异的最大编辑距离；超出后改用贪心对齐（只影响保留比例，不影响正确性）
const MAX_DIFF_DISTANCE = 1000;

/** Myers 差异：返回 a、b 区间内的匹配对；超过编辑距离上限时返回 null。 */
function myersMatches(a: number[], aStart: number, aEnd: number, b: number[], bStart: number, bEnd: number): Array<[number, number]> | null {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  const limit = Math.min(n + m, MAX_DIFF_DISTANCE);
  const offset = limit + 1;
  const v = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        // 回溯得到匹配的对角线段
        const matches: Array<[number, number]> = [];
        let cx = n;
        let cy = m;
        for (let step = d; step >= 0; step -= 1) {
          const prev = trace[step];
          const ck = cx - cy;
          const prevK = ck === -step || (ck !== step && prev[offset + ck - 1] < prev[offset + ck + 1]) ? ck + 1 : ck - 1;
          const prevX = prev[offset + prevK];
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            cx -= 1;
            cy -= 1;
            matches.push([aStart + cx, bStart + cy]);
          }
          cx = prevX;
          cy = prevY;
        }
        return matches.reverse();
      }
    }
  }
  return null;
}

/** 贪心对齐：按哈希索引找最近的重新同步点，距离过远时视为原位替换。 */
function greedyMatches(a: number[], aStart: number, aEnd: number, b: number[], bStart: number, bEnd: number): Array<[number, number]> {
  const positions = (values: number[], start: number, end: number) => {
    const map = new Map<number, number[]>();
    for (let index = start; index < end; index += 1) {
      const list = map.get(values[index]);
      if (list) list.push(index);
      else map.set(values[index], [index]);
    }
    return map;
  };
  const nextAt = (map: Map<number, number[]>, value: number, from: number): number => {
    const list = map.get(value);
    if (!list) return -1;
    let left = 0;
    let right = list.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (list[middle] < from) left = middle + 1;
      else right = middle;
    }
    return left < list.length ? list[left] : -1;
  };
  const inA = positions(a, aStart, aEnd);
  const inB = positions(b, bStart, bEnd);
  const matches: Array<[number, number]> = [];
  const resyncLimit = 64;
  let i = aStart;
  let j = bStart;
  while (i < aEnd && j < bEnd) {
    if (a[i] === b[j]) {
      matches.push([i, j]);
      i += 1;
      j += 1;
      continue;
    }
    const nextA = nextAt(inA, b[j], i);
    const nextB = nextAt(inB, a[i], j);
    const distanceA = nextA < 0 ? Infinity : nextA - i;
    const distanceB = nextB < 0 ? Infinity : nextB - j;
    if (Math.min(distanceA, distanceB) > resyncLimit) {
      i += 1;
      j += 1;
    } else if (distanceA <= distanceB) {
      i = nextA;
    } else {
      j = nextB;
    }
  }
  return matches;
}

/** 返回当前每个节点对应的原槽位（-1 表示新内容），保证单调递增。 */
function alignSlots(slots: number[], current: number[]): Int32Array {
  const result = new Int32Array(current.length).fill(-1);
  let start = 0;
  while (start < slots.length && start < current.length && slots[start] === current[start]) {
    result[start] = start;
    start += 1;
  }
  let slotEnd = slots.length;
  let currentEnd = current.length;
  while (slotEnd > start && currentEnd > start && slots[slotEnd - 1] === current[currentEnd - 1]) {
    slotEnd -= 1;
    currentEnd -= 1;
    result[currentEnd] = slotEnd;
  }
  if (start < slotEnd && start < currentEnd) {
    const matches = myersMatches(slots, start, slotEnd, current, start, currentEnd)
      ?? greedyMatches(slots, start, slotEnd, current, start, currentEnd);
    for (const [slot, index] of matches) result[index] = slot;
  }
  return result;
}

// 原文以空行即可结束、不会吞掉后文的块类型；其余类型（围栏代码、HTML、公式等）可能未闭合
const SELF_TERMINATING_TYPES = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'githubAlert', 'table', 'horizontalRule', 'image']);

/** 编辑器在文末补出的辅助空段：不输出任何内容（与序列化流水线的判断一致）。 */
function isTrailingPlaceholder(node: PreservableNode, index: number, total: number): boolean {
  const attrs = node.attrs;
  return index === total - 1 && node.type.name === 'paragraph' && !!attrs.sourceTrailingPlaceholder
    && node.childCount === 0 && !attrs.textAlign && !(Number(attrs.indent) > 0);
}

/** 不产生任何输出的节点：文末辅助空段、未输入内容的空 HTML 块。 */
function isSilent(node: PreservableNode, index: number, total: number): boolean {
  if (isTrailingPlaceholder(node, index, total)) return true;
  return node.type.name === 'rawHtmlBlock' && String(node.attrs.raw ?? '') === '';
}

/**
 * 占位节点的内容：不参与渲染，但段落渲染器会根据前一兄弟是否为空段落决定空段写法，
 * 因此非空段落的占位必须保持“非空”，空段落保持为空。
 */
function stubContent(child: PreservableNode): { content?: JSONContent[] } {
  return child.type.name === 'paragraph' && child.childCount > 0 ? { content: [{ type: 'text', text: 'x' }] } : {};
}

/**
 * 无节点内容（引用定义等）的非空行；全为空白时返回空串。
 * 引用定义之间无需空行，失去原位置单独写回时以单换行相连，避免空行被解析为额外空段落。
 */
function meaningfulLines(gap: string): string {
  return gap.split('\n').filter((line) => line.trim() !== '').join('\n');
}

export interface PreservedSerializationJson {
  json: JSONContent;
  /** 文末原文已原样写入，流水线不得再按 trailingNewline 改写结尾 */
  verbatimTail: boolean;
}

/**
 * 构造序列化用 JSON：内容未变的顶层块替换为携带原文的轻量占位节点，其余节点照常输出。
 * 文档没有原文记录时退回整篇 toJSON（与原有行为一致）。
 */
export function buildPreservedSerializationJson(doc: PreservableNode): PreservedSerializationJson {
  const record = doc.attrs.sourceBlocks as SourceBlocks | null | undefined;
  if (!record || !Array.isArray(record.entries)) return { json: doc.toJSON(), verbatimTail: false };

  const children: PreservableNode[] = [];
  doc.forEach((child) => children.push(child));
  const total = children.length;
  const { entries } = record;

  // 原条目展开为槽位序列：槽位 → 所属条目
  const slotHashes: number[] = [];
  const slotEntry: number[] = [];
  const entryStart: number[] = [];
  entries.forEach((entry, entryIndex) => {
    entryStart.push(slotHashes.length);
    entry.hashes.forEach((hash) => {
      slotHashes.push(hash);
      slotEntry.push(entryIndex);
    });
  });

  // 只对会输出内容的节点做对齐
  const emitted: number[] = [];
  children.forEach((child, index) => {
    if (!isSilent(child, index, total)) emitted.push(index);
  });
  const currentHashes = emitted.map((index) => hashBlockNode(children[index]));
  const aligned = alignSlots(slotHashes, currentHashes);

  // 条目整组命中：count 个槽位连续对应到连续的输出节点
  const groupAt = new Map<number, number>(); // 输出序号 → 条目
  for (let position = 0; position < emitted.length; position += 1) {
    const slot = aligned[position];
    if (slot < 0) continue;
    const entryIndex = slotEntry[slot];
    if (entryStart[entryIndex] !== slot) continue;
    const { count } = entries[entryIndex];
    let whole = position + count <= emitted.length;
    for (let offset = 1; whole && offset < count; offset += 1) {
      if (aligned[position + offset] !== slot + offset) whole = false;
    }
    if (whole) groupAt.set(position, entryIndex);
  }

  // 按输出顺序决定每组是否原样输出，以及间隔是否与原文相邻
  const verbatim = new Map<number, { entry: number; gap: string | null }>();
  const gapWritten = new Set<number>();
  let previousVerbatimEntry = -1; // 紧邻前一个输出节点所属的原样条目
  let pendingSpace = -1; // 待确认的多余空行条目（输出位置）：其原文包含两侧分隔，后继也必须原样相邻
  const revertSpace = () => {
    if (pendingSpace < 0) return;
    const info = verbatim.get(pendingSpace);
    if (info) gapWritten.delete(info.entry);
    verbatim.delete(pendingSpace);
    pendingSpace = -1;
  };
  for (let position = 0; position < emitted.length; position += 1) {
    const entryIndex = groupAt.get(position);
    if (entryIndex === undefined) {
      revertSpace();
      previousVerbatimEntry = -1;
      continue;
    }
    const entry = entries[entryIndex];
    const groupEnd = position + entry.count;
    // 相邻：文首对应首条目，或紧跟原前驱条目（首条目出现在中间时一定不相邻）
    const adjacent = position === 0 ? entryIndex === 0 : entryIndex > 0 && previousVerbatimEntry === entryIndex - 1;
    // 原为最后一块且可能未闭合（围栏、HTML 等）而后面出现了新内容：按规则重写以免吞掉后文
    const followedWhenLast = entryIndex === entries.length - 1 && groupEnd < emitted.length
      && !SELF_TERMINATING_TYPES.has(children[emitted[position]].type.name);
    // 失去原前驱时，缩进开头的原文（缩进代码等）和多余空行条目可能改变含义，按规则重写
    const contextSensitive = !adjacent && (entry.space === true || /^[ \t]/.test(entry.raw));
    if (followedWhenLast || contextSensitive) {
      revertSpace();
      previousVerbatimEntry = -1;
      continue;
    }
    if (!adjacent) revertSpace();
    pendingSpace = -1;
    verbatim.set(position, { entry: entryIndex, gap: adjacent ? entry.gap : null });
    if (adjacent) gapWritten.add(entryIndex);
    if (entry.space) pendingSpace = position;
    previousVerbatimEntry = entryIndex;
    position = groupEnd - 1;
  }
  // 文末的多余空行条目只有在其后的原文末尾也逐字写回时才能保留
  if (pendingSpace >= 0 && verbatim.get(pendingSpace)?.entry !== entries.length - 1) revertSpace();

  // 没能原样写出的间隔中的引用定义等内容不能丢：放回原位置——写在该槽位对应的输出节点之前。
  // 相邻两个命中节点之间是一段替换区：区内原槽位与新节点按顺序一一对应，超出部分落在区段末尾；
  // 其后再无节点时放到文末。
  const slotAnchor = new Int32Array(slotHashes.length);
  let previousPosition = -1;
  let previousSlot = -1;
  const fillRegion = (position: number, slot: number) => {
    const regionChildren = position - previousPosition - 1;
    for (let offset = 0; previousSlot + 1 + offset < slot; offset += 1) {
      slotAnchor[previousSlot + 1 + offset] = previousPosition + 1 + Math.min(offset, regionChildren);
    }
    if (slot < slotHashes.length) slotAnchor[slot] = position;
    previousPosition = position;
    previousSlot = slot;
  };
  for (let position = 0; position < emitted.length; position += 1) {
    if (aligned[position] >= 0) fillRegion(position, aligned[position]);
  }
  fillRegion(emitted.length, slotHashes.length);

  const orphanBefore = new Map<number, string[]>();
  const orphanAfter: string[] = [];
  let orphanAfterEffective = false;
  entries.forEach((entry, entryIndex) => {
    if (gapWritten.has(entryIndex)) return;
    const content = entry.defs ?? '';
    if (!content) return;
    const anchor = slotAnchor[entryStart[entryIndex]];
    if (anchor < emitted.length) {
      const list = orphanBefore.get(anchor) ?? [];
      list.push(content);
      orphanBefore.set(anchor, list);
    } else {
      orphanAfter.push(content);
      if (entry.defsEffective) orphanAfterEffective = true;
    }
  });

  // 文末原文：最后一个条目原样输出且其后再无内容时逐字写回
  const lastPosition = emitted.length - 1;
  let tailWritten = false;
  if (entries.length > 0 && lastPosition >= 0) {
    for (const [position, info] of verbatim) {
      if (info.entry === entries.length - 1 && position + entries[info.entry].count - 1 === lastPosition) tailWritten = true;
    }
  }
  if (!tailWritten) {
    const content = record.tailDefs ?? '';
    if (content) orphanAfter.push(content);
    if (record.tailDefsEffective) orphanAfterEffective = true;
  }
  // 文末只剩被忽略的重复定义时不写回：它们本就不生效，而“空行 + 被吞掉的定义”结尾会被解析出多余空段落
  if (!orphanAfterEffective) orphanAfter.length = 0;

  // 组装 JSON：输出序号映射回子节点下标
  const content: JSONContent[] = [];
  const childPosition = new Map<number, number>();
  emitted.forEach((childIndex, position) => childPosition.set(childIndex, position));
  let skipUntil = -1;
  children.forEach((child, index) => {
    const position = childPosition.get(index);
    if (position === undefined) {
      content.push(child.toJSON());
      return;
    }
    if (position < skipUntil) {
      // 多节点条目的后续节点：已由首节点原文覆盖
      content.push({ type: child.type.name, attrs: { ...child.attrs, [SOURCE_SKIP_ATTR]: true }, ...stubContent(child) });
      return;
    }
    const orphans = orphanBefore.get(position);
    const info = verbatim.get(position);
    if (info) {
      const entry = entries[info.entry];
      skipUntil = position + entry.count;
      content.push({
        type: child.type.name,
        attrs: {
          ...child.attrs,
          [SOURCE_RAW_ATTR]: entry.raw,
          [SOURCE_GAP_ATTR]: info.gap,
          ...(orphans ? { [SOURCE_ORPHAN_ATTR]: orphans.join('\n') } : {}),
        },
        ...stubContent(child),
      });
      return;
    }
    const json = child.toJSON();
    if (orphans) json.attrs = { ...json.attrs, [SOURCE_ORPHAN_ATTR]: orphans.join('\n') };
    content.push(json);
  });

  const attrs: Record<string, unknown> = { ...doc.attrs };
  if (orphanAfter.length > 0) attrs[SOURCE_ORPHAN_AFTER_ATTR] = orphanAfter.join('\n');
  if (tailWritten) attrs[SOURCE_TAIL_ATTR] = record.tail;
  return { json: { type: 'doc', attrs, content }, verbatimTail: tailWritten };
}

/** 读取占位节点上的原文信息（普通节点返回 null） */
export function readPreservedBlock(node: JSONContent): { raw: string | null; gap: string | null; skip: boolean; orphan: string | null } | null {
  const attrs = node.attrs as Record<string, unknown> | undefined;
  if (!attrs) return null;
  const raw = typeof attrs[SOURCE_RAW_ATTR] === 'string' ? attrs[SOURCE_RAW_ATTR] as string : null;
  const skip = attrs[SOURCE_SKIP_ATTR] === true;
  const orphan = typeof attrs[SOURCE_ORPHAN_ATTR] === 'string' ? attrs[SOURCE_ORPHAN_ATTR] as string : null;
  if (raw === null && !skip && orphan === null) return null;
  const gap = typeof attrs[SOURCE_GAP_ATTR] === 'string' ? attrs[SOURCE_GAP_ATTR] as string : null;
  return { raw, gap, skip, orphan };
}
