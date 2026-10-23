// NoteBoard 文档历史记录：通用序列差异（Myers O((N+M)D)）
// 输入两组可比较的键（字符串），输出逐项的 相同 / 删除 / 新增 操作，供各格式差异复用。
// 先剥离公共前后缀再求差异；编辑距离超过上限时返回 null，由调用方整体按替换处理。

export type DiffOpType = 'equal' | 'del' | 'ins';

export interface DiffOp {
  type: DiffOpType;
  /** 旧序列下标（equal / del） */
  a?: number;
  /** 新序列下标（equal / ins） */
  b?: number;
}

/** 默认编辑距离上限：回溯快照内存约为 D² 个整数 */
export const DEFAULT_MAX_EDITS = 2000;

/** 最长公共子序列匹配对（升序）；超过上限返回 null */
function myersPairs(a: readonly string[], b: readonly string[], maxD: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d]：第 d 步开始前 v 在 k ∈ [-d-1, d+1] 的快照
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxD) return null;
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const idx = k + offset;
      let x = k === -d || (k !== d && v[idx - 1] < v[idx + 1]) ? v[idx + 1] : v[idx - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[idx] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snap = trace[d];
    const get = (k: number) => snap[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      pairs.push([x, y]);
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  pairs.reverse();
  return pairs;
}

/** 由匹配对生成操作序列：每个改动区间内先删除后新增 */
function pairsToOps(n: number, m: number, pairs: Array<[number, number]>): DiffOp[] {
  const ops: DiffOp[] = [];
  let pa = 0;
  let pb = 0;
  const flush = (ea: number, eb: number) => {
    for (let i = pa; i < ea; i++) ops.push({ type: 'del', a: i });
    for (let j = pb; j < eb; j++) ops.push({ type: 'ins', b: j });
  };
  for (const [ai, bi] of pairs) {
    flush(ai, bi);
    ops.push({ type: 'equal', a: ai, b: bi });
    pa = ai + 1;
    pb = bi + 1;
  }
  flush(n, m);
  return ops;
}

/** 比较两组键；编辑距离超过上限返回 null */
export function diffSequences(a: readonly string[], b: readonly string[], maxEdits = DEFAULT_MAX_EDITS): DiffOp[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const mid = myersPairs(midA, midB, maxEdits);
  if (!mid) return null;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < pre; i++) pairs.push([i, i]);
  for (const [x, y] of mid) pairs.push([x + pre, y + pre]);
  for (let i = 0; i < suf; i++) pairs.push([a.length - suf + i, b.length - suf + i]);
  return pairsToOps(a.length, b.length, pairs);
}

/** 两段文本按字符的相似度（0~1，基于字符二元组的 Dice 系数，用于配对改动块） */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a.length === 0 && b.length === 0 ? 1 : (a && b && (a.includes(b) || b.includes(a)) ? 0.5 : 0);
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = grams.get(g) ?? 0;
    if (c > 0) {
      hit += 1;
      grams.set(g, c - 1);
    }
  }
  return (2 * hit) / (a.length - 1 + b.length - 1);
}
