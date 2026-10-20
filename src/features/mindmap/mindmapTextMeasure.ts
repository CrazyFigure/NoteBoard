// NoteBoard 思维导图文字度量与自动换行
// 布局引擎、画布 DOM 渲染与图片导出共用同一套字号 / 行高 / 内边距与断行结果，
// 保证三处的节点尺寸与换行位置完全一致。
// 详见 docs/09-开发路线图.md

/** 单行文本及其在原文中的起始偏移（用于搜索高亮按行切分） */
export interface TextLine {
  text: string;
  start: number;
}

/** 文本宽度测量函数：font 为 canvas 字体串（如 `500 13px "Microsoft YaHei"`） */
export type TextMeasure = (text: string, font: string) => number;

/** 节点标题的排版参数（按层级区分） */
export interface NodeTextStyle {
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  /** 水平内缩（内边距 + 边框） */
  insetX: number;
  /** 垂直内缩（内边距 + 边框） */
  insetY: number;
  /** 内边距（不含边框，供 DOM padding 使用） */
  paddingX: number;
  paddingY: number;
  minWidth: number;
  minHeight: number;
  /** 前置图标字号与其占用的总宽度（含左右留白） */
  iconSize: number;
  iconWidth: number;
}

/** 备注区排版参数 */
export const NOTE_FONT_SIZE = 11;
export const NOTE_LINE_HEIGHT = 16;
/** 备注区上方间距 + 分隔线 + 内边距 */
export const NOTE_TOP_GAP = 7;
/** 备注最多展示行数 */
export const NOTE_MAX_LINES = 8;
/** 图片缩略图区占用高度（上边距 + 缩略图 + 边框） */
export const IMAGE_BLOCK_HEIGHT = 60;
/** 挂载图片的节点最小宽度 */
export const IMAGE_MIN_WIDTH = 160;
/** 非根节点边框宽度 */
export const NODE_BORDER_WIDTH = 1.5;

/** 节点宽度设置的默认值与可选范围 */
export const DEFAULT_MINDMAP_NODE_MAX_WIDTH = 280;
export const MIN_MINDMAP_NODE_MAX_WIDTH = 160;
export const MAX_MINDMAP_NODE_MAX_WIDTH = 600;
/** 手动拉伸宽度的上下限 */
export const MIN_MANUAL_NODE_WIDTH = 80;
export const MAX_MANUAL_NODE_WIDTH = 1200;

/** 未取到页面字体时的兜底字体族 */
export const FALLBACK_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';

const ROOT_STYLE: NodeTextStyle = {
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 20,
  insetX: 12,
  insetY: 6,
  paddingX: 12,
  paddingY: 6,
  minWidth: 120,
  minHeight: 44,
  iconSize: 18,
  iconWidth: 26,
};

const LEVEL1_STYLE: NodeTextStyle = {
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 19,
  insetX: 10 + NODE_BORDER_WIDTH,
  insetY: 5 + NODE_BORDER_WIDTH,
  paddingX: 10,
  paddingY: 5,
  minWidth: 90,
  minHeight: 36,
  iconSize: 14,
  iconWidth: 22,
};

const DEFAULT_STYLE: NodeTextStyle = {
  ...LEVEL1_STYLE,
  fontSize: 12,
  fontWeight: 400,
  lineHeight: 18,
};

/** 按层级取节点标题排版参数 */
export function getNodeTextStyle(level: number): NodeTextStyle {
  if (level === 0) return ROOT_STYLE;
  if (level === 1) return LEVEL1_STYLE;
  return DEFAULT_STYLE;
}

/** 拼装 canvas 字体串 */
export function buildFont(fontSize: number, fontWeight: number, fontFamily: string, italic = false): string {
  return `${italic ? 'italic ' : ''}${fontWeight} ${fontSize}px ${fontFamily || FALLBACK_FONT_FAMILY}`;
}

/** 富文本断行参数：按字符下标取字体，并给出格式切换的边界 */
export interface RichFontSpec {
  fontAt: (index: number) => string;
  boundaries: readonly number[];
}

/** 把设置中的最大宽度收敛到合法范围 */
export function clampNodeMaxWidth(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MINDMAP_NODE_MAX_WIDTH;
  return Math.min(MAX_MINDMAP_NODE_MAX_WIDTH, Math.max(MIN_MINDMAP_NODE_MAX_WIDTH, Math.round(value)));
}

/** 全角字符（中日韩文字、全角标点、Emoji 等）按 1em 宽处理 */
const WIDE_CHAR_RE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F000}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}]/u;

/** 可在任意字符间断行的文字（中日韩） */
const CJK_BREAK_RE =
  /[⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠]|[\u{20000}-\u{3FFFD}]/u;

/** 从字体串中解析字号，解析失败按 12px */
function parseFontSize(font: string): number {
  const match = font.match(/(\d+(?:\.\d+)?)px/);
  return match ? Number(match[1]) : 12;
}

/**
 * 无 canvas 环境（单元测试 / SSR）下的估算测量：
 * 全角字符 1em，其余字符 0.6em
 */
export const estimateTextWidth: TextMeasure = (text, font) => {
  const size = parseFontSize(font);
  let width = 0;
  for (const ch of text) {
    width += WIDE_CHAR_RE.test(ch) ? size : size * 0.6;
  }
  return width;
};

/** 测量缓存上限，超出后整体清空，避免长时间编辑内存增长 */
const MEASURE_CACHE_LIMIT = 8000;

/**
 * 创建基于 canvas measureText 的测量函数（带缓存）
 * 取不到 2D 上下文时退回估算测量
 */
export function createTextMeasurer(): TextMeasure {
  let ctx: CanvasRenderingContext2D | null = null;
  let resolved = false;
  const cache = new Map<string, number>();

  return (text, font) => {
    if (!text) return 0;
    if (!resolved) {
      resolved = true;
      try {
        // jsdom 未实现 canvas 时 getContext 会打印错误，提前按 UA 跳过
        const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
        if (!isJsdom && typeof document !== 'undefined') {
          ctx = document.createElement('canvas').getContext('2d');
        }
      } catch {
        ctx = null;
      }
    }
    if (!ctx) return estimateTextWidth(text, font);

    const key = `${font}\u0000${text}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (cache.size >= MEASURE_CACHE_LIMIT) cache.clear();
    ctx.font = font;
    const width = ctx.measureText(text).width;
    cache.set(key, width);
    return width;
  };
}

let sharedMeasurer: TextMeasure | null = null;

/** 画布渲染与图片导出共用的测量函数（共享缓存） */
export function getSharedTextMeasurer(): TextMeasure {
  if (!sharedMeasurer) sharedMeasurer = createTextMeasurer();
  return sharedMeasurer;
}

/** 断行单元：空白串 / 连续拉丁单词 / 单个中日韩字符 */
interface Token {
  text: string;
  start: number;
  isSpace: boolean;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let current: Token | null = null;
  for (const ch of text) {
    const isSpace = /\s/.test(ch);
    const isCjk = !isSpace && CJK_BREAK_RE.test(ch);
    if (isCjk) {
      if (current) tokens.push(current);
      tokens.push({ text: ch, start: offset, isSpace: false });
      current = null;
    } else if (current && current.isSpace === isSpace) {
      current.text += ch;
    } else {
      if (current) tokens.push(current);
      current = { text: ch, start: offset, isSpace };
    }
    offset += ch.length;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * 按最大宽度把文本断成多行
 * 中日韩字符逐字可断，拉丁单词整体换行，单个单词超宽时再按字符拆分；
 * 行首空白被吞掉，行尾空白保留在原行（不计入换行判定）；
 * 文本中的 \n 为硬换行（节点内手动换行），空段落保留为空行
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: TextMeasure,
  font: string,
  rich?: RichFontSpec,
): TextLine[] {
  if (!text) return [{ text: '', start: 0 }];
  const limit = Math.max(1, maxWidth);
  const measureAt = createRangeMeasure(text, measure, font, rich);
  const lines: TextLine[] = [];
  // 按硬换行切段，各段独立断行，行起点仍为原文下标
  let segStart = 0;
  for (const seg of text.split('\n')) {
    wrapSegment(seg, segStart, limit, measureAt, lines);
    segStart += seg.length + 1;
  }
  return lines;
}

/** 对不含硬换行的一段文本断行，结果追加到 lines；offset 为该段在原文中的起点 */
function wrapSegment(
  segment: string,
  offset: number,
  limit: number,
  measureAt: (start: number, end: number) => number,
  lines: TextLine[],
) {
  const firstIndex = lines.length;
  let lineText = '';
  let lineStart = offset;
  let lineWidth = 0;

  const pushLine = () => {
    lines.push({ text: lineText.replace(/\s+$/, ''), start: lineStart });
    lineText = '';
    lineWidth = 0;
  };

  for (const rawToken of tokenize(segment)) {
    const token = { ...rawToken, start: rawToken.start + offset };
    if (token.isSpace) {
      // 行首空白直接丢弃
      if (!lineText) continue;
      lineText += token.text;
      lineWidth += measureAt(token.start, token.start + token.text.length);
      continue;
    }

    const tokenWidth = measureAt(token.start, token.start + token.text.length);
    if (lineText && lineWidth + tokenWidth > limit) {
      pushLine();
    }

    if (tokenWidth <= limit) {
      if (!lineText) lineStart = token.start;
      lineText += token.text;
      lineWidth += tokenWidth;
      continue;
    }

    // 超长单词：逐字符填充
    let cursor = token.start;
    for (const ch of token.text) {
      const chWidth = measureAt(cursor, cursor + ch.length);
      if (lineText && lineWidth + chWidth > limit) pushLine();
      if (!lineText) lineStart = cursor;
      lineText += ch;
      lineWidth += chWidth;
      cursor += ch.length;
    }
  }

  // 空段落（连续或末尾换行）也占一行
  if (lineText || lines.length === firstIndex) pushLine();
}

/**
 * 生成区间测量函数：富文本时在格式边界处拆分，各段用各自字体测量后求和
 */
export function createRangeMeasure(
  text: string,
  measure: TextMeasure,
  font: string,
  rich?: RichFontSpec,
): (start: number, end: number) => number {
  if (!rich || rich.boundaries.length === 0) {
    return (start, end) => measure(text.slice(start, end), font);
  }
  return (start, end) => {
    let width = 0;
    let cursor = start;
    for (const b of rich.boundaries) {
      if (b <= cursor) continue;
      if (b >= end) break;
      width += measure(text.slice(cursor, b), rich.fontAt(cursor));
      cursor = b;
    }
    width += measure(text.slice(cursor, end), rich.fontAt(cursor));
    return width;
  };
}

/** 文本单行自然宽度（多段换行取最长一段） */
export function measureNaturalWidth(text: string, measure: TextMeasure, font: string): number {
  if (!text) return 0;
  return Math.max(...text.split('\n').map((seg) => measure(seg, font)), 0);
}

/**
 * 末行超出时截断并补省略号，保证不超过 maxWidth
 */
export function ellipsizeLine(text: string, maxWidth: number, measure: TextMeasure, font: string): string {
  const ellipsis = '…';
  if (measure(text + ellipsis, font) <= maxWidth) return text + ellipsis;
  const chars = Array.from(text);
  while (chars.length > 0 && measure(chars.join('') + ellipsis, font) > maxWidth) {
    chars.pop();
  }
  return chars.join('') + ellipsis;
}
