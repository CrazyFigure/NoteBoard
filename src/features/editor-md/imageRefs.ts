// NoteBoard Markdown 原文图片引用扫描与改写
// 识别 `![alt](src "title")`、`![alt](<src>)`、`<img src="...">` 三种写法，
// 跳过 front matter、围栏代码块、缩进代码块与行内代码（规则与 wikiLinkSyntax.extractWikiLinks 保持一致），
// 只返回本地路径；改写时只替换地址片段，原文其余部分保持不变。

import { escapeHtmlAttribute, formatMarkdownDestination } from './imageCore';
import { relativePathBetween, sameKey } from '../explorer/pathUtils';
import { resolveRelativeDocPath } from './linkHandler';

/** 原文中的一处图片引用 */
export interface ImageRef {
  /** 地址片段在整段原文中的起止偏移（Markdown 写法含尖括号，HTML 写法不含引号） */
  from: number;
  to: number;
  /** 解码后的图片地址（与可视化模式图片节点的 src 一致） */
  src: string;
  /** 引用写法 */
  syntax: 'markdown' | 'html';
  /** HTML 写法的引号字符（无引号为空串） */
  quote: string;
}

/** 列表项起始行（无序 / 有序），其后的缩进行是列表续段而非缩进代码块 */
const LIST_ITEM_START = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
/** front matter 的起止行 */
const FRONT_MATTER_OPEN = /^---[ \t]*\r?$/;
const FRONT_MATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*\r?$/;
/** 带协议的地址（http:、data:、asset: 等）：除 file: 外都不属于本地图片 */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** 标题后缀：紧接地址的空白 + 三种定界符之一 + 结束括号 */
const TITLE_SUFFIX = /^[ \t]+("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\((?:\\.|[^()\\\r\n])*\))[ \t]*\)/;
/** HTML img 标签中的 src 属性 */
const HTML_IMG_SRC = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** 遮蔽行内代码：同长度替换为空格，保证偏移不变 */
function maskInlineCode(line: string): string {
  return line.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (code) => ' '.repeat(code.length));
}

/** 解码 HTML 属性中常见的字符实体 */
function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 是否为本地图片地址（相对路径、绝对路径、file:// 地址） */
export function isLocalImageSrc(src: string): boolean {
  const trimmed = src.trim();
  // 空地址与页内锚点不是图片文件
  if (!trimmed || trimmed.startsWith('#')) return false;
  if (/^file:/i.test(trimmed)) return true;
  // Windows 盘符路径（C:\ / C:/）形似协议，需先放行
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  return !URL_SCHEME.test(trimmed);
}

/**
 * 在一行中解析从 start（指向 `![`）开始的 Markdown 图片，返回地址片段的行内偏移与地址。
 * 支持替代文字中的嵌套方括号、尖括号地址与带空格的裸地址（与 imageCore.tokenizeImageWithSpaces 兼容）。
 */
function parseMarkdownImageAt(line: string, start: number): { from: number; to: number; src: string; end: number } | null {
  let depth = 1;
  let index = start + 2;
  for (; index < line.length && depth > 0; index += 1) {
    const character = line[index];
    if (character === '\\') index += 1;
    else if (character === '[') depth += 1;
    else if (character === ']') depth -= 1;
  }
  if (depth !== 0 || line[index] !== '(') return null;
  index += 1;
  while (line[index] === ' ' || line[index] === '\t') index += 1;
  const from = index;
  // 尖括号地址：到第一个未转义的 `>` 为止
  if (line[index] === '<') {
    const close = line.indexOf('>', index + 1);
    if (close < 0) return null;
    const rest = line.slice(close + 1);
    // 尖括号后只能跟可选标题与结束括号
    const suffix = TITLE_SUFFIX.exec(rest) ?? /^[ \t]*\)/.exec(rest);
    if (!suffix) return null;
    return { from, to: close + 1, src: line.slice(index + 1, close), end: close + 1 + suffix[0].length };
  }
  // 裸地址：括号配平，遇到「空白 + 标题 + )」或未配平的 `)` 结束
  let parentheses = 0;
  for (; index < line.length; index += 1) {
    const character = line[index];
    if (parentheses === 0 && (character === ' ' || character === '\t')) {
      const titleMatch = TITLE_SUFFIX.exec(line.slice(index));
      if (titleMatch) {
        const to = index;
        return { from, to, src: line.slice(from, to).trimEnd(), end: index + titleMatch[0].length };
      }
    }
    if (character === '\\') {
      index += 1;
    } else if (character === '(') {
      parentheses += 1;
    } else if (character === ')') {
      if (parentheses === 0) {
        // 去掉地址末尾空白，改写时不影响原有空白
        const raw = line.slice(from, index);
        const trimmed = raw.trimEnd();
        return { from, to: from + trimmed.length, src: trimmed, end: index + 1 };
      }
      parentheses -= 1;
    }
  }
  return null;
}

/** 扫描一行（已遮蔽行内代码）中的全部图片引用 */
function scanLine(masked: string, original: string, offset: number, result: ImageRef[]): void {
  // Markdown 写法
  let searchFrom = 0;
  while (searchFrom < masked.length) {
    const start = masked.indexOf('![', searchFrom);
    if (start < 0) break;
    // 反斜杠转义的 `\![` 是普通文字
    if (start > 0 && masked[start - 1] === '\\') {
      searchFrom = start + 2;
      continue;
    }
    const parsed = parseMarkdownImageAt(masked, start);
    if (!parsed) {
      searchFrom = start + 2;
      continue;
    }
    // 偏移基于遮蔽行，地址文字取原行（遮蔽只替换行内代码，图片地址本身不受影响）
    const src = original.slice(parsed.from, parsed.to);
    const decoded = src.startsWith('<') && src.endsWith('>') ? src.slice(1, -1) : src;
    if (decoded && isLocalImageSrc(decoded)) {
      result.push({ from: offset + parsed.from, to: offset + parsed.to, src: decoded, syntax: 'markdown', quote: '' });
    }
    searchFrom = parsed.end;
  }
  // HTML 写法
  if (!/<img\b/i.test(masked)) return;
  HTML_IMG_SRC.lastIndex = 0;
  for (let match = HTML_IMG_SRC.exec(masked); match; match = HTML_IMG_SRC.exec(masked)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    const quote = match[1] !== undefined ? '"' : match[2] !== undefined ? "'" : '';
    const valueEnd = match.index + match[0].length - (quote ? 1 : 0);
    const valueStart = valueEnd - value.length;
    const src = decodeHtmlAttribute(original.slice(valueStart, valueEnd));
    if (src && isLocalImageSrc(src)) {
      result.push({ from: offset + valueStart, to: offset + valueEnd, src, syntax: 'html', quote });
    }
  }
}

/** 提取 Markdown 原文中的全部本地图片引用（按出现顺序） */
export function scanImageRefs(markdown: string): ImageRef[] {
  const result: ImageRef[] = [];
  // 快速路径：没有任何图片语法
  if (!markdown.includes('![') && !/<img\b/i.test(markdown)) return result;
  const lines = markdown.split('\n');
  let offset = 0;
  // 当前所处围栏的标记字符与长度（null 表示不在围栏内）
  let fence: { char: string; size: number } | null = null;
  let frontMatterEnd = -1;
  if (FRONT_MATTER_OPEN.test(lines[0] ?? '')) {
    frontMatterEnd = lines.findIndex((line, index) => index > 0 && FRONT_MATTER_CLOSE.test(line));
  }
  // 缩进代码块（空行后缩进 4 格 / 制表符）：列表内的缩进是续段，不是代码
  let inIndentedCode = false;
  let inList = false;
  let previousBlank = true;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const lineOffset = offset;
    offset += line.length + 1;
    if (lineIndex <= frontMatterEnd) continue;
    if (!fence) {
      const blank = !line.trim();
      const indented = /^(?: {4}|\t)/.test(line);
      if (inIndentedCode && (blank || indented)) {
        previousBlank = blank;
        continue;
      }
      inIndentedCode = false;
      if (indented && !blank && previousBlank && !inList) {
        inIndentedCode = true;
        previousBlank = false;
        continue;
      }
      if (LIST_ITEM_START.test(line)) inList = true;
      else if (!blank && !/^\s/.test(line)) inList = false;
      previousBlank = blank;
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { char: marker[0], size: marker.length };
      } else if (marker[0] === fence.char && marker.length >= fence.size && !line.slice(fenceMatch[0].length).trim()) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;
    if (!line.includes('![') && !/<img\b/i.test(line)) continue;
    scanLine(maskInlineCode(line), line, lineOffset, result);
  }
  return result;
}

/** 按引用原写法格式化新地址：Markdown 写法必要时加尖括号，HTML 写法转义属性值 */
export function formatImageRefSrc(ref: ImageRef, src: string): string {
  if (ref.syntax === 'markdown') return formatMarkdownDestination(src);
  if (ref.quote === "'") return escapeHtmlAttribute(src).replace(/'/g, '&#39;');
  if (ref.quote === '"') return escapeHtmlAttribute(src);
  // 原本无引号的属性值改写后可能含空白，统一补上双引号由调用方处理
  return /[\s"'>]/.test(src) ? `"${escapeHtmlAttribute(src)}"` : src;
}

/**
 * 按「原地址 → 新地址」改写原文中的图片引用，返回改写后的原文与改写处数。
 * replacements 的键为解码后的原地址；只改写命中的引用。
 */
export function rewriteImageRefs(markdown: string, replacements: Map<string, string>): { text: string; count: number } {
  return replaceImageRefs(markdown, (src) => replacements.get(src));
}

/** 只改地址片段，从后往前替换以保持前面的原文偏移。 */
function replaceImageRefs(markdown: string, replacementFor: (src: string) => string | undefined): { text: string; count: number } {
  let text = markdown;
  let count = 0;
  for (const ref of scanImageRefs(markdown).reverse()) {
    const next = replacementFor(ref.src);
    if (next === undefined || next === ref.src) continue;
    text = text.slice(0, ref.from) + formatImageRefSrc(ref, next) + text.slice(ref.to);
    count += 1;
  }
  return { text, count };
}

/** 笔记的基准目录变化后，按新目录重写图片地址，继续引用原来已落盘的文件。 */
export function rebaseImageRefs(markdown: string, fromDir: string, toDir: string): string {
  if (sameKey(fromDir, toDir)) return markdown;
  return replaceImageRefs(markdown, (src) => {
    // 根路径、盘符与 file URL 已经有固定位置，无需跟随目录变化。
    if (/^(?:[\\/]|[a-z]:[\\/]|file:)/i.test(src)) return undefined;
    const absolute = resolveRelativeDocPath(fromDir, src);
    const relative = relativePathBetween(toDir, absolute);
    // Windows 跨盘无法构造相对路径，保留原文件的绝对地址，避免生成指向另一张图的链接。
    const path = relative === null ? absolute.replace(/\\/g, '/') : relative;
    const destination = relative !== null && !path.startsWith('../') ? `./${path}` : path;
    // 路径解析时会解码百分号，重写时保护真实文件名里的百分号。
    return destination.replace(/%/g, '%25');
  }).text;
}
