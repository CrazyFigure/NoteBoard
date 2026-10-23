// NoteBoard 原始 HTML 轻量标签扫描
// 块级 HTML 的配对判断与"被空行拆开的 HTML 块"合并共用：只维护标签栈，不构建 DOM。
// 注释、DOCTYPE 与原始文本元素（<style>/<script> 等）的内容整体跳过，其中的 `<`（如 `a<b`）不会被误判为标签。

// 无结束标签的空元素
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// 可省略结束标签的元素：未闭合不视为片段
const OPTIONAL_END_TAGS = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'option', 'rt', 'rp', 'colgroup']);
// 原始文本元素：内容不按标签解析，直接寻找对应的结束标签
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);
// 从当前位置匹配一个开始/结束标签；属性值可含 `>`，需按引号匹配
const TAG_AT_PATTERN = /<(\/?)([a-zA-Z][\w-]*)(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*(\/?)>/y;
// 原始文本元素结束标签的匹配正则（按标签名缓存）
const rawTextClosePatterns = new Map<string, RegExp>();

// 失败时 index 为已扫描到的最远位置（用于累计扫描量）
type ScanResult = { ok: boolean; index: number };

/** 扫描状态：标签栈及其中必须闭合的元素数、<pre> 数（增量维护，判断时无需遍历整个栈） */
interface ScanState {
  stack: string[];
  required: number;
  pre: number;
}

function createScanState(): ScanState {
  return { stack: [], required: 0, pre: 0 };
}

/** 栈中剩余的元素是否都可省略结束标签（即标签已配对） */
function isClosed(state: ScanState): boolean {
  return state.required === 0;
}

/** 出栈到 position（不含），同步计数 */
function popTo(state: ScanState, position: number): void {
  for (let index = state.stack.length - 1; index >= position; index -= 1) {
    const tag = state.stack[index];
    if (!OPTIONAL_END_TAGS.has(tag)) state.required -= 1;
    if (tag === 'pre') state.pre -= 1;
  }
  state.stack.length = position;
}

/** 原始文本元素的结束位置，未闭合返回 -1 */
function findRawTextEnd(source: string, name: string, from: number): number {
  let pattern = rawTextClosePatterns.get(name);
  if (!pattern) {
    pattern = new RegExp(`</${name}\\s*>`, 'gi');
    rawTextClosePatterns.set(name, pattern);
  }
  pattern.lastIndex = from;
  const match = pattern.exec(source);
  return match ? match.index + match[0].length : -1;
}

/**
 * 扫描 [from, to) 内的标签并维护标签栈。
 * 注释与原始文本元素可能越过 to，返回值 index 为实际扫描到的位置；
 * 遇到孤立/交叉的结束标签，或注释、原始文本元素直到文末都未闭合时返回失败。
 */
function scanTags(source: string, state: ScanState, from: number, to: number): ScanResult {
  const { stack } = state;
  let index = from;
  for (;;) {
    const lt = source.indexOf('<', index);
    if (lt < 0 || lt >= to) return { ok: true, index: Math.max(index, to) };
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      if (close < 0) return { ok: false, index: source.length };
      index = close + 3;
      continue;
    }
    // DOCTYPE、CDATA 与处理指令：跳到第一个 `>`
    if (source[lt + 1] === '!' || source[lt + 1] === '?') {
      const close = source.indexOf('>', lt + 2);
      if (close < 0) return { ok: false, index: source.length };
      index = close + 1;
      continue;
    }
    TAG_AT_PATTERN.lastIndex = lt;
    const match = TAG_AT_PATTERN.exec(source);
    // 不构成标签的 `<` 按文本处理
    if (!match) {
      index = lt + 1;
      continue;
    }
    index = TAG_AT_PATTERN.lastIndex;
    const name = match[2].toLowerCase();
    if (match[1] === '/') {
      // 结束标签：越过中间可省略结束标签的元素寻找匹配项，找不到即为孤立的结束标签
      const position = stack.lastIndexOf(name);
      if (position < 0) return { ok: false, index };
      for (let cursor = position + 1; cursor < stack.length; cursor += 1) {
        if (!OPTIONAL_END_TAGS.has(stack[cursor])) return { ok: false, index };
      }
      popTo(state, position);
      continue;
    }
    // 空元素、自闭合写法不参与配对
    if (VOID_TAGS.has(name) || match[3] === '/') continue;
    if (RAW_TEXT_TAGS.has(name)) {
      const end = findRawTextEnd(source, name, index);
      if (end < 0) return { ok: false, index: source.length };
      index = end;
      continue;
    }
    stack.push(name);
    if (!OPTIONAL_END_TAGS.has(name)) state.required += 1;
    if (name === 'pre') state.pre += 1;
  }
}

/** 判断 HTML 片段的标签是否配对（允许省略可选结束标签） */
export function isBalancedHtml(raw: string): boolean {
  const state = createScanState();
  const result = scanTags(raw, state, 0, raw.length);
  return result.ok && isClosed(state);
}

// ---- 被空行拆开的 HTML 块合并 ----
// CommonMark 规定块级 HTML（<div>、<table> 等）遇到空行即结束，排版过的复杂 HTML 中间只要有空行就会被拆成几块，
// 拆开的片段标签不配对，只能按源码展示。这里在块起点向后扫描：后续每一块都以标签开头（纯 HTML）且最终配对时，
// 合并为一个块级 HTML；中间夹有 Markdown（README 常见的 `<div align="center">` + 空行 + Markdown 写法）时不合并。

// 快速排除：块首（最多 3 个空格缩进）必须是标签或 DOCTYPE
const QUICK_START_PATTERN = /^ {0,3}<[a-zA-Z/!]/;
const DOCTYPE_START_PATTERN = /^ {0,3}<!doctype\b/i;
// CommonMark 第 1 类 HTML 块：以对应结束标签结束而非空行，marked 已能整体识别
const RAW_BLOCK_START_PATTERN = /^ {0,3}<(?:pre|script|style|textarea)(?:[\s>]|$)/i;
// CommonMark 第 6 类 HTML 块的标签名
const BLOCK_TAG_START_PATTERN = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$)/i;
// CommonMark 第 7 类 HTML 块：首行只有一个完整的开始或结束标签
const SINGLE_TAG_LINE_PATTERN = /^ {0,3}(?:<[a-zA-Z][\w-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[a-zA-Z][\w-]*\s*>)[ \t]*(?:\n|$)/;
// 后续块的开头：标签或注释（`<https://…>` 自动链接等不算）
const CHUNK_TAG_START_PATTERN = /<(?:!--|\/?[a-zA-Z][\w-]*(?:[\s/>]|$))/y;
// 空行（只含空白字符的行）
const BLANK_LINE_PATTERN = /\n[ \t]*(?=\n|$)/g;
const NON_WHITESPACE_PATTERN = /\S/g;
const ELEMENT_TAG_PATTERN = /<[a-zA-Z]/;

// 单次合并的扫描上限：超出即放弃合并，按原有方式拆块
const MAX_MERGE_CHUNKS = 2000;
const MAX_MERGE_LENGTH = 4 * 1024 * 1024;
// 同一次块解析中合并尝试的累计扫描量上限（按首次调用时的剩余原文长度线性计算），
// 防止大量未闭合标签导致每个块起点都反复扫描到文末，解析耗时退化为平方级
const MERGE_SCAN_BUDGET_BASE = 64 * 1024;
const MERGE_SCAN_BUDGET_FACTOR = 2;
const mergeScanBudgets = new WeakMap<object, number>();

/** 从 from 起第一个空行的位置（该行之前换行符的下标），没有空行时为文末 */
function chunkEndFrom(source: string, from: number): number {
  BLANK_LINE_PATTERN.lastIndex = from;
  const match = BLANK_LINE_PATTERN.exec(source);
  return match ? match.index : source.length;
}

/** 块首是否会被 marked 识别为以空行结束的 HTML 块 */
function startsBlankLineEndedHtmlBlock(source: string): boolean {
  if (RAW_BLOCK_START_PATTERN.test(source)) return false;
  return BLOCK_TAG_START_PATTERN.test(source) || SINGLE_TAG_LINE_PATTERN.test(source);
}

/**
 * 匹配被空行拆开、但整体是一段完整 HTML 的块，返回合并后的原文；不满足条件返回 null（交还默认解析）。
 * @param source 当前块序列的剩余原文
 * @param budgetKey 同一次块解析共用的对象（当前 token 列表），用于累计扫描量
 */
export function matchSplitHtmlBlock(source: string, budgetKey?: object): string | null {
  if (!QUICK_START_PATTERN.test(source)) return null;
  const isDocument = DOCTYPE_START_PATTERN.test(source);
  if (!isDocument && !startsBlankLineEndedHtmlBlock(source)) return null;

  let budget = (budgetKey && mergeScanBudgets.get(budgetKey)) ?? MERGE_SCAN_BUDGET_BASE + source.length * MERGE_SCAN_BUDGET_FACTOR;
  if (budget <= 0) return null;
  const limit = Math.min(source.length, MAX_MERGE_LENGTH, budget);

  const state = createScanState();
  let position = 0;
  let chunkStart = 0;
  let awaitingDocument = isDocument;
  let chunkEnd = chunkEndFrom(source, 0);
  let chunks = 0;
  let result: string | null = null;
  let scanned = 0;
  let crossedBlankLine = false;
  for (;;) {
    const scan = scanTags(source, state, position, chunkEnd);
    scanned = Math.max(scanned, scan.index, chunkEnd);
    if (!scan.ok) break;
    // 原始文本或注释越过了空行（默认解析会在此处拆块）：从其结束处重新寻找本块的结尾
    if (scan.index > chunkEnd) {
      crossedBlankLine = true;
      position = scan.index;
      chunkEnd = chunkEndFrom(source, position);
      continue;
    }
    chunks += 1;
    // DOCTYPE 独占一块（其后空行再接 <html>）时尚未出现任何元素，需继续向后合并
    if (awaitingDocument && ELEMENT_TAG_PATTERN.test(source.slice(chunkStart, chunkEnd))) awaitingDocument = false;
    if (isClosed(state) && !awaitingDocument) {
      // 首块已配对时与默认解析结果一致，无需接管；DOCTYPE 开头的整页文档仍需与后续 <html> 合为一块
      if (chunks > 1 || crossedBlankLine || isDocument) result = source.slice(0, chunkEnd);
      break;
    }
    if (chunkEnd >= limit || chunks >= MAX_MERGE_CHUNKS) break;
    NON_WHITESPACE_PATTERN.lastIndex = chunkEnd;
    const next = NON_WHITESPACE_PATTERN.exec(source)?.index ?? -1;
    if (next < 0 || next >= limit) break;
    // 下一块不以标签开头说明夹有 Markdown，放弃合并；<pre> 内的文本行不受限制
    CHUNK_TAG_START_PATTERN.lastIndex = next;
    if (state.pre === 0 && !CHUNK_TAG_START_PATTERN.test(source)) break;
    position = chunkEnd;
    chunkStart = next;
    chunkEnd = chunkEndFrom(source, next);
  }

  if (budgetKey) {
    budget -= scanned;
    mergeScanBudgets.set(budgetKey, budget);
  }
  return result;
}
