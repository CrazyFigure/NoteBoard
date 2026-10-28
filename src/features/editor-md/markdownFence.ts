// NoteBoard Markdown 代码围栏工具
// 统一代码块与图表块（Mermaid / Infographic / PlantUML）的围栏序列化与解析，
// 保证内容中出现 ``` 时围栏不被提前闭合，且图表块不会因缺少序列化器而在保存时丢失。

import type { JSONContent, MarkdownParseHelpers, MarkdownToken } from '@tiptap/core';
import { emitRawSegment } from './rawMarkdownSegments';

/**
 * 在源码打开时直接还原为可视化预览块的围栏语言。
 * PlantUML 依赖远程渲染服务，打开他人文档时不自动转换，避免未经确认就把内容发送到外部服务器；
 * 它仅在序列化时输出为 ```plantuml 围栏，重新打开后以普通代码块呈现。
 */
export const PREVIEW_FENCE_LANGUAGES: Record<string, 'mermaidBlock' | 'infographicBlock'> = {
  mermaid: 'mermaidBlock',
  infographic: 'infographicBlock',
};

/**
 * 内容中位于行首（缩进不超过 3 个空格）的最长连续围栏字符串长度。
 * 按 CommonMark，只有这样的行才可能闭合围栏；行中间的 ``` （如字符串字面量里的）不会提前闭合代码块，
 * 因此不计入，避免无谓地加长围栏。
 */
function longestLineStartRun(code: string, character: '`' | '~'): number {
  const pattern = character === '`' ? /^ {0,3}(`+)/gm : /^ {0,3}(~+)/gm;
  let longest = 0;
  for (const match of code.matchAll(pattern)) {
    if (match[1].length > longest) longest = match[1].length;
  }
  return longest;
}

/** 计算能安全包裹内容的反引号围栏：长度为内容中行首最长连续反引号 + 1，且不少于 3。 */
export function fenceFor(code: string): string {
  return '`'.repeat(Math.max(3, longestLineStartRun(code, '`') + 1));
}

/** 判断原文围栏能否继续安全包裹当前内容（内容中没有可能提前闭合它的行）。 */
function isUsableFence(fence: string | null | undefined, code: string): fence is string {
  if (!fence || !/^(?:`{3,}|~{3,})$/.test(fence)) return false;
  return longestLineStartRun(code, fence[0] as '`' | '~') < fence.length;
}

/**
 * 把代码文本包装为围栏代码块；空内容保持与 TipTap 原实现一致的空行格式。
 * preferredFence 为原文使用的围栏（如 ```` 或 ~~~）：仍能安全包裹内容时沿用，避免仅因进入可视化就改写源码。
 */
export function renderFencedCode(language: string, code: string, preferredFence?: string | null): string {
  const fence = isUsableFence(preferredFence, code) ? preferredFence : fenceFor(code);
  if (code === '') return `${fence}${language}\n\n${fence}`;
  // 代码正文必须逐字保留；引用和列表会给围栏加前缀，全文后处理不能靠顶层围栏正则识别它。
  return `${fence}${language}\n${emitRawSegment(code)}\n${fence}`;
}

/** 读取围栏代码块原文的开围栏（缩进代码块等非围栏写法返回 null）。 */
export function sourceFenceOf(token: MarkdownToken): string | null {
  const raw = typeof token.raw === 'string' ? token.raw : '';
  return /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1] ?? null;
}

/** 判断 marked 的 code token 是否来自围栏或缩进代码块（行内代码不在此列）。 */
export function isBlockCodeToken(token: MarkdownToken): boolean {
  const raw = typeof token.raw === 'string' ? token.raw.trimStart() : '';
  return raw.startsWith('```') || raw.startsWith('~~~') || token.codeBlockStyle === 'indented';
}

/** 读取围栏语言标识（只取第一个单词并统一小写）。 */
export function fenceLanguageOf(token: MarkdownToken): string {
  const lang = typeof token.lang === 'string' ? token.lang : '';
  return lang.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

/**
 * 生成图表块节点的 Markdown 解析/序列化配置。
 * 解析：仅当围栏语言映射到本节点时接管 code token，其余交还给普通代码块。
 * 序列化：输出与语言匹配的围栏，内容取节点的 code 属性。
 */
export function diagramFenceMarkdown(nodeName: string, language: string) {
  return {
    markdownTokenName: 'code',
    parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers): JSONContent | JSONContent[] => {
      if (!isBlockCodeToken(token)) return [];
      if (PREVIEW_FENCE_LANGUAGES[fenceLanguageOf(token)] !== nodeName) return [];
      return helpers.createNode(nodeName, { code: typeof token.text === 'string' ? token.text : '' });
    },
    renderMarkdown: (node: JSONContent): string => {
      const code = typeof node.attrs?.code === 'string' ? node.attrs.code : '';
      return renderFencedCode(language, code);
    },
  };
}
