// NoteBoard 行内公式 Markdown 语法（纯函数，无 React / KaTeX 依赖）
// 供 KaTeX 扩展的 tokenizer 与序列化器共用：序列化器位于保存等核心路径，不能引入公式渲染模块。

/** 判断指定公式定界符是否被奇数个反斜杠转义。 */
function isEscapedMathDelimiter(source: string, index: number): boolean {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

/**
 * 查找下一个合法的行内公式起点。
 * 单美元符号后不能是空白或另一个美元符号，避免与块公式和普通金额文本争抢。
 */
export function findInlineMathStart(source: string): number {
  for (let index = 0; index < source.length; index += 1) {
    // LaTeX 的圆括号定界符必须带一个未转义的反斜杠，普通括号与双反斜杠仍是文本。
    if (source[index] === '\\' && source[index + 1] === '(' && !isEscapedMathDelimiter(source, index)) return index;
    if (source[index] !== '$' || isEscapedMathDelimiter(source, index)) continue;
    const next = source[index + 1];
    if (!next || next === '$' || source[index - 1] === '$' || /\s/.test(next)) continue;
    return index;
  }
  return -1;
}

/**
 * 判断一段普通文本若原样写入 Markdown，是否会被行内公式 tokenizer 识别为公式。
 * 序列化时据此决定是否需要把字面量 `$` 转义，避免 `\$x\$` 往返后变成公式。
 */
export function textWouldFormInlineMath(text: string): boolean {
  let offset = 0;
  while (offset < text.length) {
    const start = findInlineMathStart(text.slice(offset));
    if (start < 0) return false;
    if (matchInlineMath(text.slice(offset + start))) return true;
    offset += start + 1;
  }
  return false;
}

/** 行内 `$...$` / `\(...\)` 匹配：不跨行，跳过转义定界符，并保留美元符号的金额边界约束。 */
export function matchInlineMath(source: string): { raw: string; latex: string } | undefined {
  if (findInlineMathStart(source) !== 0) return undefined;

  // 圆括号定界符占两个字符，公式正文不参与 Markdown 转义或标记解析。
  const parenthesized = source.startsWith('\\(');
  const openingLength = parenthesized ? 2 : 1;
  for (let index = openingLength; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\n' || character === '\r') return undefined;
    // 不跨越行内代码边界寻找闭合符，否则金额后的代码 `$HOME` 会被拼成一条伪公式。
    if (character === '`' && source[index - 1] !== '\\') return undefined;
    if (parenthesized) {
      if (character !== '\\' || source[index + 1] !== ')' || isEscapedMathDelimiter(source, index)) continue;
      const latex = source.slice(openingLength, index);
      return latex.trim() ? { raw: source.slice(0, index + 2), latex } : undefined;
    }
    if (character !== '$' || isEscapedMathDelimiter(source, index)) continue;
    // 双美元符号属于块公式；闭合符前不能是空白，后接数字时按金额文本处理。
    if (source[index - 1] === '$' || source[index + 1] === '$' || /\s/.test(source[index - 1])) continue;
    if (/\d/.test(source[index + 1] ?? '')) continue;

    return { raw: source.slice(0, index + 1), latex: source.slice(1, index) };
  }
  return undefined;
}

