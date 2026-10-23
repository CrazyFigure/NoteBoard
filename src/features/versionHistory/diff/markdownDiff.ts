// NoteBoard 文档历史记录：Markdown 渲染级差异（基于 ProseMirror 文档 JSON）
//
// 把新旧两版解析出的文档树合并成一棵「合并文档」：
//   - 顶层及容器内的块按「类型 + 规范化内容」做序列差异对齐
//   - 改动区间内类型相同、内容相近的块配对：文本块做行内差异，容器（列表、引用、表格等）递归比较
//   - 配不上的块整块标记为删除 / 新增；删除的内容保留在原位置，以删除线显示
// 行内差异的单位：中日韩文字按字、拉丁字母按词、空白与标点单独成单位，行内节点（图片、公式、换行）各算一个；
// 单位键带上格式标记，因此加粗等格式变化也会显示为删除 + 新增。
// 本模块是纯函数，不依赖编辑器实例；节点特性由调用方按 schema 提供。

import { diffSequences, similarity, type DiffOp } from './seqDiff';

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
}

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export type ChangeKind = 'ins' | 'del' | 'mod';

/** 合并文档中整块标记的位置（子节点下标路径） */
export interface BlockMarker {
  path: number[];
  kind: ChangeKind;
}

/** 节点特性（由 schema 提供） */
export interface SchemaInfo {
  /** 内容为行内节点的文本块 */
  isTextblock: (type: string) => boolean;
  /** 文本块允许行内标记（代码块等不允许） */
  allowsMarks: (type: string) => boolean;
}

export interface MarkdownDiffResult {
  doc: PMNode;
  blocks: BlockMarker[];
  /** 是否存在任何改动 */
  changed: boolean;
}

/** 合并文档中行内改动使用的标记类型 */
export const DIFF_MARK = 'historyDiff';

/** 单次差异的规模上限：超过后整块按替换处理，避免卡顿 */
const MAX_INLINE_UNITS = 20000;
const MAX_PAIRING_CELLS = 2500;
/** 配对阈值：相似度达到后视为同一块被修改 */
const PAIR_THRESHOLD = 0.4;

// ── 工具 ──

/** 稳定序列化（键排序），作为块与行内节点的比较键 */
export function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(obj[k])}`).join(',')}}`;
}

/** 节点纯文本（相似度判断用） */
export function plainText(node: PMNode): string {
  if (node.text !== undefined) return node.text;
  if (!node.content) return '';
  return node.content.map(plainText).join(node.type === 'paragraph' || node.type === 'heading' ? '' : '\n');
}

/**
 * 容器相似度：较短一方的行有多少出现在另一方（列表新增了很多项时，原有项仍全部保留，应视为同一个列表）
 */
function lineOverlap(a: string, b: string): number {
  const la = a.split('\n').filter((l) => l.trim() !== '');
  const lb = b.split('\n').filter((l) => l.trim() !== '');
  if (la.length === 0 || lb.length === 0) return 0;
  const [short, long] = la.length <= lb.length ? [la, lb] : [lb, la];
  const pool = new Map<string, number>();
  for (const l of long) pool.set(l, (pool.get(l) ?? 0) + 1);
  let hit = 0;
  for (const l of short) {
    const c = pool.get(l) ?? 0;
    if (c > 0) {
      hit += 1;
      pool.set(l, c - 1);
    }
  }
  return hit / short.length;
}

function sameAttrs(a: PMNode, b: PMNode): boolean {
  return stableKey(a.attrs ?? {}) === stableKey(b.attrs ?? {});
}

function withDiffMark(node: PMNode, kind: 'ins' | 'del'): PMNode {
  return { ...node, marks: [...(node.marks ?? []), { type: DIFF_MARK, attrs: { kind } }] };
}

// ── 行内差异 ──

interface InlineUnit {
  key: string;
  /** 文本单位的文字；行内节点为 undefined */
  text?: string;
  marks?: PMMark[];
  node?: PMNode;
}

/** 中日韩文字与全角符号：逐字比较 */
const CJK = '\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u3000-\u303f\uff00-\uffef';
/** 文本切分：中日韩文字单字、其余字母数字成词（不吞并相邻汉字）、空白成段、其余单字符 */
const TOKEN_RE = new RegExp(`[${CJK}]|(?:(?![${CJK}])[\\p{L}\\p{N}_])+|\\s+|.`, 'gsu');

function inlineUnits(content: PMNode[] | undefined): InlineUnit[] {
  const units: InlineUnit[] = [];
  for (const node of content ?? []) {
    if (node.type === 'text' && node.text !== undefined) {
      const marksKey = node.marks?.length ? stableKey(node.marks) : '';
      for (const token of node.text.match(TOKEN_RE) ?? []) {
        units.push({ key: `t${marksKey}\u0000${token}`, text: token, marks: node.marks });
      }
    } else {
      units.push({ key: `n${stableKey(node)}`, node });
    }
  }
  return units;
}

/** 把单位序列重新拼成行内节点（相邻且标记相同的文本合并） */
function buildInline(parts: Array<{ unit: InlineUnit; kind: 'equal' | 'ins' | 'del' }>): PMNode[] {
  const out: PMNode[] = [];
  for (const { unit, kind } of parts) {
    const extra = kind === 'equal' ? [] : [{ type: DIFF_MARK, attrs: { kind } }];
    if (unit.text !== undefined) {
      const marks = [...(unit.marks ?? []), ...extra];
      const last = out[out.length - 1];
      if (last && last.type === 'text' && stableKey(last.marks ?? []) === stableKey(marks)) {
        last.text = (last.text ?? '') + unit.text;
      } else {
        out.push(marks.length ? { type: 'text', text: unit.text, marks } : { type: 'text', text: unit.text });
      }
    } else if (unit.node) {
      out.push(kind === 'equal' ? unit.node : withDiffMark(unit.node, kind));
    }
  }
  return out;
}

/** 文本块行内差异；规模过大返回 null */
function diffInline(a: PMNode, b: PMNode): { content: PMNode[]; changed: boolean } | null {
  const ua = inlineUnits(a.content);
  const ub = inlineUnits(b.content);
  if (ua.length + ub.length > MAX_INLINE_UNITS) return null;
  const ops = diffSequences(ua.map((u) => u.key), ub.map((u) => u.key));
  if (!ops) return null;
  let changed = false;
  const parts = ops.map((op) => {
    if (op.type === 'equal') return { unit: ub[op.b!], kind: 'equal' as const };
    changed = true;
    return op.type === 'del' ? { unit: ua[op.a!], kind: 'del' as const } : { unit: ub[op.b!], kind: 'ins' as const };
  });
  return { content: buildInline(parts), changed };
}

// ── 块级差异 ──

class Builder {
  blocks: BlockMarker[] = [];
  changed = false;
  constructor(private schema: SchemaInfo) {}

  mark(path: number[], kind: ChangeKind) {
    this.blocks.push({ path, kind });
    this.changed = true;
  }

  /** 比较两组同级块，返回合并后的子节点列表 */
  diffChildren(as: PMNode[], bs: PMNode[], path: number[]): PMNode[] {
    const keyA = as.map(stableKey);
    const keyB = bs.map(stableKey);
    const ops = diffSequences(keyA, keyB) ?? this.replaceAll(as.length, bs.length);
    const out: PMNode[] = [];
    let i = 0;
    while (i < ops.length) {
      const op = ops[i];
      if (op.type === 'equal') {
        out.push(bs[op.b!]);
        i += 1;
        continue;
      }
      // 收集一个连续改动区间：删除在前、新增在后
      const dels: number[] = [];
      const inss: number[] = [];
      while (i < ops.length && ops[i].type !== 'equal') {
        if (ops[i].type === 'del') dels.push(ops[i].a!);
        else inss.push(ops[i].b!);
        i += 1;
      }
      this.emitRegion(as, bs, dels, inss, path, out);
    }
    return out;
  }

  private replaceAll(n: number, m: number): DiffOp[] {
    const ops: DiffOp[] = [];
    for (let a = 0; a < n; a++) ops.push({ type: 'del', a });
    for (let b = 0; b < m; b++) ops.push({ type: 'ins', b });
    return ops;
  }

  /** 改动区间：按顺序配对相近的块，未配对的块整块删除 / 新增 */
  private emitRegion(as: PMNode[], bs: PMNode[], dels: number[], inss: number[], path: number[], out: PMNode[]) {
    const pairs = this.pairBlocks(dels.map((x) => as[x]), inss.map((x) => bs[x]));
    let di = 0;
    let ii = 0;
    const pushDel = (node: PMNode) => {
      this.mark([...path, out.length], 'del');
      out.push(node);
    };
    const pushIns = (node: PMNode) => {
      this.mark([...path, out.length], 'ins');
      out.push(node);
    };
    for (const [pd, pi] of pairs) {
      // 配对点之前的未配对块：先删后增
      while (di < pd) pushDel(as[dels[di++]]);
      while (ii < pi) pushIns(bs[inss[ii++]]);
      this.emitPair(as[dels[di++]], bs[inss[ii++]], path, out);
    }
    while (di < dels.length) pushDel(as[dels[di++]]);
    while (ii < inss.length) pushIns(bs[inss[ii++]]);
  }

  /** 保序加权配对（动态规划，规模过大时不配对） */
  private pairBlocks(as: PMNode[], bs: PMNode[]): Array<[number, number]> {
    if (as.length === 0 || bs.length === 0 || as.length * bs.length > MAX_PAIRING_CELLS) return [];
    // 一对一替换且类型相同：视为同一块被修改（短文本相似度不可靠，如单字单元格）
    if (as.length === 1 && bs.length === 1 && as[0].type === bs[0].type && (as[0].content || bs[0].content)) return [[0, 0]];
    const n = as.length;
    const m = bs.length;
    const textA = as.map(plainText);
    const textB = bs.map(plainText);
    const score = (x: number, y: number) => {
      if (as[x].type !== bs[y].type) return 0;
      // 非文本块（图片、分割线等）内容不同就是替换，不配对
      if (!this.schema.isTextblock(as[x].type) && !as[x].content && !bs[y].content) return 0;
      // 空文本的同类容器（如只含图片的段落）按属性是否相同决定
      if (textA[x] === '' && textB[y] === '') return sameAttrs(as[x], bs[y]) ? 0.5 : 0.41;
      const s = Math.max(similarity(textA[x], textB[y]), this.isContainer(as[x]) ? lineOverlap(textA[x], textB[y]) : 0);
      return s >= PAIR_THRESHOLD ? s : 0;
    };
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let x = n - 1; x >= 0; x--) {
      for (let y = m - 1; y >= 0; y--) {
        const s = score(x, y);
        dp[x][y] = Math.max(dp[x + 1][y], dp[x][y + 1], s > 0 ? s + dp[x + 1][y + 1] : 0);
      }
    }
    const pairs: Array<[number, number]> = [];
    let x = 0;
    let y = 0;
    while (x < n && y < m) {
      const s = score(x, y);
      if (s > 0 && dp[x][y] === s + dp[x + 1][y + 1]) {
        pairs.push([x, y]);
        x += 1;
        y += 1;
      } else if (dp[x + 1][y] >= dp[x][y + 1]) {
        x += 1;
      } else {
        y += 1;
      }
    }
    return pairs;
  }

  /** 已配对的两个同类块 */
  private emitPair(a: PMNode, b: PMNode, path: number[], out: PMNode[]) {
    const index = out.length;
    const here = [...path, index];
    const { isTextblock, allowsMarks } = this.schema;
    if (isTextblock(b.type)) {
      if (allowsMarks(b.type)) {
        const inline = diffInline(a, b);
        if (inline) {
          out.push({ ...b, content: inline.content });
          if (inline.changed) this.changed = true;
          if (!sameAttrs(a, b)) this.mark(here, 'mod');
          return;
        }
      } else if (plainText(a) === plainText(b)) {
        // 代码块等：仅属性（语言）变化
        out.push(b);
        this.mark(here, 'mod');
        return;
      }
      this.mark(here, 'del');
      out.push(a);
      this.mark([...path, out.length], 'ins');
      out.push(b);
      return;
    }
    // 表格行：单元格数一致时逐格对应比较，不增删单元格（保持表格结构）
    if (b.type === 'tableRow' && a.content && b.content && a.content.length === b.content.length) {
      const merged: PMNode = { ...b, content: [] };
      out.push(merged);
      merged.content = b.content.map((cell, ci) => {
        const old = a.content![ci];
        if (stableKey(old) === stableKey(cell)) return cell;
        if (!sameAttrs(old, cell)) this.mark([...here, ci], 'mod');
        return { ...cell, content: this.diffChildren(old.content ?? [], cell.content ?? [], [...here, ci]) };
      });
      return;
    }
    if (b.content && a.content && this.compatibleContainers(a, b)) {
      const merged: PMNode = { ...b, content: [] };
      out.push(merged);
      if (!sameAttrs(a, b)) this.mark(here, 'mod');
      merged.content = this.diffChildren(a.content, b.content, here);
      return;
    }
    this.mark(here, 'del');
    out.push(a);
    this.mark([...path, out.length], 'ins');
    out.push(b);
  }

  /** 容器（列表、引用、表格等）：非文本块且有子节点 */
  private isContainer(node: PMNode): boolean {
    return !this.schema.isTextblock(node.type) && Array.isArray(node.content);
  }

  /** 容器能否逐项比较：表格须列数一致，表格行须单元格数一致 */
  private compatibleContainers(a: PMNode, b: PMNode): boolean {
    if (b.type === 'table') {
      const cols = (t: PMNode) => t.content?.[0]?.content?.length ?? 0;
      return cols(a) === cols(b);
    }
    if (b.type === 'tableRow') return (a.content?.length ?? 0) === (b.content?.length ?? 0);
    return true;
  }
}

/** 比较两版文档；base 为空时视为全部新增 */
export function diffMarkdownDocs(base: PMNode | null, target: PMNode, schema: SchemaInfo): MarkdownDiffResult {
  if (!base) return { doc: target, blocks: [], changed: false };
  const builder = new Builder(schema);
  const content = builder.diffChildren(base.content ?? [], target.content ?? [], []);
  return { doc: { ...target, content }, blocks: builder.blocks, changed: builder.changed };
}
