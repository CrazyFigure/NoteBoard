// 特殊块起点按一次块解析建立索引，避免每个普通段落重复扫描剩余全文。
import { Marked, Tokenizer, type marked, type Token, type TokensList } from 'marked';

interface BlockContext { source: string; positions: Map<RegExp, number[]> }
const contexts = new WeakMap<object, BlockContext>();

// 只在调用方需要记录源码块间距时临时捕获根 token；会话结束即释放，不在解析器上长期保留整篇词法树。
const sourceTokenCaptures = new WeakMap<object, { tokens?: Token[] }>();

// 中文正文紧邻粗体闭合标记时，把标点视为可闭合边界，例如 **甲）**和**乙）**。
// 只影响两颗星号；三颗星号、下划线及定界符自身仍遵循原规则，避免误拆嵌套标记。
const CJK_BOLD_CLOSING_BOUNDARY = /[\p{P}\p{S}](?=\*\*(?!\*)\p{Script=Han})/gu;
const EMPHASIS_DELIMITER_CHARACTERS = new Set(['*', '_', '\\', '`']);

/**
 * 在 Marked 已保护代码、链接目标与转义内容的判定遮罩中放宽中文粗体闭合边界。
 * 只替换判定用字符，真实源码和 token.text 不变；保持 UTF-16 长度，避免补充平面符号导致位置偏移。
 */
function maskCjkBoldBoundaries(maskedSource: string): string {
  return maskedSource.replace(CJK_BOLD_CLOSING_BOUNDARY, (character) =>
    EMPHASIS_DELIMITER_CHARACTERS.has(character) ? character : 'a'.repeat(character.length),
  );
}

/** 共用已经执行的词法分析结果，避免为了保留空行再解析一遍全文；嵌套会话结束后恢复外层。 */
export function captureMarkdownBlockTokens<T>(parser: object | undefined, parse: () => T): { parsed: T; tokens?: Token[] } {
  if (!parser) return { parsed: parse() };
  const previous = sourceTokenCaptures.get(parser);
  const capture: { tokens?: Token[] } = {};
  sourceTokenCaptures.set(parser, capture);
  try {
    const parsed = parse();
    return { parsed, tokens: capture.tokens };
  } finally {
    if (previous) sourceTokenCaptures.set(parser, previous);
    else sourceTokenCaptures.delete(parser);
  }
}

/**
 * Windows 本地地址中的反斜杠是路径分隔符，不能按 Markdown 标点转义吞掉。
 * 识别规则与宿主系统无关：其他平台打开 Windows 文档时也必须完整保留地址；
 * 用户确认：模糊相对地址仍遵循 Markdown 转义，只有盘符、UNC、file 和点号前缀等明确写法保留。
 */
function preserveLocalDestination(raw: string | undefined, parsed: string): string {
  if (raw === undefined) return parsed;
  const destination = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  const isWindowsPath = /^[a-z]:[\\/]/i.test(destination)
    || /^\\\\/.test(destination)
    || /^file:.*\\/i.test(destination)
    || /^\.{1,2}\\/.test(destination);
  return isWindowsPath ? destination : parsed;
}

/** 独立解析器及嵌套块上下文；Marked 的 start 回调接收当前块原文的剩余后缀。 */
export function createIsolatedMarkdownParser(): typeof marked {
  const instance = new Marked();
  // 统一安装中文强调边界兼容与本地地址保护，避免各节点事后补救已丢失的范围或字符。
  instance.use({
    hooks: {
      // 复用原生强调匹配与代码 / 链接保护，不通过改写正文或事后拆分 marks 猜测加粗范围。
      emStrongMask: maskCjkBoldBoundaries,
    },
    tokenizer: {
      emStrong(source, maskedSource, previousCharacter = '') {
        // 普通正文、斜体及三颗星号直接走原生快速路径，避免为无关内容执行额外字符分类。
        if (!source.startsWith('**') || source[2] === '*') {
          return Tokenizer.prototype.emStrong.call(this, source, maskedSource, previousCharacter) || false;
        }
        const firstCodePoint = source.codePointAt(2);
        const firstCharacter = firstCodePoint === undefined ? '' : String.fromCodePoint(firstCodePoint);
        // 与闭合边界配套：中文后可直接开始标点包裹的粗体，例如 和**（乙）**。
        // 只放宽原生匹配的前侧判定，不插入空格，也不改动真实正文或其它强调定界符。
        const cjkOpening = /\p{Script=Han}$/u.test(previousCharacter) && /[\p{P}\p{S}]/u.test(firstCharacter)
          && !EMPHASIS_DELIMITER_CHARACTERS.has(firstCharacter);
        return Tokenizer.prototype.emStrong.call(this, source, maskedSource, cjkOpening ? ' ' : previousCharacter) || false;
      },
      link(source) {
        const token = Tokenizer.prototype.link.call(this, source);
        if (!token) return false;
        // 用已经通过原分词器校验、截断的 raw 再提取地址，沿用其嵌套括号与标题规则。
        const raw = this.rules.inline.link.exec(token.raw)?.[2]?.trim();
        token.href = preserveLocalDestination(raw, token.href);
        return token;
      },
      def(source) {
        const token = Tokenizer.prototype.def.call(this, source);
        if (!token) return false;
        const raw = this.rules.block.def.exec(token.raw)?.[2]?.trim();
        token.href = preserveLocalDestination(raw, token.href);
        return token;
      },
    },
  });
  const BaseLexer = instance.Lexer;
  class IndexedLexer<ParserOutput = string, RendererOutput = string> extends BaseLexer<ParserOutput, RendererOutput> {
    override lex(source: string): TokensList {
      const tokens = super.lex(source);
      // 嵌套 lex 先完成，根 lex 最后覆盖捕获结果，保证取得的是当前文档的根 token。
      const capture = sourceTokenCaptures.get(instance);
      if (capture) capture.tokens = tokens;
      return tokens;
    }
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
