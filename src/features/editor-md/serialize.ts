// NoteBoard Markdown 序列化
// @tiptap/markdown 入/出 + 基线管理（不变式 I-13/I-14）
// 详见 docs/09-开发路线图.md 7.5
//
// 不变式 I-13: 打开文件后，序列化的结果必须等于磁盘原文（否则"什么都没做就变脏"）
// 不变式 I-14: 打开 → 切 visual → 切 source → tab 不出现脏圆点

import type { Editor } from '@tiptap/core';

// CommonMark 允许反斜杠转义的 ASCII 标点；这些字符前的双反斜杠不能擅自折叠，
// 否则原本可见的反斜杠会在下一次解析时被当成转义符吞掉。
const COMMONMARK_ESCAPABLE_PUNCTUATION = new Set(
  [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'],
);
const TIPTAP_MARKDOWN_SPECIAL_CHARACTERS = new Set(['`', '*', '_', '[', ']', '~']);
// Unicode 标点与符号类别用于发现“可能是转义前缀”的反斜杠，不按具体字符逐项维护。
const UNICODE_PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/u;

interface MarkdownManagerWithEscaper {
  escapeMarkdownSyntax?: (text: string) => string;
  parse?: (markdown: string) => ReturnType<Editor['getJSON']>;
}

/**
 * 转义普通文本中的 Markdown 标记，同时避免把 Windows 路径等安全反斜杠无条件翻倍。
 * 反斜杠仅在行尾或 CommonMark 可转义标点前需要自我转义；字母、数字、中文前可原样保留。
 */
function escapeMarkdownText(text: string): string {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
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
 * 先批量尝试以覆盖绝大多数普通文本；存在真实 Markdown 歧义时再二分缩小范围，
 * 仅保留形成强调、删除线、行内代码、链接等语法所必需的转义。
 */
function removeRedundantMarkdownEscapes(
  markdown: string,
  editor: Editor,
  manager: MarkdownManagerWithEscaper | undefined,
): string {
  if (typeof manager?.parse !== 'function') return markdown;

  const candidates = collectMarkdownCleanupCandidates(markdown);
  if (candidates.length === 0) return markdown;

  const preservesDocument = (candidateMarkdown: string): boolean => {
    try {
      return editor.schema.nodeFromJSON(manager.parse!(candidateMarkdown)).eq(editor.state.doc);
    } catch {
      // 解析器无法验证时必须保留安全输出，不能为了源码美观冒险改变文档结构。
      return false;
    }
  };

  const fullyCleaned = applyMarkdownCleanupCandidates(markdown, candidates);
  if (preservesDocument(fullyCleaned)) return fullyCleaned;
  if (candidates.length === 1) return markdown;

  let output = markdown;
  const cleanRange = (start: number, end: number): void => {
    const range = candidates.slice(start, end);
    const cleaned = applyMarkdownCleanupCandidates(output, range);
    if (preservesDocument(cleaned)) {
      output = cleaned;
      return;
    }
    if (end - start <= 1) return;

    // 先处理右半段，右侧缩短不会影响左半段仍在使用的原始字符偏移。
    const middle = start + Math.floor((end - start) / 2);
    cleanRange(middle, end);
    cleanRange(start, middle);
  };

  const middle = Math.floor(candidates.length / 2);
  cleanRange(middle, candidates.length);
  cleanRange(0, middle);
  return output;
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
        // 必须先还原 amp，确保 `&amp;&gt;` 能在同一轮恢复为 `&>`
        const ampRestored = segment.replace(/&amp;/g, '&');
        const greaterThanRestored = ampRestored.replace(/&gt;/g, (entity, offset: number) => {
          const prefix = linePrefix + ampRestored.slice(0, offset);
          // 行首或列表/引用容器开头的 `>` 会改变 Markdown 块结构，必须继续保留实体
          const isBlockQuoteMarker = /^(?: {0,3}(?:(?:>|[-+*]|\d+[.)])(?:[ \t]+|$)))* {0,3}$/.test(prefix);
          return isBlockQuoteMarker ? entity : '>';
        });

        return greaterThanRestored;
      });
    })
    .join('\n');
}

// ── 序列化器 ──

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
    const manager = (
      editor.storage as unknown as {
        markdown?: { manager?: MarkdownManagerWithEscaper };
      }
    ).markdown?.manager;
    const originalEscaper = manager?.escapeMarkdownSyntax;
    if (manager && typeof originalEscaper === 'function') {
      // TipTap 暂未开放文本转义策略配置；在同步序列化期间临时替换其内部转义器，
      // 只影响普通文本节点，不会误改代码块、行内代码、链接地址或图片路径。
      manager.escapeMarkdownSyntax = escapeMarkdownText;
    }
    try {
      const normalized = normalizeSerializedMarkdown(getMarkdown.call(editor));
      return removeRedundantMarkdownEscapes(normalized, editor, manager);
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

export function parseMarkdown(
  editor: Editor,
  markdown: string,
): void {
  if (markdown.trim() === '') {
    // 空内容同样必须显式控制历史，否则初次打开空文件后可能出现伪撤销步骤
    replaceEditorContent(
      editor,
      editor.chain().clearContent(false),
    );
    return;
  }
  try {
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
