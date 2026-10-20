// NoteBoard 纯文本内嵌 JSON 高亮
// txt / log 等纯文本无语法树：识别文中合法 JSON 块（如格式化后的 JSON），
// 按与 .json 文件相同的 tag → 颜色映射（highlightStyle.ts）为键/值上色

import { highlightingFor } from '@codemirror/language';
import { StateEffect, type EditorState, type Extension, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { tags as t, type Tag } from '@lezer/highlight';

// ── 规模与性能上限 ──

/** 超过该长度的文档不做识别（避免大日志卡顿） */
const MAX_DOC_LENGTH = 2_000_000;
/** 全文扫描的字符预算（防止大量未闭合括号导致反复长扫描） */
const SCAN_BUDGET = 8_000_000;
/** 不超过该长度的文档在编辑时同步重算，更大的走防抖 */
const SYNC_LIMIT = 200_000;
const DEBOUNCE_MS = 300;

// ── JSON 块识别（纯函数） ──

export interface JsonBlock {
  from: number;
  to: number;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r';
}

/** JSON 字符串外允许出现的字符（空白、数字、字面量字母、标点） */
const OUTSIDE_STRING_CHARS = new Set(' \t\r\n0123456789+-.eEtrufalsn,:');

/**
 * 从 start 处的开括号向后匹配对应闭括号。
 * 字符串外出现非 JSON 字符、字符串内出现换行、括号错配时立即失败，保证普通文本快速放弃。
 */
function matchBracket(text: string, start: number, limit: number): { end: number; scanned: number } {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  const max = Math.min(text.length, start + limit);
  for (let i = start; i < max; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      // JSON 字符串不允许裸换行
      else if (ch === '\n') return { end: -1, scanned: i - start };
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return { end: -1, scanned: i - start };
      if (stack.length === 0) return { end: i, scanned: i - start };
    } else if (!OUTSIDE_STRING_CHARS.has(ch)) {
      return { end: -1, scanned: i - start };
    }
  }
  return { end: -1, scanned: max - start };
}

/** 行内候选起点：行首非空白字符为开括号，或行尾非空白字符为开括号（如 `payload={`） */
function findCandidateStart(text: string, lineStart: number, lineEnd: number): number {
  let first = lineStart;
  while (first < lineEnd && isSpace(text[first])) first++;
  if (first >= lineEnd) return -1;
  if (text[first] === '{' || text[first] === '[') return first;
  let last = lineEnd - 1;
  while (last > first && isSpace(text[last])) last--;
  if (text[last] === '{' || text[last] === '[') return last;
  return -1;
}

/** 扫描全文，返回所有可被 JSON.parse 解析的对象/数组块区间 */
export function findJsonBlocks(text: string): JsonBlock[] {
  const blocks: JsonBlock[] = [];
  if (text.length > MAX_DOC_LENGTH) return blocks;
  let budget = SCAN_BUDGET;
  let lineStart = 0;

  while (lineStart < text.length && budget > 0) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;

    const start = findCandidateStart(text, lineStart, lineEnd);
    if (start >= 0) {
      const { end, scanned } = matchBracket(text, start, budget);
      budget -= scanned + 1;
      if (end >= 0) {
        const blockText = text.slice(start, end + 1);
        const multiline = blockText.includes('\n');
        // 单行块要求闭括号后到行尾只剩空白，避免把 `[1] 见上文` 之类正文误判为 JSON
        let tailOk = true;
        if (!multiline) {
          for (let i = end + 1; i < lineEnd; i++) {
            if (!isSpace(text[i])) {
              tailOk = false;
              break;
            }
          }
        }
        if (tailOk && isValidJson(blockText)) {
          blocks.push({ from: start, to: end + 1 });
          // 从块结束所在行的下一行继续扫描
          const next = text.indexOf('\n', end + 1);
          lineStart = next < 0 ? text.length : next + 1;
          continue;
        }
      }
    }
    lineStart = lineEnd + 1;
  }
  return blocks;
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ── JSON 词法切分（纯函数） ──

export type JsonTokenType =
  | 'property'
  | 'string'
  | 'number'
  | 'bool'
  | 'null'
  | 'separator'
  | 'brace'
  | 'bracket';

export interface JsonToken {
  from: number;
  to: number;
  type: JsonTokenType;
}

const NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * 对 [from, to) 切分 JSON 词法单元。
 * from 必须位于字符串之外（块起点或块内行首——JSON 字符串不含裸换行，行首必在字符串外）；
 * blockEnd 用于判断字符串后是否紧跟冒号（键名），可越过 to 向后看。
 */
export function tokenizeJson(text: string, from: number, to: number, blockEnd: number): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = from;
  while (i < to) {
    const ch = text[i];
    if (ch === '"') {
      // 找字符串结尾（处理转义）
      let j = i + 1;
      while (j < blockEnd && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const end = Math.min(j + 1, blockEnd);
      // 字符串后首个非空白字符为冒号即为键名
      let k = end;
      while (k < blockEnd && /\s/.test(text[k])) k++;
      tokens.push({ from: i, to: end, type: text[k] === ':' ? 'property' : 'string' });
      i = end;
    } else if (ch === '{' || ch === '}') {
      tokens.push({ from: i, to: i + 1, type: 'brace' });
      i++;
    } else if (ch === '[' || ch === ']') {
      tokens.push({ from: i, to: i + 1, type: 'bracket' });
      i++;
    } else if (ch === ',' || ch === ':') {
      tokens.push({ from: i, to: i + 1, type: 'separator' });
      i++;
    } else if (text.startsWith('true', i) || text.startsWith('false', i)) {
      const len = ch === 't' ? 4 : 5;
      tokens.push({ from: i, to: i + len, type: 'bool' });
      i += len;
    } else if (text.startsWith('null', i)) {
      tokens.push({ from: i, to: i + 4, type: 'null' });
      i += 4;
    } else {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(text);
      if (m) {
        tokens.push({ from: i, to: i + m[0].length, type: 'number' });
        i += m[0].length;
      } else {
        i++;
      }
    }
  }
  return tokens;
}

// ── 装饰构建 ──

/** 词法类型 → @lezer/highlight tag（与 @codemirror/lang-json 的 styleTags 一致） */
const TOKEN_TAGS: Record<JsonTokenType, Tag> = {
  property: t.propertyName,
  string: t.string,
  number: t.number,
  bool: t.bool,
  null: t.null,
  separator: t.separator,
  brace: t.brace,
  bracket: t.squareBracket,
};

function buildMarks(state: EditorState): Partial<Record<JsonTokenType, Decoration>> {
  const marks: Partial<Record<JsonTokenType, Decoration>> = {};
  for (const type of Object.keys(TOKEN_TAGS) as JsonTokenType[]) {
    // 复用编辑器当前高亮样式生成的类名，保证与 .json 文件配色一致
    const cls = highlightingFor(state, [TOKEN_TAGS[type]]);
    if (cls) marks[type] = Decoration.mark({ class: cls });
  }
  return marks;
}

/** 仅为视口内的 JSON 块片段生成装饰 */
function buildDecorations(view: EditorView, blocks: JsonBlock[]): DecorationSet {
  if (blocks.length === 0) return Decoration.none;
  const { state } = view;
  const marks = buildMarks(state);
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  const { from: vpFrom, to: vpTo } = view.viewport;

  for (const block of blocks) {
    if (block.to <= vpFrom) continue;
    if (block.from >= vpTo) break;
    // 视口起点落在块内时从该行行首切分（行首必在字符串外）
    const from = Math.max(block.from, doc.lineAt(Math.max(block.from, vpFrom)).from);
    const to = Math.min(block.to, doc.lineAt(Math.min(block.to, vpTo)).to);
    // 切分时需向后看到块尾以判断键名，按块读取文本（偏移相对块起点）
    const text = doc.sliceString(block.from, block.to);
    for (const token of tokenizeJson(text, from - block.from, to - block.from, text.length)) {
      const mark = marks[token.type];
      if (mark) builder.add(block.from + token.from, block.from + token.to, mark);
    }
  }
  return builder.finish();
}

// ── 视图插件 ──

/** 防抖重算完成后通知插件刷新 */
const refreshEffect = StateEffect.define<null>();

class PlainJsonHighlighter {
  blocks: JsonBlock[];
  decorations: DecorationSet;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(view: EditorView) {
    this.blocks = findJsonBlocks(view.state.doc.toString());
    this.decorations = buildDecorations(view, this.blocks);
  }

  update(update: ViewUpdate) {
    const refreshed = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect)));
    if (update.docChanged) {
      if (update.state.doc.length <= SYNC_LIMIT) {
        this.blocks = findJsonBlocks(update.state.doc.toString());
        this.decorations = buildDecorations(update.view, this.blocks);
      } else {
        // 大文档：先映射旧装饰保持位置，再防抖重算
        this.decorations = this.decorations.map(update.changes);
        this.blocks = this.blocks
          .map((b) => ({ from: update.changes.mapPos(b.from, 1), to: update.changes.mapPos(b.to, -1) }))
          .filter((b) => b.to > b.from);
        this.schedule(update.view);
      }
      return;
    }
    if (refreshed) {
      this.blocks = findJsonBlocks(update.state.doc.toString());
      this.decorations = buildDecorations(update.view, this.blocks);
    } else if (update.viewportChanged || update.transactions.some((tr) => tr.reconfigured)) {
      // 滚动或主题重配后按当前视口重建
      this.decorations = buildDecorations(update.view, this.blocks);
    }
  }

  private schedule(view: EditorView) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      view.dispatch({ effects: refreshEffect.of(null) });
    }, DEBOUNCE_MS);
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
  }
}

/** 纯文本内嵌 JSON 高亮扩展 */
export function plainJsonHighlight(): Extension {
  return ViewPlugin.fromClass(PlainJsonHighlighter, {
    decorations: (v) => v.decorations,
  });
}
