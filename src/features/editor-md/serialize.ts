// NoteBoard Markdown 序列化
// @tiptap/markdown 入/出 + 基线管理（不变式 I-13/I-14）
// 详见 docs/09-开发路线图.md 7.5
//
// 不变式 I-13: 打开文件后，序列化的结果必须等于磁盘原文（否则"什么都没做就变脏"）
// 不变式 I-14: 打开 → 切 visual → 切 source → tab 不出现脏圆点

import type { Editor } from '@tiptap/core';
import { textWouldFormInlineMath } from './mathSyntax';
import { beginRawSegmentSession, endRawSegmentSession, restoreRawSegments } from './rawMarkdownSegments';

// CommonMark 允许反斜杠转义的 ASCII 标点；这些字符前的双反斜杠不能擅自折叠，
// 否则原本可见的反斜杠会在下一次解析时被当成转义符吞掉。
const COMMONMARK_ESCAPABLE_PUNCTUATION = new Set(
  [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'],
);
const TIPTAP_MARKDOWN_SPECIAL_CHARACTERS = new Set(['`', '*', '_', '[', ']', '~']);
// Unicode 标点与符号类别用于发现“可能是转义前缀”的反斜杠，不按具体字符逐项维护。
const UNICODE_PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/u;

// `&` 之后若紧跟实体名/数字实体（如 `gt;`、`#39;`），该 `&` 必须保持编码
const ENTITY_LIKE_SUFFIX = /^(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/;

// ── 结构性必要转义 ──
// 全局转义集合刻意保持最小（避免往返中转义累积）；但少数字面量字符在特定位置不转义就会改变文档结构：
// 行首的 `#`、`-`、`+`、`1.`，表格单元格内的 `|`，以及会构成行内公式的 `$`。
// 序列化前在 JSON 中于这些字符前插入哨兵（私有区字符，用户文本中不会出现），
// 转义器把哨兵替换为"必要转义标记"，冗余转义清理不会把该标记当作候选，最后才还原为反斜杠。
// 这样必要转义既不会被清理掉，也不会让"全有或全无"的批量清理因它们失败而整体保留冗余转义。
const STRUCTURAL_ESCAPE_SENTINEL = '';
const STRUCTURAL_ESCAPE_MARK = '';

// 行首会被识别为块结构的字面量：ATX 标题、无序列表、有序列表、分隔线/Setext 下划线
const LINE_START_HEADING = /^([ \t]{0,3})(#{1,6})(?=[ \t]|$)/;
const LINE_START_BULLET = /^([ \t]{0,3})([-+])(?=[ \t]|$)/;
const LINE_START_ORDERED = /^([ \t]{0,3}\d{1,9})([.)])(?=[ \t]|$)/;
const LINE_START_RULE = /^([ \t]{0,3})([-=])(?=[-= \t]*$)/;

interface SerializableJsonNode {
  type?: string;
  text?: string;
  content?: SerializableJsonNode[];
  [key: string]: unknown;
}

/** 在单行行首的块结构字面量前插入哨兵。 */
function markLineStart(line: string): string {
  for (const pattern of [LINE_START_HEADING, LINE_START_ORDERED, LINE_START_BULLET, LINE_START_RULE]) {
    const match = pattern.exec(line);
    if (match) {
      const prefixLength = match[1].length;
      return line.slice(0, prefixLength) + STRUCTURAL_ESCAPE_SENTINEL + line.slice(prefixLength);
    }
  }
  return line;
}

/** 文本节点按需插入哨兵：atLineStart 表示该节点起始处位于 Markdown 行首。 */
function markTextNode(
  text: string,
  atLineStart: boolean,
  inTableCell: boolean,
  wouldFormInlineMath: (value: string) => boolean,
): string {
  let output = text
    .split('\n')
    .map((line, index) => (index > 0 || atLineStart ? markLineStart(line) : line))
    .join('\n');
  if (inTableCell) output = output.replace(/\|/g, `${STRUCTURAL_ESCAPE_SENTINEL}|`);
  if (output.includes('$') && wouldFormInlineMath(text)) {
    output = output.replace(/\$/g, `${STRUCTURAL_ESCAPE_SENTINEL}$`);
  }
  return output;
}

/**
 * 深拷贝文档 JSON，并为结构性必要转义插入哨兵。
 * 只处理段落（列表项、引用、表格中的文字最终都落在段落里），标题等节点的正文前已有块前缀，无需处理。
 */
function markStructuralEscapes(
  node: SerializableJsonNode,
  wouldFormInlineMath: (value: string) => boolean,
  inTableCell = false,
): SerializableJsonNode {
  const isCell = inTableCell || node.type === 'tableCell' || node.type === 'tableHeader';
  if (!node.content) return { ...node };

  if (node.type !== 'paragraph') {
    return {
      ...node,
      content: node.content.map((child) => markStructuralEscapes(child, wouldFormInlineMath, isCell)),
    };
  }

  // 段落：首个文本节点与硬换行后的文本节点位于行首（表格单元格内不存在块级行首语义）
  let atLineStart = !isCell;
  const content = node.content.map((child) => {
    if (child.type === 'hardBreak') {
      atLineStart = !isCell;
      return { ...child };
    }
    if (child.type === 'text' && typeof child.text === 'string') {
      const hasMarks = Array.isArray(child.marks) && child.marks.length > 0;
      // 带行内代码标记的文本按原样输出，不能插入哨兵
      const isCode = hasMarks && (child.marks as Array<{ type?: string }>).some((mark) => mark.type === 'code');
      const marked = isCode ? child.text : markTextNode(child.text, atLineStart && !hasMarks, isCell, wouldFormInlineMath);
      atLineStart = false;
      return { ...child, text: marked };
    }
    atLineStart = false;
    return { ...child };
  });
  return { ...node, content };
}

/** 把结构性必要转义标记还原为反斜杠（冗余转义清理完成后调用）。 */
function finalizeStructuralEscapes(markdown: string): string {
  return markdown.includes(STRUCTURAL_ESCAPE_MARK)
    ? markdown.split(STRUCTURAL_ESCAPE_MARK).join('\\')
    : markdown;
}

/**
 * 转义普通文本中的 Markdown 标记，同时避免把 Windows 路径等安全反斜杠无条件翻倍。
 * 反斜杠仅在行尾或 CommonMark 可转义标点前需要自我转义；字母、数字、中文前可原样保留。
 */
function escapeMarkdownText(text: string): string {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === STRUCTURAL_ESCAPE_SENTINEL) {
      // 结构性必要转义：先输出专用标记，待冗余转义清理结束后再还原为反斜杠
      output += STRUCTURAL_ESCAPE_MARK;
      continue;
    }
    if (character === '\\') {
      const nextCharacter = text[index + 1];
      const mustEscapeBackslash =
        nextCharacter === undefined
        || nextCharacter === '\n'
        || COMMONMARK_ESCAPABLE_PUNCTUATION.has(nextCharacter);
      output += mustEscapeBackslash ? '\\\\' : '\\';
      continue;
    }
    output += TIPTAP_MARKDOWN_SPECIAL_CHARACTERS.has(character)
      ? `\\${character}`
      : character;
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

    // 未闭合反引号不是可靠的代码边界，保守保留其后的源码，避免错误改写
    if (!closing) {
      output += transform(line.slice(cursor, opening.start), output);
      output += line.slice(opening.start);
      break;
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

/** 判断指定 UTF-16 位置起始的完整 Unicode 字符是否属于标点或符号。 */
function isUnicodePunctuationOrSymbol(text: string, index: number): boolean {
  const codePoint = text.codePointAt(index);
  return codePoint !== undefined
    && UNICODE_PUNCTUATION_OR_SYMBOL.test(String.fromCodePoint(codePoint));
}

/**
 * 收集普通文本中可尝试清理的转义，跳过代码围栏与行内代码中的原始内容。
 * 方括号、强调符等是否真的可以去掉反斜杠，将由后续同一 Markdown 解析器做语义校验。
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

      // 按 Unicode 类别发现潜在转义，不依赖方括号、星号等具体字符枚举。
      for (let index = cursor; index < segmentEnd; index += 1) {
        if (
          rawLine[index] === '\\'
          && isUnicodePunctuationOrSymbol(rawLine, index + 1)
        ) {
          candidates.push({
            start: lineOffset + index,
            end: lineOffset + index + 1,
            replacement: '',
          });
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
      // 未闭合反引号后的边界不可靠，保守停止清理该行剩余内容。
      if (!closing) break;
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

/**
 * 在不改变解析后文档的前提下删除冗余转义。
 * 只做一次批量语义校验：全部候选都安全时一并清理，存在 Markdown 歧义时
 * 保守保留全部候选，确保耗时不会随候选数量退化为反复整篇解析。
 * 🔴 J2：参考文档参数化（referenceDoc 为捕获的不可变快照，不再依赖活的 editor.state.doc）。
 */
function removeRedundantMarkdownEscapes(
  markdown: string,
  referenceDoc: { eq(other: unknown): boolean; attrs?: Record<string, unknown> },
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
      const parsed = manager.parse!(restoreForParse(candidateMarkdown));
      // 末尾换行等文档级属性不来自正文解析，比较前沿用参考文档的属性
      if (referenceDoc.attrs) parsed.attrs = { ...referenceDoc.attrs };
      return referenceDoc.eq(nodeFromJSON(parsed));
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
        // amp 与 gt 必须在同一轮扫描中还原：`&amp;&gt;` 恢复为 `&>`；
        // 分两轮会把字面量 `&gt;`（编码为 `&amp;gt;`）先还原成 `&gt;` 再误解码为 `>`
        let restored = '';
        let cursor = 0;
        for (const match of segment.matchAll(/&(amp|gt);/g)) {
          const offset = match.index ?? 0;
          restored += segment.slice(cursor, offset);
          cursor = offset + match[0].length;
          if (match[1] === 'amp') {
            // 字面量 `&gt;`、`&copy;`、`&#39;` 等实体形态文本必须保留 `&amp;`，否则再次解析会被当成实体解码
            restored += ENTITY_LIKE_SUFFIX.test(segment.slice(cursor)) ? match[0] : '&';
            continue;
          }
          const prefix = linePrefix + restored;
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
  if (!trailing || markdown === '') return markdown;
  return markdown.replace(/\n*$/, '') + trailing;
}

/** 记录源文本末尾的换行（CRLF 按 LF 计数，保存时由文档 EOL 设置统一转换）。 */
function trailingNewlineOf(markdown: string): string {
  const match = /(?:\r?\n)+$/.exec(markdown);
  return match ? '\n'.repeat(match[0].split('\n').length - 1) : '';
}

/**
 * 统一的序列化后处理流水线（两个序列化入口共用）：
 * 1. 在原样片段会话中生成原始 Markdown（front matter / HTML / 脚注先以占位符输出）；
 * 2. 实体还原 → 冗余转义清理（语义校验前还原必要转义与原样片段，保证校验对象与最终输出一致）；
 * 3. 还原必要转义与原样片段，最后补回源文件末尾换行。
 */
function runSerializationPipeline(
  produceRaw: () => string,
  referenceDoc: { eq(other: unknown): boolean; attrs?: Record<string, unknown> },
  nodeFromJSON: (json: unknown) => unknown,
  manager: MarkdownManagerLike | null | undefined,
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
  return appendTrailingNewline(restore(cleaned), referenceDoc.attrs);
}

/** 序列化前的 JSON 预处理：插入结构性必要转义哨兵（不修改编辑器中的真实文档）。 */
function prepareJsonForSerialization(json: ReturnType<Editor['getJSON']>): ReturnType<Editor['getJSON']> {
  return markStructuralEscapes(
    json as SerializableJsonNode,
    textWouldFormInlineMath,
  ) as ReturnType<Editor['getJSON']>;
}

/** @tiptap/markdown 注入的 MarkdownManager（serialize/parse/escapeMarkdownSyntax） */
export interface MarkdownManagerLike {
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
    manager.escapeMarkdownSyntax = escapeMarkdownText;
  }
  try {
    return runSerializationPipeline(
      () => manager.serialize!(prepareJsonForSerialization(doc.toJSON())),
      doc,
      schema.nodeFromJSON.bind(schema),
      manager,
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
      manager.escapeMarkdownSyntax = escapeMarkdownText;
    }
    try {
      // 有 MarkdownManager 时直接序列化插入了必要转义哨兵的 JSON；否则回退到注入的 getMarkdown
      return runSerializationPipeline(
        () => (typeof manager?.serialize === 'function'
          ? manager.serialize(prepareJsonForSerialization(editor.getJSON()))
          : getMarkdown.call(editor)),
        editor.state.doc,
        (json) => editor.schema.nodeFromJSON(json),
        manager,
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
 */
function replaceEditorContent(
  editor: Editor,
  replace: ReturnType<Editor['chain']>,
): void {
  // 文件初始化、历史导航和模式同步属于程序行为，不允许污染用户的局部撤销栈
  replace
    .command(({ tr }) => {
      tr.setMeta('addToHistory', false);
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

export function parseMarkdown(
  editor: Editor,
  markdown: string,
): boolean {
  if (markdown.trim() === '') {
    // 空内容同样必须显式控制历史，否则初次打开空文件后可能出现伪撤销步骤
    replaceEditorContent(
      editor,
      editor.chain().clearContent(false),
    );
    return true;
  }
  try {
    const manager = getMarkdownManager(editor);
    const parsed = manager?.parse?.(markdown);
    if (parsed) {
      // @tiptap/markdown 的 marked 适配器在长文档的相邻粗体边界上可能返回
      // bold,bold 等非法 mark 集合；进入 schema 前统一修复并显式校验。
      deduplicateParsedMarkdownMarks(parsed as ParsedMarkdownNode);
      editor.schema.nodeFromJSON(parsed);
      const chain = editor.chain().setContent(parsed, { contentType: 'json' });
      // setContent 只替换文档内容、不改 doc 节点属性：末尾换行需单独写入文档属性（同一事务、不入历史）
      if (editor.schema.topNodeType.spec.attrs?.trailingNewline) {
        const trailing = trailingNewlineOf(markdown);
        chain.command(({ tr }) => {
          if (tr.doc.attrs.trailingNewline !== trailing) tr.setDocAttribute('trailingNewline', trailing);
          return true;
        });
      }
      replaceEditorContent(editor, chain);
      return true;
    }

    // 未装配 MarkdownManager 时保留原兼容路径，配置错误仍由外层容错明确记录。
    replaceEditorContent(
      editor,
      editor.chain().setContent(markdown, {
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
        editor.chain().setContent(
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
