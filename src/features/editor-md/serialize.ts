// NoteBoard Markdown 序列化
// @tiptap/markdown 入/出 + 基线管理（不变式 I-13/I-14）
// 详见 docs/09-开发路线图.md 7.5
//
// 不变式 I-13: 打开文件后，序列化的结果必须等于磁盘原文（否则"什么都没做就变脏"）
// 不变式 I-14: 打开 → 切 visual → 切 source → tab 不出现脏圆点

import type { Editor, JSONContent, MarkdownToken } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { textWouldFormInlineMath } from './mathSyntax';
import { beginRawSegmentSession, emitRawSegment, endRawSegmentSession, restoreRawSegments } from './rawMarkdownSegments';
import { formatWikiLinkMarkdown } from '../wikilink/wikiLinkSyntax';
import { INVISIBLE_CHARACTER_ENTITIES, isDecodableEntitySuffix, usesInvisibleCharacterEntities } from './markdownHtmlEntities';
import { captureMarkdownBlockTokens } from './markdownBlockStart';
import { preserveSourceBlockSpacing } from './markdownBlockSpacing';
import { buildPreservedSerializationJson, buildSourceBlocks, recordTopLevelTokens, SOURCE_ORPHAN_AFTER_ATTR, SOURCE_ORPHAN_ATTR, SOURCE_RAW_ATTR, type PreservableNode } from './markdownSourcePreserve';

// CommonMark 允许反斜杠转义的 ASCII 标点；这些字符前的双反斜杠不能擅自折叠，
// 否则原本可见的反斜杠会在下一次解析时被当成转义符吞掉。
const COMMONMARK_ESCAPABLE_PUNCTUATION = new Set(
  [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'],
);
// Unicode 标点与符号类别，按 CommonMark §6.2 判定强调/删除线定界符的左右侧翼条件。
const UNICODE_PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/u;

// `&` 之后若紧跟会被解码的实体（如 `gt;`、`#39;`），该 `&` 必须保持编码（判断见 isDecodableEntitySuffix）

// ── 按上下文精确转义（结构性必要转义 + 候选行内转义） ──
// 不再对普通文本中的所有 `` ` ``、`_`、`*`、`[`、`]`、`~` 无条件加反斜杠：
// 1. 仅在特定行首/表格/公式等位置会改变文档结构的字面量插入结构哨兵，清理阶段永不移除；
// 2. 仅在文本块内确实可能配对成强调、删除线、行内代码或链接/双链/脚注的符号前插入行内哨兵，
//    表名中的 `recipe_region`、孤立的 `` ` `` / `*` / `~` / `[text]` 等从源头原样输出，
//    不会因为文档别处存在必要转义而被整篇连坐残留 `\_` 或 `` \` ``。
const STRUCTURAL_ESCAPE_SENTINEL = '';
const STRUCTURAL_ESCAPE_MARK = '';
// 避开 rawMarkdownSegments 占用的 \uE002 / \uE003
const INLINE_ESCAPE_SENTINEL = '\uE004';

// 行首会被识别为块结构的字面量：ATX 标题、无序列表、有序列表、分隔线/Setext 下划线、代码围栏、引用定义
const LINE_START_HEADING = /^([ \t]{0,3})(#{1,6})(?=[ \t]|$)/;
const LINE_START_BULLET = /^([ \t]{0,3})([-+*])(?=[ \t]|$)/;
const LINE_START_ORDERED = /^([ \t]{0,3}\d{1,9})([.)])(?=[ \t]|$)/;
const LINE_START_RULE = /^([ \t]{0,3})(?:([-=])(?=[-= \t]*$)|(\*)(?=[* \t]*\*[ \t]*\*[* \t]*$)|(_)(?=[_ \t]*_[ \t]*_[_ \t]*$))/;
const LINE_START_FENCE = /^([ \t]{0,3})(`{3,}|~{3,})/;
const LINE_START_LINK_DEF = /^([ \t]{0,3})\[[^\]]+\]:/;

// 行内 HTML 标签 / 注释 / 自动链接检测，供 `&lt;` 精确还原使用（仅在真的会触发 HTML 或自动链接时保留 `&lt;`）
const HTML_TAG_AFTER_LT = /^(?:!--|\?[a-zA-Z]|![a-zA-Z[]|\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>)/;
const AUTOLINK_AFTER_LT = /^(?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*>|[^\s<>]+@[^\s<>]+>)/;

interface SerializableJsonNode {
  type?: string;
  text?: string;
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
  content?: SerializableJsonNode[];
  [key: string]: unknown;
}

type EscapeKind = 'inline' | 'structural' | 'entityLeftBracket';

const ESCAPE_PRIORITY: Record<EscapeKind, number> = {
  inline: 1,
  structural: 2,
  entityLeftBracket: 3,
};

/** 写入指定位置的转义类型，保留优先级更高的保护方式（如行首 `&#91;` 优先于 `\[`）。 */
function recordEscape(map: Map<number, EscapeKind>, index: number, kind: EscapeKind): void {
  const previous = map.get(index);
  if (!previous || ESCAPE_PRIORITY[kind] > ESCAPE_PRIORITY[previous]) {
    map.set(index, kind);
  }
}

/** CommonMark 空白判定：行首/行尾（undefined）视作空白。 */
function isCommonMarkSpace(character: string | undefined): boolean {
  return !character || /\s/.test(character);
}

/** CommonMark 标点/符号判定（Unicode P/S 类别）。 */
function isCommonMarkPunctuation(character: string | undefined): boolean {
  return !!character && UNICODE_PUNCTUATION_OR_SYMBOL.test(character);
}

/** 判断文档是否存在链接引用定义（存在时普通 `[标签]` 可能被解析为引用式链接）。 */
function hasLinkReferenceDefinitions(doc: SerializableJsonNode): boolean {
  const attrs = doc.attrs;
  if (typeof attrs?.[SOURCE_ORPHAN_AFTER_ATTR] === 'string' && attrs[SOURCE_ORPHAN_AFTER_ATTR]) return true;
  const sourceBlocks = attrs?.sourceBlocks as { entries?: Array<{ defsEffective?: boolean }>; tailDefsEffective?: boolean } | null | undefined;
  if (sourceBlocks?.tailDefsEffective) return true;
  if (sourceBlocks?.entries?.some((entry) => entry.defsEffective)) return true;
  return (doc.content ?? []).some((child) => {
    const childAttrs = child.attrs;
    return typeof childAttrs?.[SOURCE_ORPHAN_ATTR] === 'string' && Boolean(childAttrs[SOURCE_ORPHAN_ATTR]);
  });
}

interface TextSegmentInfo {
  childIndex: number;
  text: string;
  hasMarks: boolean;
  isCode: boolean;
  inLink: boolean;
  inEmStrong: boolean;
  inStrike: boolean;
  /** 序列化后该文本节点前/后是否直接紧邻标记语法或原子节点（用于边界侧翼判定） */
  prevBoundary: string | undefined;
  nextBoundary: string | undefined;
}

interface DelimiterRun {
  childIndex: number;
  start: number;
  length: number;
  canOpen: boolean;
  canClose: boolean;
}

/** 判断某位置左侧相邻的字符（跨出文本节点时按边界情况推断）。 */
function prevCharOf(segment: TextSegmentInfo, offset: number): string | undefined {
  return offset > 0 ? segment.text[offset - 1] : segment.prevBoundary;
}

/** 判断某位置右侧相邻的字符（跨出文本节点时按边界情况推断）。 */
function nextCharOf(segment: TextSegmentInfo, offset: number): string | undefined {
  return offset < segment.text.length ? segment.text[offset] : segment.nextBoundary;
}

/** 在文本块内按需标记参与配对的强调/删除线定界符，避免把词内下划线或孤立符号误转义。 */
function markPairedDelimiterRuns(
  runs: DelimiterRun[],
  escapesByChild: Map<number, Map<number, EscapeKind>>,
  hasActiveOuterOpen: boolean,
  hasActiveOuterClose: boolean,
): void {
  if (runs.length === 0) return;
  let firstOpener = -1;
  let lastCloser = -1;
  for (let index = 0; index < runs.length; index += 1) {
    if (firstOpener < 0 && runs[index].canOpen) firstOpener = index;
    if (runs[index].canClose) lastCloser = index;
  }
  const pairable = firstOpener >= 0 && lastCloser > firstOpener;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const participates =
      (pairable && ((run.canOpen && index < lastCloser) || (run.canClose && index > firstOpener)))
      || (hasActiveOuterOpen && run.canClose)
      || (hasActiveOuterClose && run.canOpen);
    if (!participates) continue;
    const map = escapesByChild.get(run.childIndex)!;
    for (let offset = run.start; offset < run.start + run.length; offset += 1) {
      recordEscape(map, offset, 'inline');
    }
  }
}

/** 判断某文本节点是否带有指定类型的标记。 */
function hasMarkType(node: SerializableJsonNode, markTypes: readonly string[]): boolean {
  return Array.isArray(node.marks) && node.marks.some((mark) => typeof mark.type === 'string' && markTypes.includes(mark.type));
}

/**
 * 针对单个文本块（段落或标题）做结构性与行内上下文转义分析。
 * 所有判定均为线性扫描，不引入额外解析开销，且各块相互隔离。
 */
function markTextblockEscapes(
  node: SerializableJsonNode,
  allowLineStart: boolean,
  inTableCell: boolean,
  wouldFormInlineMath: (value: string) => boolean,
  hasLinkDefs: boolean,
): SerializableJsonNode {
  const children = node.content;
  if (!children || children.length === 0) return { ...node };

  const escapesByChild = new Map<number, Map<number, EscapeKind>>();
  const lineStartBrackets = new Set<string>();
  const segments: TextSegmentInfo[] = [];

  // 记录行内代码、强调、删除线标记及双链节点位置，供跨节点上下文判定使用
  let lastCodeChildIndex = -1;
  let hasWikiLinkAtom = false;
  // 若已有强调/删除线标记的闭合符紧贴非空白后文，则可能充当后续字面定界符的左翼；反之开符紧贴非空白前文则可能充当右翼
  let hasEmStrongLeftFlankingClose = false;
  let hasEmStrongRightFlankingOpen = false;
  let hasStrikeLeftFlankingClose = false;
  let hasStrikeRightFlankingOpen = false;

  const isPlainTextChild = (child: SerializableJsonNode | undefined): child is SerializableJsonNode & { text: string } =>
    child?.type === 'text' && typeof child.text === 'string';

  for (let ci = 0; ci < children.length; ci += 1) {
    const child = children[ci];
    if (child.type === 'wikiLink') {
      hasWikiLinkAtom = true;
      continue;
    }
    if (!isPlainTextChild(child)) continue;

    const isCode = hasMarkType(child, ['code']);
    if (isCode) {
      lastCodeChildIndex = ci;
      continue;
    }

    const inEmStrong = hasMarkType(child, ['bold', 'italic']);
    const inStrike = hasMarkType(child, ['strike']);
    const inLink = hasMarkType(child, ['link']);
    const hasMarks = Array.isArray(child.marks) && child.marks.length > 0;

    // 计算节点首尾在序列化后的相邻字符：跨标记或原子节点时保守视作标点（如 `*`、`>`、`[`）
    const prevChild = children[ci - 1];
    const nextChild = children[ci + 1];
    const prevBoundary =
      !prevChild || prevChild.type === 'hardBreak'
        ? undefined
        : '*';
    const nextBoundary =
      !nextChild || nextChild.type === 'hardBreak'
        ? undefined
        : '*';

    if (inEmStrong) {
      if (isPlainTextChild(prevChild) && !hasMarkType(prevChild, ['bold', 'italic']) && !isCommonMarkSpace(prevChild.text.at(-1))) {
        hasEmStrongRightFlankingOpen = true;
      }
      if (isPlainTextChild(nextChild) && !hasMarkType(nextChild, ['bold', 'italic']) && !isCommonMarkSpace(nextChild.text[0])) {
        hasEmStrongLeftFlankingClose = true;
      }
    }
    if (inStrike) {
      if (isPlainTextChild(prevChild) && !hasMarkType(prevChild, ['strike']) && !isCommonMarkSpace(prevChild.text.at(-1))) {
        hasStrikeRightFlankingOpen = true;
      }
      if (isPlainTextChild(nextChild) && !hasMarkType(nextChild, ['strike']) && !isCommonMarkSpace(nextChild.text[0])) {
        hasStrikeLeftFlankingClose = true;
      }
    }

    escapesByChild.set(ci, new Map());
    segments.push({
      childIndex: ci,
      text: child.text,
      hasMarks,
      isCode,
      inLink,
      inEmStrong,
      inStrike,
      prevBoundary,
      nextBoundary,
    });
  }

  if (segments.length === 0) return { ...node };

  // ── 阶段 A：行首块级结构必要转义（仅普通段落生效） ──
  if (allowLineStart) {
    let atLineStart = true;
    for (let ci = 0; ci < children.length; ci += 1) {
      const child = children[ci];
      if (child.type === 'hardBreak') {
        atLineStart = true;
        continue;
      }
      if (isPlainTextChild(child)) {
        const map = escapesByChild.get(ci);
        const hasMarks = Array.isArray(child.marks) && child.marks.length > 0;
        if (map) {
          let lineOffset = 0;
          const lines = child.text.split('\n');
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
            const line = lines[lineIdx];
            const isStart = lineIdx > 0 || (atLineStart && !hasMarks);
            if (isStart) {
              const leadingBracket = /^([ \t]{0,3})\[/.exec(line);
              if (leadingBracket) {
                lineStartBrackets.add(`${ci}:${lineOffset + leadingBracket[1].length}`);
              }
              if (LINE_START_LINK_DEF.test(line)) {
                const match = LINE_START_LINK_DEF.exec(line)!;
                recordEscape(map, lineOffset + match[1].length, 'entityLeftBracket');
              } else {
                for (const pattern of [LINE_START_HEADING, LINE_START_ORDERED, LINE_START_BULLET, LINE_START_RULE, LINE_START_FENCE]) {
                  const match = pattern.exec(line);
                  if (match) {
                    recordEscape(map, lineOffset + match[1].length, 'structural');
                    break;
                  }
                }
              }
            }
            lineOffset += line.length + 1;
          }
        }
        atLineStart = false;
      } else {
        atLineStart = false;
      }
    }
  }

  // ── 阶段 B：表格管道符 `|` 与行内公式 `$` 必要转义 ──
  for (const segment of segments) {
    const map = escapesByChild.get(segment.childIndex)!;
    if (inTableCell && segment.text.includes('|')) {
      for (let idx = 0; idx < segment.text.length; idx += 1) {
        if (segment.text[idx] === '|') recordEscape(map, idx, 'structural');
      }
    }
    if (segment.text.includes('$') && wouldFormInlineMath(segment.text)) {
      for (let idx = 0; idx < segment.text.length; idx += 1) {
        if (segment.text[idx] === '$') recordEscape(map, idx, 'structural');
      }
    }
  }

  // ── 阶段 C：行内符号上下文分析（_ / * / ~ / ` / [ / ]） ──
  const underscoreRuns: DelimiterRun[] = [];
  const asteriskRuns: DelimiterRun[] = [];
  const tildeRuns1: DelimiterRun[] = [];
  const tildeRuns2: DelimiterRun[] = [];
  const backtickRuns: Array<{ childIndex: number; start: number; length: number }> = [];
  const backtickCountByLength = new Map<number, number>();

  for (const segment of segments) {
    const { text, childIndex } = segment;
    const map = escapesByChild.get(childIndex)!;
    let index = 0;
    while (index < text.length) {
      const ch = text[index];
      if (ch === '_' || ch === '*' || ch === '~') {
        let end = index + 1;
        while (end < text.length && text[end] === ch) end += 1;
        const length = end - index;
        const prev = prevCharOf(segment, index);
        const next = nextCharOf(segment, end);
        const leftFlanking = !isCommonMarkSpace(next) && (!isCommonMarkPunctuation(next) || isCommonMarkSpace(prev) || isCommonMarkPunctuation(prev));
        const rightFlanking = !isCommonMarkSpace(prev) && (!isCommonMarkPunctuation(prev) || isCommonMarkSpace(next) || isCommonMarkPunctuation(next));

        if (ch === '_') {
          // 词内下划线（如 recipe_region、表_名）既不能开也不能闭强调，直接跳过
          const canOpen = leftFlanking && (!rightFlanking || isCommonMarkPunctuation(prev));
          const canClose = rightFlanking && (!leftFlanking || isCommonMarkPunctuation(next));
          if (canOpen || canClose) {
            underscoreRuns.push({ childIndex, start: index, length, canOpen, canClose });
          }
        } else if (ch === '*') {
          if (leftFlanking || rightFlanking) {
            if (segment.inEmStrong) {
              // 处于粗体/斜体内部的侧翼星号可能提前闭合外层标记，直接标记转义
              for (let pos = index; pos < end; pos += 1) recordEscape(map, pos, 'inline');
            } else {
              asteriskRuns.push({ childIndex, start: index, length, canOpen: leftFlanking, canClose: rightFlanking });
            }
          }
        } else if (length <= 2 && (leftFlanking || rightFlanking)) {
          // GFM 删除线仅识别 1 或 2 个波浪线；连续 3 个及以上在行中不会形成删除线
          if (length === 2 && segment.inStrike) {
            for (let pos = index; pos < end; pos += 1) recordEscape(map, pos, 'inline');
          } else {
            const target = length === 1 ? tildeRuns1 : tildeRuns2;
            target.push({ childIndex, start: index, length, canOpen: leftFlanking, canClose: rightFlanking });
          }
        }
        index = end;
        continue;
      }

      if (ch === '`') {
        let end = index + 1;
        while (end < text.length && text[end] === '`') end += 1;
        const length = end - index;
        backtickRuns.push({ childIndex, start: index, length });
        backtickCountByLength.set(length, (backtickCountByLength.get(length) ?? 0) + 1);
        index = end;
        continue;
      }

      if (segment.inLink && (ch === '[' || ch === ']')) {
        // 链接文字内的方括号可能破坏 `[label](href)` 边界
        const kind: EscapeKind = ch === '[' && lineStartBrackets.has(`${childIndex}:${index}`) ? 'entityLeftBracket' : 'inline';
        recordEscape(map, index, kind);
      }

      index += 1;
    }
  }

  markPairedDelimiterRuns(underscoreRuns, escapesByChild, false, false);
  markPairedDelimiterRuns(asteriskRuns, escapesByChild, hasEmStrongLeftFlankingClose, hasEmStrongRightFlankingOpen);
  markPairedDelimiterRuns(tildeRuns1, escapesByChild, false, false);
  markPairedDelimiterRuns(tildeRuns2, escapesByChild, hasStrikeLeftFlankingClose, hasStrikeRightFlankingOpen);

  // 反引号：只有同长度出现两次及以上，或单反引号位于已有行内代码之前（可能抢占其开定界符）时才需要转义
  for (const run of backtickRuns) {
    const pairsWithLiteral = (backtickCountByLength.get(run.length) ?? 0) >= 2;
    const collidesWithLaterCode = run.length === 1 && run.childIndex < lastCodeChildIndex;
    if (!pairsWithLiteral && !collidesWithLaterCode) continue;
    const map = escapesByChild.get(run.childIndex)!;
    for (let pos = run.start; pos < run.start + run.length; pos += 1) {
      recordEscape(map, pos, 'inline');
    }
  }

  // 方括号：拼接块内非链接普通文本的位置映射，仅对可能触发双链/脚注/行内链接/引用链接的 `[` 转义
  let combined = '';
  const charOwners: Array<{ childIndex: number; offset: number } | null> = [];
  for (let ci = 0; ci < children.length; ci += 1) {
    const child = children[ci];
    if (child.type === 'wikiLink') {
      // 双链节点自身携带 `]]`，可能与前文字面 `[[` 形成闭合
      combined += '\u0000]]';
      charOwners.push(null, null, null);
      continue;
    }
    if (!isPlainTextChild(child)) {
      combined += '\u0000';
      charOwners.push(null);
      continue;
    }
    if (hasMarkType(child, ['code', 'link'])) {
      combined += '\u0000';
      charOwners.push(null);
      continue;
    }
    for (let offset = 0; offset < child.text.length; offset += 1) {
      combined += child.text[offset];
      charOwners.push({ childIndex: ci, offset });
    }
  }

  if (combined.includes('[')) {
    const lastDoubleClose = hasWikiLinkAtom ? combined.length : combined.lastIndexOf(']]');
    const lastLinkClose = combined.lastIndexOf('](');
    const lastSingleClose = hasLinkDefs ? combined.lastIndexOf(']') : -1;

    const markBracketAt = (pos: number) => {
      const owner = charOwners[pos];
      if (!owner) return;
      const map = escapesByChild.get(owner.childIndex);
      if (!map) return;
      // 行首字面 `[` 若需转义，统一用 `&#91;` 避免与 LaTeX 块公式 `\[...\]` 冲突
      const kind: EscapeKind = lineStartBrackets.has(`${owner.childIndex}:${owner.offset}`) ? 'entityLeftBracket' : 'inline';
      recordEscape(map, owner.offset, kind);
    };

    for (let pos = 0; pos < combined.length; pos += 1) {
      if (combined[pos] !== '[') continue;
      // 双链 `[[...]]`：仅转义每个连续开括号中必要的 `[`，普通 `[[a]]` 只保护首个 `[`
      if (combined[pos + 1] === '[' && pos + 1 < lastDoubleClose) {
        markBracketAt(pos);
        if (combined[pos + 2] !== '[') pos += 1;
        continue;
      }
      // 脚注引用 `[^id]`
      if (combined[pos + 1] === '^' && /^\[\^[^\]\s]+\]/.test(combined.slice(pos))) {
        markBracketAt(pos);
        continue;
      }
      // 行内链接 / 图片 `[...](...)` 或存在引用定义时的 `[ref]`
      if (pos < lastLinkClose || pos < lastSingleClose) {
        markBracketAt(pos);
      }
    }
  }

  // ── 阶段 D：将记录的哨兵/实体写回文本节点 ──
  const content = children.map((child, ci) => {
    const map = escapesByChild.get(ci);
    if (!map || map.size === 0 || !isPlainTextChild(child)) return { ...child };
    let out = '';
    for (let idx = 0; idx < child.text.length; idx += 1) {
      const kind = map.get(idx);
      if (kind === 'entityLeftBracket') {
        out += emitRawSegment('&#91;');
      } else if (kind === 'structural') {
        out += STRUCTURAL_ESCAPE_SENTINEL + child.text[idx];
      } else if (kind === 'inline') {
        out += INLINE_ESCAPE_SENTINEL + child.text[idx];
      } else {
        out += child.text[idx];
      }
    }
    return { ...child, text: out };
  });

  return { ...node, content };
}

/**
 * 深拷贝文档 JSON，并为结构性与上下文必要的行内转义插入哨兵。
 * 段落启用行首块级与行内分析；标题已有 `#` 前缀，仅做行内分析；代码块与保留原文块直接跳过。
 */
function markStructuralEscapes(
  node: SerializableJsonNode,
  wouldFormInlineMath: (value: string) => boolean,
  inTableCell = false,
  hasLinkDefs = false,
): SerializableJsonNode {
  if (node.type === 'codeBlock' || typeof node.attrs?.[SOURCE_RAW_ATTR] === 'string') return { ...node };
  const isCell = inTableCell || node.type === 'tableCell' || node.type === 'tableHeader';
  if (!node.content) return { ...node };

  if (node.type === 'paragraph') {
    return markTextblockEscapes(node, !isCell, isCell, wouldFormInlineMath, hasLinkDefs);
  }
  if (node.type === 'heading') {
    return markTextblockEscapes(node, false, isCell, wouldFormInlineMath, hasLinkDefs);
  }

  return {
    ...node,
    content: node.content.map((child) => markStructuralEscapes(child, wouldFormInlineMath, isCell, hasLinkDefs)),
  };
}

/** 把结构性必要转义标记还原为反斜杠（冗余转义清理完成后调用）。 */
function finalizeStructuralEscapes(markdown: string): string {
  return markdown.includes(STRUCTURAL_ESCAPE_MARK)
    ? markdown.split(STRUCTURAL_ESCAPE_MARK).join('\\')
    : markdown;
}

/**
 * 转义普通文本中的 Markdown 标记，同时避免把 Windows 路径等安全反斜杠无条件翻倍。
 * 反斜杠仅在行尾、哨兵前或 CommonMark 可转义标点前需要自我转义；字母、数字、中文前可原样保留。
 * 普通符号（_、`、*、[、]、~）仅在上下文分析器插入哨兵时才输出转义，不再盲目全量加反斜杠。
 */
function escapeMarkdownText(text: string, invisibleAsEntities = false): string {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === STRUCTURAL_ESCAPE_SENTINEL) {
      // 结构性必要转义：先输出专用标记，待冗余转义清理结束后再还原为反斜杠
      output += STRUCTURAL_ESCAPE_MARK;
      continue;
    }
    if (character === INLINE_ESCAPE_SENTINEL) {
      // 候选行内转义：转为反斜杠，后续仍可由冗余转义清理在安全时移除
      output += '\\';
      continue;
    }
    if (character === '\\') {
      const nextCharacter = text[index + 1];
      const mustEscapeBackslash =
        nextCharacter === undefined
        || nextCharacter === '\n'
        || nextCharacter === STRUCTURAL_ESCAPE_SENTINEL
        || nextCharacter === INLINE_ESCAPE_SENTINEL
        || COMMONMARK_ESCAPABLE_PUNCTUATION.has(nextCharacter);
      output += mustEscapeBackslash ? '\\\\' : '\\';
      continue;
    }
    // 原文以实体书写不可见空白（如 `&nbsp;`）时写回实体；否则保持字符原样
    const invisibleEntity = invisibleAsEntities ? INVISIBLE_CHARACTER_ENTITIES[character] : undefined;
    if (invisibleEntity) {
      output += invisibleEntity;
      continue;
    }
    output += character;
  }
  return output;
}

interface BacktickRun {
  start: number;
  end: number;
  length: number;
}

/** 查找未被反斜杠转义的反引号分隔符，供行内代码保护逻辑使用。 */
function findBacktickRun(text: string, from: number): BacktickRun | null {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] !== '`') continue;

    let precedingBackslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 !== 0) continue;

    let end = index + 1;
    while (end < text.length && text[end] === '`') end += 1;
    return { start: index, end, length: end - index };
  }
  return null;
}

/**
 * 只转换一行中不属于行内代码的片段。
 * 代码跨度内的实体是用户原始代码，不能按普通 Markdown 文本清理。
 */
function mapOutsideInlineCode(
  line: string,
  transform: (text: string, linePrefix: string) => string,
): string {
  let cursor = 0;
  let output = '';

  while (cursor < line.length) {
    const opening = findBacktickRun(line, cursor);
    if (!opening) {
      output += transform(line.slice(cursor), output);
      break;
    }

    let closing = findBacktickRun(line, opening.end);
    while (closing && closing.length !== opening.length) {
      closing = findBacktickRun(line, closing.end);
    }

    // 没有等长闭合反引号时，该反引号串只是普通字面文本而非行内代码，需继续处理其后的普通正文
    if (!closing) {
      output += transform(line.slice(cursor, opening.end), output);
      cursor = opening.end;
      continue;
    }

    output += transform(line.slice(cursor, opening.start), output);
    output += line.slice(opening.start, closing.end);
    cursor = closing.end;
  }

  return output;
}

interface MarkdownCleanupCandidate {
  start: number;
  end: number;
  replacement: string;
}

/**
 * 收集普通文本中可尝试清理的转义，跳过代码围栏与行内代码中的原始内容。
 * 跳过成对双反斜杠 `\\`（表示字面反斜杠）与非 CommonMark 可转义字符（如 `\¥`、`\→`），
 * 避免误删用户原本输入的反斜杠并连带导致整篇语义校验失败。
 */
function collectMarkdownCleanupCandidates(markdown: string): MarkdownCleanupCandidate[] {
  const candidates: MarkdownCleanupCandidate[] = [];
  let activeFence: { marker: '`' | '~'; length: number } | null = null;
  let lineOffset = 0;

  for (const rawLine of markdown.split('\n')) {
    const fenceMatch = rawLine.match(/^ {0,3}(`{3,}|~{3,})/);
    if (activeFence) {
      const closingFence = new RegExp(
        `^ {0,3}\\${activeFence.marker}{${activeFence.length},}[ \\t]*$`,
      );
      if (closingFence.test(rawLine)) activeFence = null;
      lineOffset += rawLine.length + 1;
      continue;
    }
    if (fenceMatch) {
      activeFence = {
        marker: fenceMatch[1][0] as '`' | '~',
        length: fenceMatch[1].length,
      };
      lineOffset += rawLine.length + 1;
      continue;
    }

    let cursor = 0;
    while (cursor < rawLine.length) {
      const opening = findBacktickRun(rawLine, cursor);
      const segmentEnd = opening?.start ?? rawLine.length;

      for (let index = cursor; index < segmentEnd; index += 1) {
        if (rawLine[index] === '\\') {
          const next = rawLine[index + 1];
          // `\\` 表示一个字面反斜杠，必须成对跳过，绝不能当作冗余转义清理
          if (next === '\\') {
            index += 1;
            continue;
          }
          if (next !== undefined && COMMONMARK_ESCAPABLE_PUNCTUATION.has(next)) {
            candidates.push({
              start: lineOffset + index,
              end: lineOffset + index + 1,
              replacement: '',
            });
          }
          continue;
        }

        const entity = rawLine.slice(index, index + 4);
        if (entity === '&lt;' || entity === '&gt;') {
          candidates.push({
            start: lineOffset + index,
            end: lineOffset + index + 4,
            replacement: entity === '&lt;' ? '<' : '>',
          });
          index += 3;
        }
      }

      if (!opening) break;

      let closing = findBacktickRun(rawLine, opening.end);
      while (closing && closing.length !== opening.length) {
        closing = findBacktickRun(rawLine, closing.end);
      }
      // 没有等长闭合反引号时，该反引号串属于普通文本，继续扫描其后内容
      if (!closing) {
        cursor = opening.end;
        continue;
      }
      cursor = closing.end;
    }

    lineOffset += rawLine.length + 1;
  }

  return candidates;
}

/** 从右向左应用清理项，保证各项仍可使用原 Markdown 字符偏移。 */
function applyMarkdownCleanupCandidates(
  markdown: string,
  candidates: MarkdownCleanupCandidate[],
): string {
  let output = markdown;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    output = output.slice(0, candidate.start) + candidate.replacement + output.slice(candidate.end);
  }
  return output;
}

/** 仅记录源码写法、不影响文档语义的节点属性：围栏、表格风格、列表原始缩进、块间距与顶层块原文。 */
const SOURCE_FORMAT_ATTRIBUTES = ['sourceFence', 'markdownStyle', 'sourceIndent', 'sourceContinuationIndents', 'sourceLeadingIndent', 'sourceCompactBefore', 'sourceTrailingPlaceholder', 'sourceBlocks'];

/** 深拷贝 JSON 并去掉源码写法属性 */
function withoutSourceFormatAttributes(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(withoutSourceFormatAttributes);
  if (!json || typeof json !== 'object') return json;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) {
    if (key === 'attrs' && value && typeof value === 'object') {
      const attrs = { ...(value as Record<string, unknown>) };
      for (const name of SOURCE_FORMAT_ATTRIBUTES) delete attrs[name];
      result.attrs = attrs;
    } else {
      result[key] = withoutSourceFormatAttributes(value);
    }
  }
  return result;
}

/** 忽略源码写法属性比较两个文档（仅在 eq 不相等时调用，避免常规路径整篇转 JSON） */
function sameIgnoringSourceFormat(reference: { toJSON?(): unknown }, other: unknown): boolean {
  const otherJson = (other as { toJSON?(): unknown } | null)?.toJSON?.();
  if (typeof reference.toJSON !== 'function' || otherJson === undefined) return false;
  // 参考文档按序列化时同样的规则去掉会被解析器丢弃的行尾空白，再与重新解析的结果比较
  const referenceJson = trimDroppedTrailingWhitespace(withoutEmptyRawHtmlBlocks(withoutTrailingPlaceholder(reference.toJSON() as SerializableJsonNode)));
  return JSON.stringify(withoutSourceFormatAttributes(referenceJson))
    === JSON.stringify(withoutSourceFormatAttributes(otherJson));
}

/**
 * 在不改变解析后文档的前提下删除冗余转义。
 * 只做一次批量语义校验：全部候选都安全时一并清理，存在 Markdown 歧义时
 * 保守保留全部候选，确保耗时不会随候选数量退化为反复整篇解析。
 * 🔴 J2：参考文档参数化（referenceDoc 为捕获的不可变快照，不再依赖活的 editor.state.doc）。
 */
function removeRedundantMarkdownEscapes(
  markdown: string,
  referenceDoc: { eq(other: unknown): boolean; attrs?: Record<string, unknown>; toJSON?(): unknown },
  nodeFromJSON: (json: unknown) => unknown,
  manager: MarkdownManagerLike | null | undefined,
  // 把候选文本还原为最终输出形态（必要转义标记、原样片段占位符）后再做语义校验
  restoreForParse: (markdown: string) => string = finalizeStructuralEscapes,
): string {
  if (typeof manager?.parse !== 'function') return markdown;

  const candidates = collectMarkdownCleanupCandidates(markdown);
  if (candidates.length === 0) return markdown;

  const preservesDocument = (candidateMarkdown: string): boolean => {
    try {
      // 语义校验时把必要转义标记还原为真实反斜杠，保证解析结果与最终输出一致
      const { parsed, tokens } = captureMarkdownBlockTokens(manager.instance, () => manager.parse!(restoreForParse(candidateMarkdown)));
      // 语义校验与打开文档使用相同的首尾换行规则，复用本次解析的词法结果。
      if (tokens) restoreOuterParagraphBreaks(parsed, tokens);
      deduplicateParsedMarkdownMarks(parsed as ParsedMarkdownNode);
      // 末尾换行等文档级属性不来自正文解析，比较前沿用参考文档的属性
      if (referenceDoc.attrs) parsed.attrs = { ...referenceDoc.attrs };
      const parsedDoc = nodeFromJSON(parsed);
      if (referenceDoc.eq(parsedDoc)) return true;
      // 原文围栏、表格风格等源码写法属性随解析来源而变（新建节点为空），与语义无关：忽略后再比较一次
      return sameIgnoringSourceFormat(referenceDoc, parsedDoc);
    } catch {
      // 解析器无法验证时必须保留安全输出，不能为了源码美观冒险改变文档结构。
      return false;
    }
  };

  const fullyCleaned = applyMarkdownCleanupCandidates(markdown, candidates);
  if (preservesDocument(fullyCleaned)) return fullyCleaned;

  // 批量清理会改变文档结构时保守保留全部候选转义。旧实现继续二分到单个候选，
  // 最坏会触发“候选数 × 整篇 Markdown 解析”：数百个字面星号即可阻塞主线程数分钟。
  // 一次批量语义校验把本流程稳定限制在线性扫描 + 单次解析内；宁可源码中多保留
  // 少量无害反斜杠，也不能以交互冻结换取纯展示层面的源码美化。
  return markdown;
}

/**
 * 清理 TipTap Markdown 序列化器为安全兜底而产生、但在源码中没有必要的编码。
 *
 * 主要规则：
 * 1. `&` 还原为普通字符，避免 shell 重定向在往返后出现 `&amp;`；
 * 2. 仅在不会变成块引用标记的位置还原 `>`；
 * 3. 仅在不会触发 HTML 标签、注释或自动链接的位置还原 `<`；
 * 代码围栏和行内代码保持原样，避免把代码中原本就存在的实体文本误解码。
 */
export function normalizeSerializedMarkdown(markdown: string): string {
  let activeFence: { marker: '`' | '~'; length: number } | null = null;

  return markdown
    .split('\n')
    .map((rawLine) => {
      const fenceMatch = rawLine.match(/^ {0,3}(`{3,}|~{3,})/);
      if (activeFence) {
        const closingFence = new RegExp(
          `^ {0,3}\\${activeFence.marker}{${activeFence.length},}[ \\t]*$`,
        );
        if (closingFence.test(rawLine)) activeFence = null;
        return rawLine;
      }
      if (fenceMatch) {
        activeFence = {
          marker: fenceMatch[1][0] as '`' | '~',
          length: fenceMatch[1].length,
        };
        return rawLine;
      }

      return mapOutsideInlineCode(rawLine, (segment, linePrefix) => {
        // amp、lt 与 gt 必须在同一轮扫描中还原：`&amp;&gt;` 恢复为 `&>`；
        // 分两轮会把字面量 `&gt;`（编码为 `&amp;gt;`）先还原成 `&gt;` 再误解码为 `>`
        let restored = '';
        let cursor = 0;
        for (const match of segment.matchAll(/&(amp|lt|gt);/g)) {
          const offset = match.index ?? 0;
          restored += segment.slice(cursor, offset);
          cursor = offset + match[0].length;
          if (match[1] === 'amp') {
            // 字面量 `&gt;`、`&copy;`、`&#39;` 等实体形态文本必须保留 `&amp;`，否则再次解析会被当成实体解码
            // 未知名称（如 `&foo;`）不会被解码，还原为 `&` 即可保持原文
            restored += isDecodableEntitySuffix(segment.slice(cursor)) ? match[0] : '&';
            continue;
          }
          const prefix = linePrefix + restored;
          if (match[1] === 'lt') {
            // 仅在后文会构成 HTML 标签/注释/自动链接或行首块级 HTML 时保留 `&lt;`，其余（如 `a < b`、`x<y`）直接还原为 `<`
            const trailingDecoded = segment.slice(cursor).replace(/&gt;/g, '>');
            const isBlockHtmlStart = /^(?: {0,3}(?:(?:>|[-+*]|\d+[.)])(?:[ \t]+|$)))* {0,3}$/.test(prefix)
              && /^\/?[a-zA-Z]/.test(trailingDecoded);
            const mustKeepLt = isBlockHtmlStart
              || HTML_TAG_AFTER_LT.test(trailingDecoded)
              || AUTOLINK_AFTER_LT.test(trailingDecoded);
            restored += mustKeepLt ? match[0] : '<';
            continue;
          }
          // 行首或列表/引用容器开头的 `>` 会改变 Markdown 块结构，必须继续保留实体
          const isBlockQuoteMarker = /^(?: {0,3}(?:(?:>|[-+*]|\d+[.)])(?:[ \t]+|$)))* {0,3}$/.test(prefix);
          restored += isBlockQuoteMarker ? match[0] : '>';
        }
        return restored + segment.slice(cursor);
      });
    })
    .join('\n');
}

// ── 序列化器 ──

/** 按文档属性还原源文件末尾换行（未装配该属性或正文为空时原样返回）。 */
function appendTrailingNewline(markdown: string, attrs: Record<string, unknown> | undefined): string {
  const trailing = typeof attrs?.trailingNewline === 'string' ? attrs.trailingNewline : '';
  if (!trailing || markdown === '' || markdown.endsWith('\n')) return markdown;
  // 多个文末空行已有段落节点或原文记录。这里只补文件终止符，避免覆盖新留白或恢复已删空段。
  return `${markdown}\n`;
}

/** 记录正文节点之外的文末换行，正文已持有的续行可直接删除。 */
function trailingNewlineOf(markdown: string, parsed: JSONContent): string {
  const last = parsed.content?.at(-1);
  if (last?.type === 'paragraph' && last.content?.at(-1)?.text?.endsWith('\n')) return '';
  const match = /(?:\r?\n)+$/.exec(markdown);
  return match ? '\n'.repeat(match[0].split('\n').length - 1) : '';
}

/**
 * 统一的序列化后处理流水线（两个序列化入口共用）：
 * 1. 在原样片段会话中生成原始 Markdown（front matter / HTML / 脚注先以占位符输出）；
 * 2. 实体还原 → 冗余转义清理（语义校验前还原必要转义与原样片段，保证校验对象与最终输出一致）；
 * 3. 还原必要转义与原样片段，最后补回源文件末尾换行（文末原文已逐字写回时保持原样）。
 */
function runSerializationPipeline(
  produceRaw: () => string,
  referenceDoc: { eq(other: unknown): boolean; attrs?: Record<string, unknown>; toJSON?(): unknown },
  nodeFromJSON: (json: unknown) => unknown,
  manager: MarkdownManagerLike | null | undefined,
  verbatimTail = false,
): string {
  beginRawSegmentSession();
  let raw: string;
  let segments: string[];
  try {
    raw = produceRaw();
  } finally {
    segments = endRawSegmentSession();
  }
  const restore = (markdown: string): string =>
    restoreRawSegments(finalizeStructuralEscapes(markdown), segments);
  const normalized = normalizeSerializedMarkdown(raw);
  const cleaned = removeRedundantMarkdownEscapes(normalized, referenceDoc, nodeFromJSON, manager, restore);
  return verbatimTail ? restore(cleaned) : appendTrailingNewline(restore(cleaned), referenceDoc.attrs);
}

/** 序列化入口共用：有原文记录的完整文档保留未编辑块原文，其余（片段、无记录）整篇输出。 */
function serializationJson(doc: { toJSON(): ReturnType<Editor['getJSON']> }): { json: ReturnType<Editor['getJSON']>; verbatimTail: boolean } {
  if (typeof (doc as Partial<PreservableNode>).forEach !== 'function') return { json: doc.toJSON(), verbatimTail: false };
  const { json, verbatimTail } = buildPreservedSerializationJson(doc as unknown as PreservableNode);
  return { json: json as ReturnType<Editor['getJSON']>, verbatimTail };
}

/**
 * 去掉 raw 为空的块级 HTML 节点：可视化中新建后未输入内容的空块需保留在编辑器里，
 * 但块级拼接不过滤空串，照常序列化会写出多余空行；空块本身也不对应任何源码。
 */
function withoutEmptyRawHtmlBlocks(node: SerializableJsonNode): SerializableJsonNode {
  if (!node.content || node.content.length === 0) return node;
  const content = node.content
    .filter((child) => !(child.type === 'rawHtmlBlock' && String((child.attrs as { raw?: unknown } | undefined)?.raw ?? '') === ''))
    .map(withoutEmptyRawHtmlBlocks);
  return { ...node, content };
}

/** 仅移除明确由编辑器补出的、尚未编辑的文末辅助段；作者原有或手动插入的空段全部保留。 */
function withoutTrailingPlaceholder(node: SerializableJsonNode): SerializableJsonNode {
  const last = node.content?.[node.content.length - 1];
  const attrs = last?.attrs as Record<string, unknown> | undefined;
  if (node.type !== 'doc' || last?.type !== 'paragraph' || !attrs?.sourceTrailingPlaceholder
    || last.content?.length || attrs.textAlign || Number(attrs.indent) > 0) return node;
  return { ...node, content: node.content!.slice(0, -1) };
}

/**
 * 双链与带标记的行内原子节点转为「受保护原文片段」文本：
 * 1. 原文经 emitRawSegment 以占位符输出，实体还原、冗余转义清理等全文后处理不会改动链接内容（如 `&amp;`）；
 * 2. 作为文本节点携带原有标记，`**[[笔记]]**`、`**$T_0$**` 等粗体 / 斜体包裹按普通文字一样写回
 *    （@tiptap/markdown 不会为非文本的行内节点输出标记）；
 * 3. 双链位于表格单元格内时，内容中的 `|` 写成 `\|`。
 * 须在序列化会话内调用（prepareJsonForSerialization 只在 produceRaw 中执行）。
 */
function inlineAtomsToRawText(node: SerializableJsonNode, inTableCell = false): SerializableJsonNode {
  if (node.type === 'wikiLink') {
    const attrs = (node.attrs ?? {}) as { inner?: unknown; embed?: unknown };
    const text = emitRawSegment(formatWikiLinkMarkdown(String(attrs.inner ?? ''), attrs.embed === true, inTableCell));
    return node.marks ? { type: 'text', text, marks: node.marks } : { type: 'text', text };
  }
  if (Array.isArray(node.marks) && node.marks.length > 0) {
    // 原子节点没有文本子节点，直接序列化会在它前后关闭 / 重开标记，导致原范围被拆开。
    const attrs = (node.attrs ?? {}) as { latex?: unknown; id?: unknown; raw?: unknown };
    const raw = node.type === 'mathInline' ? `$${String(attrs.latex ?? '')}$`
      : node.type === 'footnoteReference' ? `[^${String(attrs.id ?? '')}]`
        : node.type === 'rawHtmlInline' ? String(attrs.raw ?? '') : null;
    if (raw !== null) return { type: 'text', text: emitRawSegment(raw), marks: node.marks };
  }
  if (!node.content) return node;
  const isCell = inTableCell || node.type === 'tableCell' || node.type === 'tableHeader';
  return { ...node, content: node.content.map((child) => inlineAtomsToRawText(child, isCell)) };
}

/** 序列化前的 JSON 预处理：先按上下文插入结构与行内转义哨兵，再将行内原子节点转为受保护片段（不修改编辑器中的真实文档）。 */
function prepareJsonForSerialization(json: ReturnType<Editor['getJSON']>): ReturnType<Editor['getJSON']> {
  const cleaned = trimDroppedTrailingWhitespace(
    withoutEmptyRawHtmlBlocks(withoutTrailingPlaceholder(json as SerializableJsonNode)),
  );
  const marked = markStructuralEscapes(
    cleaned,
    textWouldFormInlineMath,
    false,
    hasLinkReferenceDefinitions(cleaned),
  );
  return inlineAtomsToRawText(marked) as ReturnType<Editor['getJSON']>;
}

// 任务列表由独立 tokenizer 解析，末项行尾空格会被保留，不在此列
const LIST_NODE_TYPES = new Set(['bulletList', 'orderedList']);

/** 去掉文本块末尾文本的行尾空格/制表符（末尾文本被删空时一并移除） */
function trimTextblockEnd(node: SerializableJsonNode): SerializableJsonNode {
  const content = [...(node.content ?? [])];
  while (content.length > 0) {
    const last = content[content.length - 1];
    if (last.type !== 'text' || typeof last.text !== 'string') break;
    const trimmed = last.text.replace(/[ \t]+$/, '');
    if (trimmed === last.text) break;
    if (trimmed === '') content.pop();
    else content[content.length - 1] = { ...last, text: trimmed };
  }
  return { ...node, content };
}

/**
 * 去掉解析器会丢弃的行尾空白：标题末尾、各列表最后一项的末尾文本、有序列表各项的直接段落末尾。
 * 这些空格在可视化模式中可以键入，若照写进文件，下次打开时会被解析器去掉，
 * 导致每次进入可视化都提示"去除行尾空格"。其余位置（普通段落、引用、无序列表中间项）的行尾空格能往返保留，不做处理。
 * atListEnd 表示当前节点的末尾即某个列表最后一项的末尾。
 */
function trimDroppedTrailingWhitespace(node: SerializableJsonNode, atListEnd = false): SerializableJsonNode {
  if (node.type === 'heading' || (atListEnd && node.type === 'paragraph')) return trimTextblockEnd(node);
  if (!node.content || node.content.length === 0 || node.type === 'paragraph') return node;
  const isList = LIST_NODE_TYPES.has(node.type ?? '');
  // 有序列表由 TipTap 自带 tokenizer 解析，每一项的直接段落末尾空白都会被去掉
  const isOrderedItem = (child: SerializableJsonNode) => node.type === 'orderedList' && child.type === 'listItem';
  const lastIndex = node.content.length - 1;
  return {
    ...node,
    content: node.content.map((child, index) => {
      const trimmed = trimDroppedTrailingWhitespace(child, index === lastIndex && (isList || atListEnd));
      if (!isOrderedItem(trimmed) || !trimmed.content) return trimmed;
      return {
        ...trimmed,
        content: trimmed.content.map((part) => (part.type === 'paragraph' ? trimTextblockEnd(part) : part)),
      };
    }),
  };
}

/** @tiptap/markdown 注入的 MarkdownManager（serialize/parse/escapeMarkdownSyntax） */
export interface MarkdownManagerLike {
  /** 当前编辑器独占的词法解析器，用于复用本次解析的根 token。 */
  instance?: object;
  /** 对指定 JSON 模型序列化为 Markdown（J2 纯适配器的核心入口） */
  serialize?: (json: ReturnType<Editor['getJSON']>) => string;
  parse?: (markdown: string) => ReturnType<Editor['getJSON']>;
  escapeMarkdownSyntax?: (text: string) => string;
}

/** 从 Editor 实例提取共享的 MarkdownManager（无扩展装配时为 null） */
export function getMarkdownManager(editor: Editor): MarkdownManagerLike | null {
  const manager = (
    editor.storage as unknown as {
      markdown?: { manager?: MarkdownManagerLike };
    }
  ).markdown?.manager;
  return manager ?? null;
}

/**
 * 🔴 J2 纯适配器：对指定不可变 ProseMirror 文档快照序列化为 Markdown 文本。
 * 不依赖活的 Editor 实例——schema/manager 按兼容配置共享（捕获时的引用），
 * 序列化读取传入的 doc 快照，绝不改读"此刻的 editor.state.doc"。
 * 与 serializeMarkdown(editor) 的输出逐字等价（roundtrip 等价测试保证）。
 */
export function serializeMarkdownFromDoc(
  manager: MarkdownManagerLike,
  schema: { nodeFromJSON(json: unknown): { eq(other: unknown): boolean } },
  doc: { toJSON(): ReturnType<Editor['getJSON']>; eq(other: unknown): boolean; attrs?: Record<string, unknown> },
): string {
  if (typeof manager.serialize !== 'function') {
    throw new Error('[NoteBoard] MarkdownManager.serialize 不可用，无法按快照序列化');
  }
  const originalEscaper = manager.escapeMarkdownSyntax;
  if (typeof originalEscaper === 'function') {
    // TipTap 暂未开放文本转义策略配置；在同步序列化期间临时替换其内部转义器，
    // 只影响普通文本节点，不会误改代码块、行内代码、链接地址或图片路径。
    // 🔴 同步独占，finally 恢复，不跨 await（J 节要求）。
    const invisibleAsEntities = doc.attrs?.invisibleCharEntities === true;
    manager.escapeMarkdownSyntax = (text: string) => escapeMarkdownText(text, invisibleAsEntities);
  }
  try {
    const { json, verbatimTail } = serializationJson(doc);
    return runSerializationPipeline(
      () => manager.serialize!(prepareJsonForSerialization(json)),
      doc,
      schema.nodeFromJSON.bind(schema),
      manager,
      verbatimTail,
    );
  } finally {
    if (manager && typeof originalEscaper === 'function') {
      manager.escapeMarkdownSyntax = originalEscaper;
    }
  }
}

/**
 * 从 TipTap 编辑器序列化为 Markdown 文本
 *
 * @tiptap/markdown 扩展会把 getMarkdown 方法注入到 Editor 实例上
 * （通过 declare module '@tiptap/core' 的 interface Editor 增强）。
 * 注意：不是 editor.storage.markdown.getMarkdown——storage.markdown 是
 * { manager: MarkdownManager }，没有 getMarkdown 字段。原代码访问
 * storage.markdown.getMarkdown 永远是 undefined，导致静默回退到
 * editor.getText()，丢失所有 markdown 语法。
 *
 * 如果 editor.getMarkdown 不存在，说明 @tiptap/markdown 扩展未装配——
 * 这是配置错误，明确报错避免静默退化成纯文本导致格式丢失。
 */
export function serializeMarkdown(editor: Editor): string {
  const getMarkdown = (editor as unknown as { getMarkdown?: () => string }).getMarkdown;
  if (typeof getMarkdown === 'function') {
    const manager = getMarkdownManager(editor);
    const originalEscaper = manager?.escapeMarkdownSyntax;
    if (manager && typeof originalEscaper === 'function') {
      // TipTap 暂未开放文本转义策略配置；在同步序列化期间临时替换其内部转义器，
      // 只影响普通文本节点，不会误改代码块、行内代码、链接地址或图片路径。
      const invisibleAsEntities = editor.state.doc.attrs.invisibleCharEntities === true;
      manager.escapeMarkdownSyntax = (text: string) => escapeMarkdownText(text, invisibleAsEntities);
    }
    try {
      // 有 MarkdownManager 时直接序列化插入了必要转义哨兵的 JSON；否则回退到注入的 getMarkdown
      const preserved = typeof manager?.serialize === 'function' ? serializationJson(editor.state.doc) : null;
      return runSerializationPipeline(
        () => (preserved && typeof manager?.serialize === 'function'
          ? manager.serialize(prepareJsonForSerialization(preserved.json))
          : getMarkdown.call(editor)),
        editor.state.doc,
        (json) => editor.schema.nodeFromJSON(json),
        manager,
        preserved?.verbatimTail ?? false,
      );
    } finally {
      if (manager && typeof originalEscaper === 'function') {
        manager.escapeMarkdownSyntax = originalEscaper;
      }
    }
  }
  console.error(
    '[NoteBoard] @tiptap/markdown 扩展未注册，无法序列化为 Markdown。' +
      '请检查 src/features/editor-md/extensions/index.ts 的 buildExtensions()。',
  );
  return editor.getText();
}

/**
 * 将 Markdown 文本解析为 TipTap 内容
 * 用于 source 模式切回 visual 模式，或打开文件时加载初始内容
 *
 * 必须显式声明 contentType: 'markdown'，否则 TipTap 默认按 JSON
 * 解析，前置 #、-、``` 等不会触发对应节点，导致 heading 列表等失效。
 *
 * 空内容守卫：空白 markdown（新建文档初始态）必须走 clearContent。
 * @tiptap/markdown 的 parse('') 返回 {type:'doc',content:[]}，
 * 而 doc schema 要求 block+（至少一个块节点），直接 setContent 会抛
 * RangeError: Invalid content for node doc —— 在组件挂载路径上
 * 会炸掉 React 渲染（整窗白屏）。
 */
/**
 * 执行整篇内容同步，但永远不写入编辑器内核的局部历史。
 * 用户可见的撤销/重做由文件级统一时间线负责，初始化和模式同步都不允许伪造编辑步骤。
 * 整篇替换后从文档开头建立合法选区，避免旧光标被映射到末尾；历史导航和视图恢复可随后覆盖。
 */
function replaceEditorContent(
  editor: Editor,
  replace: ReturnType<Editor['chain']>,
): void {
  // 文件初始化、历史导航和模式同步属于程序行为，不允许污染用户的局部撤销栈
  replace
    .command(({ tr }) => {
      tr.setMeta('addToHistory', false);
      // 与正文替换共用事务，兼容列表、图片等首块，三端聚焦时均不会误跳到文末。
      tr.setSelection(Selection.atStart(tr.doc));
      return true;
    })
    .run();
}

interface ParsedMarkdownMark {
  type?: string;
  attrs?: Record<string, unknown>;
}

interface ParsedMarkdownNode {
  marks?: ParsedMarkdownMark[];
  content?: ParsedMarkdownNode[];
}

/**
 * 修复 Markdown 解析器在相邻/嵌套强调边界上偶发生成的同类型重复 mark。
 * ProseMirror 不允许一个文本节点同时拥有两个同类型 mark；保留解析栈中最后一个
 * （更靠内层）的 mark，并递归处理整棵 JSON，避免一次局部异常把整篇文档降级成纯文本。
 */
function deduplicateParsedMarkdownMarks(root: ParsedMarkdownNode): void {
  if (root.marks && root.marks.length > 1) {
    const seenTypes = new Set<string>();
    const repairedReversed: ParsedMarkdownMark[] = [];

    // 从内层向外层检查，同类型 mark 只保留最后出现的一个；不同类型的原顺序保持不变。
    for (let index = root.marks.length - 1; index >= 0; index -= 1) {
      const mark = root.marks[index];
      const type = mark.type;
      if (type && seenTypes.has(type)) continue;
      if (type) seenTypes.add(type);
      repairedReversed.push(mark);
    }
    root.marks = repairedReversed.reverse();
  }

  root.content?.forEach(deduplicateParsedMarkdownMarks);
}

/** 恢复 Marked 在整篇文档首尾省略的单个正文换行。段间分隔与 Markdown 块语法仍由原解析器处理。 */
function restoreOuterParagraphBreaks(parsed: JSONContent, tokens: readonly MarkdownToken[]): void {
  const first = parsed.content?.[0];
  if (first?.type === 'paragraph' && tokens[0]?.type === 'space' && tokens[0].raw === '\n'
    && tokens[1]?.type === 'paragraph') {
    const head = first.content?.[0];
    if (head?.type === 'text' && !head.marks?.length) head.text = `\n${head.text}`;
    else first.content = [{ type: 'text', text: '\n' }, ...(first.content ?? [])];
  }

  const last = parsed.content?.at(-1);
  const token = tokens.at(-1);
  if (last?.type !== 'paragraph' || token?.type !== 'paragraph' || !token.raw?.endsWith('\n')
    || token.raw.endsWith('\n\n') || token.text?.endsWith('\n')) return;
  const tail = last.content?.at(-1);
  if (tail?.type === 'text' && !tail.marks?.length) tail.text += '\n';
  else (last.content ??= []).push({ type: 'text', text: '\n' });
}

/**
 * 把一段 Markdown 解析为可直接插入编辑器的文档 JSON（不修改编辑器内容）。
 * 与整篇加载共用同一解析器与 mark 修复，并按 schema 显式校验；失败或未装配解析器时返回 null。
 * recordSource：整篇加载时在 attrs.sourceBlocks 记录顶层块原文，序列化时未编辑的块逐字写回。
 */
export function parseMarkdownToJson(editor: Editor, markdown: string, options: {
  recordSource?: boolean;
  onTokens?: (tokens: readonly MarkdownToken[]) => void;
} = {}): ReturnType<Editor['getJSON']> | null {
  const manager = getMarkdownManager(editor);
  const runParse = () => manager?.parse?.(markdown);
  const recordSource = options.recordSource === true && !!manager && supportsSourceBlocks(editor);
  let units: Parameters<typeof buildSourceBlocks>[0] = null;
  const { parsed, tokens } = captureMarkdownBlockTokens(manager?.instance, recordSource
    ? () => {
      const recorded = recordTopLevelTokens(manager!, runParse);
      units = recorded.units;
      return recorded.parsed;
    }
    : runParse);
  if (!parsed) return null;
  // 记录源文件块间距，与正文一同进入历史 / 快照；不重新分词，也不改动真实空段落。
  if (tokens) {
    restoreOuterParagraphBreaks(parsed, tokens);
    preserveSourceBlockSpacing(parsed, tokens);
    // 粘贴格式检测借用本次词法结果区分裸网址和显式链接，无需二次解析。
    options.onTokens?.(tokens);
  }
  deduplicateParsedMarkdownMarks(parsed as ParsedMarkdownNode);
  const doc = editor.schema.nodeFromJSON(parsed);
  if (recordSource) {
    // 指纹基于 schema 规范化后的节点计算，与序列化时读取的编辑器文档一致
    parsed.attrs = { ...parsed.attrs, sourceBlocks: buildSourceBlocks(units, markdown, doc as unknown as PreservableNode) };
  }
  return parsed;
}

/** 当前 schema 是否装配了顶层块原文属性（嵌入式编辑器等未装配时不记录）。 */
function supportsSourceBlocks(editor: Editor): boolean {
  return !!editor.schema.topNodeType.spec.attrs?.sourceBlocks;
}

/** 补齐只来自原文的文档级属性，后台准备与主线程装载必须沿用相同规则。 */
export function withMarkdownSourceAttributes(parsed: ReturnType<Editor['getJSON']>, markdown: string): ReturnType<Editor['getJSON']> {
  return { ...parsed, attrs: { ...parsed.attrs, trailingNewline: trailingNewlineOf(markdown, parsed), invisibleCharEntities: usesInvisibleCharacterEntities(markdown) } };
}

/**
 * 回写保真度检查：候选 Markdown 重新解析后是否与参考文档一致（文字、标记与结构）。
 * 不修改编辑器、不进入输入热路径，用于验证序列化规则本身（编辑后按规则重写的块依赖它们保真）。
 * 仅忽略已有的源码写法属性和解析器本就丢弃的行尾空白。
 */
export function isMarkdownSerializationStable(editor: Editor, markdown: string, referenceDoc = editor.state.doc): boolean {
  try {
    const parsed = parseMarkdownToJson(editor, markdown);
    if (!parsed) return false;
    // 文档级换行 / 实体偏好属于加载属性，不由候选正文的词法解析产生。
    parsed.attrs = { ...referenceDoc.attrs };
    const candidate = editor.schema.nodeFromJSON(parsed);
    return referenceDoc.eq(candidate) || sameIgnoringSourceFormat(referenceDoc, candidate);
  } catch {
    // 无法验证的候选同样必须交给用户逐次确认，不能把异常当成格式等价。
    return false;
  }
}

/** 在同一事务中写入顶层块原文记录（schema 未装配该属性时跳过）。 */
function withSourceBlocks(editor: Editor, chain: ReturnType<Editor['chain']>, value: unknown): ReturnType<Editor['chain']> {
  if (!supportsSourceBlocks(editor)) return chain;
  return chain.command(({ tr }) => {
    if (tr.doc.attrs.sourceBlocks !== value) tr.setDocAttribute('sourceBlocks', value);
    return true;
  });
}

export function parseMarkdown(
  editor: Editor,
  markdown: string,
): boolean {
  if (markdown.trim() === '') {
    // 空内容同样必须显式控制历史，否则初次打开空文件后可能出现伪撤销步骤
    const chain = editor.chain().clearContent(false);
    // 空文档没有实体写法依据：回到默认（不可见空白保持字符），避免沿用清空前的文档属性
    if (editor.schema.topNodeType.spec.attrs?.invisibleCharEntities) {
      chain.command(({ tr }) => {
        if (tr.doc.attrs.invisibleCharEntities !== false) tr.setDocAttribute('invisibleCharEntities', false);
        return true;
      });
    }
    replaceEditorContent(editor, withSourceBlocks(editor, chain, null));
    return true;
  }
  try {
    // @tiptap/markdown 的 marked 适配器在长文档的相邻粗体边界上可能返回
    // bold,bold 等非法 mark 集合；进入 schema 前统一修复并显式校验（见 parseMarkdownToJson）。
    const parsed = parseMarkdownToJson(editor, markdown, { recordSource: true });
    if (parsed) {
      // 顶层块原文与正文同一事务写入；旧内容的记录不能残留到新文档
      const chain = withSourceBlocks(editor, editor.chain().setContent(parsed, { contentType: 'json' }), parsed.attrs?.sourceBlocks ?? null);
      // setContent 只替换文档内容、不改 doc 节点属性：末尾换行等需单独写入文档属性（同一事务、不入历史）
      const docAttrSpecs = editor.schema.topNodeType.spec.attrs;
      if (docAttrSpecs?.trailingNewline) {
        const trailing = trailingNewlineOf(markdown, parsed);
        chain.command(({ tr }) => {
          if (tr.doc.attrs.trailingNewline !== trailing) tr.setDocAttribute('trailingNewline', trailing);
          return true;
        });
      }
      if (docAttrSpecs?.invisibleCharEntities) {
        const useEntities = usesInvisibleCharacterEntities(markdown);
        chain.command(({ tr }) => {
          if (tr.doc.attrs.invisibleCharEntities !== useEntities) tr.setDocAttribute('invisibleCharEntities', useEntities);
          return true;
        });
      }
      replaceEditorContent(editor, chain);
      return true;
    }

    // 未装配 MarkdownManager 时保留原兼容路径，配置错误仍由外层容错明确记录。
    replaceEditorContent(
      editor,
      withSourceBlocks(editor, editor.chain(), null).setContent(markdown, {
        contentType: 'markdown',
        parseOptions: {
          // 保持原有格式
          preserveWhitespace: 'full',
        },
      }),
    );
    return true;
  } catch (err) {
    console.error('[NoteBoard] Markdown 解析出现容错，执行安全降级加载:', err);
    try {
      replaceEditorContent(
        editor,
        withSourceBlocks(editor, editor.chain(), null).setContent(
          {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: markdown }],
              },
            ],
          },
          { contentType: 'json' },
        ),
      );
    } catch {
      replaceEditorContent(
        editor,
        editor.chain().clearContent(false),
      );
    }
    // 返回 false 告知调用方发生了降级：调用方应回到源码模式，避免把降级后的纯文本当作文档序列化
    return false;
  }
}

// ── 换行符规整工具 ──

/**
 * 规范化文本换行符（将 CRLF 转换为 LF）
 * 用于跨平台/跨编辑器引擎进行语义级无害内容比对，避免因换行符差异误标脏
 */
export function normalizeEol(text: string | null | undefined): string {
  if (text == null) return '';
  return text.replace(/\r\n/g, '\n');
}

/**
 * 判断源码文本是否真的不同于当前可视化文档。
 * 返回 false 时调用方必须跳过整篇 setContent，否则即使事务不入栈也会重映射并破坏已有撤销/重做历史。
 */
export function hasMarkdownContentChanged(editor: Editor, markdown: string): boolean {
  return normalizeEol(markdown) !== normalizeEol(serializeMarkdown(editor));
}

// ── 基线管理 ──

/**
 * 基线内容：打开文件时的原始 Markdown 文本
 * 用于判断"切模式后内容是否变了"
 *
 * 关键流程：
 * 1. 打开文件 → baseline = 文件内容
 * 2. 切 visual → editor 从 markdown 解析
 * 3. 编辑 → onUpdate 触发
 * 4. 切 source → serializeMarkdown(editor) → 如果 === baseline，不标脏
 * 5. 切回 visual → 从 source 文本重新解析
 *
 * 不变式 I-14 的保障：
 * 打开 → visual → source → serialize → 如果 === baseline → 不脏
 */
export class BaselineManager {
  private baseline: string | null = null;
  private docKey: string;

  constructor(docKey: string) {
    this.docKey = docKey;
  }

  /** 设置基线（打开文件或保存后） */
  setBaseline(content: string): void {
    this.baseline = content;
  }

  /** 获取基线 */
  getBaseline(): string | null {
    return this.baseline;
  }

  /** 判断当前内容是否与基线一致（不脏，支持自动规整行尾符） */
  isClean(currentContent: string): boolean {
    if (this.baseline === null) return false;
    // 统一规整换行符后进行内容比对，防止 Windows CRLF 导致假脏态
    return normalizeEol(currentContent) === normalizeEol(this.baseline);
  }

  /** 更新基线（保存成功后调用） */
  updateBaseline(content: string): void {
    this.baseline = content;
  }

  /** 清除基线 */
  clear(): void {
    this.baseline = null;
  }
}

// ── 全局基线管理器实例 ──

const baselines = new Map<string, BaselineManager>();

/** 获取或创建文档的基线管理器 */
export function getBaseline(docKey: string): BaselineManager {
  let mgr = baselines.get(docKey);
  if (!mgr) {
    mgr = new BaselineManager(docKey);
    baselines.set(docKey, mgr);
  }
  return mgr;
}

/** 删除文档的基线管理器 */
export function removeBaseline(docKey: string): void {
  baselines.delete(docKey);
}

// ── 往返保真测试辅助 ──

/**
 * 测试用：解析 markdown → 序列化 → 比较
 * 用于 gate:7 往返保真测试
 */
export function roundtripMarkdown(
  editor: Editor,
  markdown: string,
): { input: string; output: string; isIdentical: boolean } {
  // 1. 解析 markdown 到编辑器
  parseMarkdown(editor, markdown);

  // 2. 序列化回 markdown
  const output = serializeMarkdown(editor);

  // 3. 比较
  return {
    input: markdown,
    output,
    isIdentical: markdown === output,
  };
}
