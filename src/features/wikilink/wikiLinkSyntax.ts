// NoteBoard 双向链接语法
// 与 Obsidian / Logseq 兼容的 `[[目标]]`、`[[目标|显示名]]`、`[[目标#标题]]`、`[[#标题]]` 写法，
// 以及嵌入写法 `![[笔记]]`、`![[笔记#标题]]`、`![[图片.png|300]]`。
// 链接只以纯文本形式存在于 Markdown 原文中，不依赖任何额外索引文件：
// 同步、历史记录、其它编辑器打开都只看到标准文本，索引在运行时按需重建。

/** 双链内部文字上限：防止异常长的方括号文本拖慢行内解析 */
export const WIKI_LINK_MAX_LENGTH = 400;

/** 双链的组成部分 */
export interface WikiLinkParts {
  /** 目标笔记（文件名、相对路径或完整路径，可省略扩展名）；为空表示当前文档 */
  target: string;
  /** 目标中的标题锚点（不含 #） */
  heading: string;
  /** 显示名（`|` 之后的部分）；嵌入图片时为显示宽度 */
  alias: string;
}

/** 行首匹配一个完整的 `[[...]]` / `![[...]]`：内部不含方括号与换行，且不能全是空白 */
const WIKI_LINK_AT_START = new RegExp(`^(!?)\\[\\[([^\\[\\]\\r\\n]{1,${WIKI_LINK_MAX_LENGTH}}?)\\]\\]`);

/** 文本中全局匹配 `[[...]]`（用于源码装饰与反向链接扫描） */
const WIKI_LINK_GLOBAL = new RegExp(`\\[\\[([^\\[\\]\\r\\n]{1,${WIKI_LINK_MAX_LENGTH}}?)\\]\\]`, 'g');

/** front matter 的起止行 */
const FRONT_MATTER_OPEN = /^---[ \t]*\r?$/;
const FRONT_MATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*\r?$/;

/** 行内 tokenizer 的起点探测：返回下一个 `[[` 的位置（前面紧跟 `!` 时从 `!` 开始，作为嵌入） */
export function findWikiLinkStart(source: string): number {
  const index = source.indexOf('[[');
  return index > 0 && source[index - 1] === '!' ? index - 1 : index;
}

/** 在文本开头匹配双链，返回原文、内部文字与是否为嵌入 */
export function matchWikiLinkAtStart(source: string): { raw: string; inner: string; embed: boolean } | null {
  const match = WIKI_LINK_AT_START.exec(source);
  if (!match || !match[2].trim()) return null;
  return { raw: match[0], inner: match[2], embed: match[1] === '!' };
}

/**
 * 拆分双链内部文字。
 * 表格中的 `\|` 写法（避免与单元格分隔符冲突）与普通 `|` 等价。
 */
export function parseWikiLinkInner(inner: string): WikiLinkParts {
  const normalized = inner.replace(/\\\|/g, '|');
  const pipeIndex = normalized.indexOf('|');
  const targetPart = pipeIndex >= 0 ? normalized.slice(0, pipeIndex) : normalized;
  const alias = pipeIndex >= 0 ? normalized.slice(pipeIndex + 1).trim() : '';
  const hashIndex = targetPart.indexOf('#');
  const target = (hashIndex >= 0 ? targetPart.slice(0, hashIndex) : targetPart).trim();
  const heading = hashIndex >= 0 ? targetPart.slice(hashIndex + 1).trim() : '';
  return { target, heading, alias };
}

/** 双链在正文中显示的文字：优先显示名，其次「笔记 › 标题」 */
export function wikiLinkLabel(parts: WikiLinkParts): string {
  if (parts.alias) return parts.alias;
  // 目标可能带目录，只显示最后一段，与 Obsidian 一致
  const name = parts.target.split(/[\\/]/).pop() ?? parts.target;
  if (!parts.heading) return name;
  return name ? `${name} › ${parts.heading}` : parts.heading;
}

/** 由组成部分生成内部文字（建议框插入、编辑后写回） */
export function formatWikiLinkInner(parts: WikiLinkParts): string {
  let inner = parts.target;
  if (parts.heading) inner += `#${parts.heading}`;
  if (parts.alias) inner += `|${parts.alias}`;
  return inner;
}

/** 文本中找到的一个双链 */
export interface WikiLinkOccurrence {
  /** 内部文字 */
  inner: string;
  /** 是否为 `![[...]]` 嵌入 */
  embed: boolean;
  /** 在整段文本中的起止偏移（含方括号，嵌入含 `!`） */
  from: number;
  to: number;
  /** 从 0 开始的行号 */
  line: number;
  /** 所在行原文（用于反向链接上下文） */
  lineText: string;
}

/** 遮蔽行内代码：同长度替换为空格，保证偏移不变 */
function maskInlineCode(line: string): string {
  return line.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (code) => ' '.repeat(code.length));
}

/**
 * 提取 Markdown 原文中的全部双链。
 * 跳过 front matter、围栏代码块、行内代码与反斜杠转义的 `\[[`，与可视化模式的解析结果保持一致
 * （结果顺序与可视化文档中双链节点的顺序一致，反向链接据此定位）。
 */
export function extractWikiLinks(markdown: string): WikiLinkOccurrence[] {
  const result: WikiLinkOccurrence[] = [];
  // 快速路径：绝大多数文档没有双链
  if (!markdown.includes('[[')) return result;
  const lines = markdown.split('\n');
  let offset = 0;
  // 当前所处围栏的标记字符与长度（null 表示不在围栏内）
  let fence: { char: string; size: number } | null = null;
  // 文首 front matter（YAML 元数据）不是正文，可视化模式同样不解析其中的方括号
  let frontMatterEnd = -1;
  if (FRONT_MATTER_OPEN.test(lines[0] ?? '')) {
    frontMatterEnd = lines.findIndex((line, index) => index > 0 && FRONT_MATTER_CLOSE.test(line));
  }
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (lineIndex <= frontMatterEnd) {
      offset += line.length + 1;
      continue;
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { char: marker[0], size: marker.length };
      } else if (marker[0] === fence.char && marker.length >= fence.size && !line.slice(fenceMatch[0].length).trim()) {
        fence = null;
      }
      offset += line.length + 1;
      continue;
    }
    if (!fence && line.includes('[[')) {
      const masked = maskInlineCode(line);
      WIKI_LINK_GLOBAL.lastIndex = 0;
      for (let match = WIKI_LINK_GLOBAL.exec(masked); match; match = WIKI_LINK_GLOBAL.exec(masked)) {
        if (!match[1].trim()) continue;
        // 反斜杠转义的 `\[[` 是普通文字
        if (match.index > 0 && masked[match.index - 1] === '\\') continue;
        const embed = match.index > 0 && masked[match.index - 1] === '!';
        result.push({
          inner: match[1],
          embed,
          from: offset + match.index - (embed ? 1 : 0),
          to: offset + match.index + match[0].length,
          line: lineIndex,
          lineText: line.replace(/\r$/, ''),
        });
      }
    }
    offset += line.length + 1;
  }
  return result;
}

/**
 * 截取嵌入的标题小节：从匹配的标题行到下一个同级或更高级标题之前。
 * 找不到标题时返回 null。
 */
export function extractHeadingSection(markdown: string, heading: string): string | null {
  const lines = markdown.split('\n');
  const wanted = heading.trim().toLowerCase();
  let start = -1;
  let level = 0;
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/.exec(line);
    if (!match) continue;
    if (start < 0) {
      if (match[2].trim().toLowerCase() === wanted) {
        start = index;
        level = match[1].length;
      }
    } else if (match[1].length <= level) {
      return lines.slice(start, index).join('\n');
    }
  }
  return start < 0 ? null : lines.slice(start).join('\n');
}

/** 去掉文首 front matter（嵌入整篇笔记时不显示元数据） */
export function stripFrontMatter(markdown: string): string {
  const lines = markdown.split('\n');
  if (!FRONT_MATTER_OPEN.test(lines[0] ?? '')) return markdown;
  const end = lines.findIndex((line, index) => index > 0 && FRONT_MATTER_CLOSE.test(line));
  return end > 0 ? lines.slice(end + 1).join('\n').replace(/^\s*\n/, '') : markdown;
}
