// NoteBoard 原样保留的 Markdown 片段登记表
// Front matter、块级 HTML、脚注等节点需要逐字节原样输出；但序列化后还有两道全文后处理
// （实体还原 normalizeSerializedMarkdown、冗余转义清理），它们会误改这些原文（如 `&amp;` → `&`）。
// 因此在一次同步序列化期间，原样片段先以占位符输出，后处理结束后再替换回原文。
// 不在序列化会话内（例如第三方直接调用 getMarkdown）时，节点直接输出原文。

const PLACEHOLDER_OPEN = '';
const PLACEHOLDER_CLOSE = '';
const PLACEHOLDER_PATTERN = /(\d+)/g;

let activeSegments: string[] | null = null;

/** 开启一次序列化会话（同步调用，结束后必须调用 endRawSegmentSession）。 */
export function beginRawSegmentSession(): void {
  activeSegments = [];
}

/** 结束序列化会话并返回登记的片段。 */
export function endRawSegmentSession(): string[] {
  const segments = activeSegments ?? [];
  activeSegments = null;
  return segments;
}

/**
 * 节点 renderMarkdown 调用：会话内返回占位符，会话外直接返回原文。
 * 按行分别登记：节点位于引用/列表中时，父节点会给每一行加前缀，逐行占位才能保证前缀落在正确位置。
 */
export function emitRawSegment(text: string): string {
  const segments = activeSegments;
  if (!segments) return text;
  return text
    .split('\n')
    .map((line) => {
      segments.push(line);
      return `${PLACEHOLDER_OPEN}${segments.length - 1}${PLACEHOLDER_CLOSE}`;
    })
    .join('\n');
}

/** 把占位符替换回原文（片段缺失时保留空字符串，避免输出私有区字符）。 */
export function restoreRawSegments(markdown: string, segments: readonly string[]): string {
  if (segments.length === 0) return markdown;
  return markdown.replace(PLACEHOLDER_PATTERN, (_match, index: string) => segments[Number(index)] ?? '');
}
