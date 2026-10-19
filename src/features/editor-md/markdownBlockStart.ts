// 特殊块起点按一次块解析建立索引，避免每个普通段落重复扫描剩余全文。
import { Marked, type marked, type Token, type TokensList } from 'marked';

interface BlockContext { source: string; positions: Map<RegExp, number[]> }
const contexts = new WeakMap<object, BlockContext>();

/** 独立解析器及嵌套块上下文；Marked 的 start 回调接收当前块原文的剩余后缀。 */
export function createIsolatedMarkdownParser(): typeof marked {
  const instance = new Marked();
  const BaseLexer = instance.Lexer;
  class IndexedLexer<ParserOutput = string, RendererOutput = string> extends BaseLexer<ParserOutput, RendererOutput> {
    // 保留 Marked 的两种重载及泛型，普通 token 数组和带 links 的根列表都按原类型返回。
    override blockTokens(source: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[];
    override blockTokens(source: string, tokens?: TokensList, lastParagraphClipped?: boolean): TokensList;
    override blockTokens(source: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[] {
      const previous = contexts.get(this);
      contexts.set(this, { source, positions: new Map() });
      try { return super.blockTokens(source, tokens, lastParagraphClipped); }
      finally {
        if (previous) contexts.set(this, previous);
        else contexts.delete(this);
      }
    }
  }
  instance.Lexer = IndexedLexer;
  instance.lexer = (source, options) => new IndexedLexer(options ?? instance.defaults).lex(source);
  // TipTap 沿用全局 marked 的可调用类型，实际消费的 Lexer/lexer/use API 与独立实例一致。
  return instance as unknown as typeof marked;
}

/**
 * 起点正则每次块解析只扫描全文一次，后续通过二分查找定位。
 * 当前后缀第一行另行校验：marked 使用 slice(1) 探测中断，不能漏掉裁去首字符后出现的起点。
 */
export function createIndexedBlockStart(pattern: RegExp): (source: string) => number {
  return function (this: { lexer?: object } | void, source: string): number {
    const context = this?.lexer ? contexts.get(this.lexer) : undefined;
    const flags = pattern.flags.replace(/[gy]/g, '');
    const regex = new RegExp(pattern.source, flags);
    if (!context || source.length > context.source.length) {
      const match = regex.exec(source);
      return match ? match.index + (match[0].startsWith('\n') ? 1 : 0) : -1;
    }
    const offset = context.source.length - source.length;
    let positions = context.positions.get(pattern);
    if (!positions) {
      positions = [];
      const scan = new RegExp(pattern.source, `${flags}g`);
      let match: RegExpExecArray | null;
      while ((match = scan.exec(context.source))) {
        positions.push(match.index + (match[0].startsWith('\n') ? 1 : 0));
        // 起点可能消费尾部换行，下一次允许从该匹配内部继续查找，不能漏掉相邻块。
        scan.lastIndex = match.index + 1;
      }
      context.positions.set(pattern, positions);
    }
    const firstEnd = source.indexOf('\n');
    const secondEnd = firstEnd < 0 ? -1 : source.indexOf('\n', firstEnd + 1);
    const head = source.slice(0, secondEnd < 0 ? source.length : secondEnd + 1);
    const firstMatch = regex.exec(head);
    const first = firstMatch?.index === 0 ? (firstMatch[0].startsWith('\n') ? 1 : 0) : -1;
    let left = 0;
    let right = positions.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (positions[middle] < offset) left = middle + 1;
      else right = middle;
    }
    const indexed = left < positions.length ? positions[left] - offset : -1;
    return first >= 0 && (indexed < 0 || first < indexed) ? first : indexed;
  };
}
