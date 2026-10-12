// NoteBoard「HTML div 块 + 空行包裹 Markdown」写法的公共解析工具
// 分栏卡片、高亮块共用：在源码行中查找与开始标签配对的 `</div>` 行，
// 跳过代码围栏内的文本，并按嵌套的 div 开始/结束标签计数。

/** 独占一行的 div 结束标签（标准写法，逐字匹配） */
export const DIV_CLOSE_TAG = '</div>';
// 嵌套计数：统计行内出现的 div 开始/结束标签（含正文中的手写 HTML），保证与正确的 </div> 配对
const DIV_OPEN_TAG = /<div[\s>]/gi;
const DIV_CLOSE_TAG_PATTERN = /<\/div\s*>/gi;
// 代码围栏起止：围栏内的 </div> 文本不参与配对
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/** 统计一行中某类标签的出现次数 */
function countMatches(line: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return line.match(pattern)?.length ?? 0;
}

/** 判断某行是否闭合了给定的代码围栏（同字符、长度不短于开启围栏） */
function closesFence(line: string, fence: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence[0] && match[1].length >= fence.length);
}

/**
 * 从 lines[start] 开始查找与当前 div 配对的 `</div>` 行号（跳过代码围栏与嵌套 div）；
 * 结构不符合标准写法时返回 -1。
 */
export function findDivClose(lines: string[], start: number): number {
  let depth = 0;
  let fence: string | null = null;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const fenceOpen = FENCE_OPEN_PATTERN.exec(line);
    if (fenceOpen) {
      fence = fenceOpen[1];
      continue;
    }
    // 同层的结束标签必须独占一行且无缩进、无多余空白
    if (depth === 0 && line === DIV_CLOSE_TAG) return index;
    depth += countMatches(line, DIV_OPEN_TAG) - countMatches(line, DIV_CLOSE_TAG_PATTERN);
    // 出现多余的结束标签说明结构不是标准写法
    if (depth < 0) return -1;
  }
  return -1;
}

/**
 * 读取「开始标签 + 空行 + 正文 + 空行 + 结束标签」中的正文：
 * lines[openIndex] 为开始标签，返回正文与结束标签行号；结构不符时返回 null。
 * 空正文写作「开始标签 + 空行 + 结束标签」。
 */
export function readDivBody(lines: string[], openIndex: number): { body: string; closeIndex: number } | null {
  // 开始标签后必须是一个空行（空行允许含空白：列表内序列化会给空行补缩进）
  if (openIndex + 1 >= lines.length || lines[openIndex + 1].trim() !== '') return null;
  const bodyStart = openIndex + 2;
  const closeIndex = findDivClose(lines, bodyStart);
  if (closeIndex < 0) return null;

  const between = lines.slice(bodyStart, closeIndex);
  let body = '';
  if (between.length > 0) {
    // 非空正文与结束标签之间必须恰有一个空行
    if (between.length < 2 || between[between.length - 1].trim() !== '') return null;
    body = between.slice(0, -1).join('\n');
    if (body.trim() === '') return null;
  }
  return { body, closeIndex };
}
