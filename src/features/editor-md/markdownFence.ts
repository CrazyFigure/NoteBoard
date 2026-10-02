// NoteBoard Markdown 代码围栏工具
// 统一代码块与图表块（Mermaid / Infographic / PlantUML）的围栏序列化与解析，
// 保证内容中出现 ``` 时围栏不被提前闭合，且图表块不会因缺少序列化器而在保存时丢失。

import type { JSONContent, MarkdownParseHelpers, MarkdownToken } from '@tiptap/core';

/**
 * 在源码打开时直接还原为可视化预览块的围栏语言。
 * PlantUML 依赖远程渲染服务，打开他人文档时不自动转换，避免未经确认就把内容发送到外部服务器；
 * 它仅在序列化时输出为 ```plantuml 围栏，重新打开后以普通代码块呈现。
 */
export const PREVIEW_FENCE_LANGUAGES: Record<string, 'mermaidBlock' | 'infographicBlock'> = {
  mermaid: 'mermaidBlock',
  infographic: 'infographicBlock',
};

/** 计算能安全包裹内容的反引号围栏：长度为内容中最长连续反引号 + 1，且不少于 3。 */
export function fenceFor(code: string): string {
  let longest = 0;
  let current = 0;
  for (const character of code) {
    if (character === '`') {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** 把代码文本包装为围栏代码块；空内容保持与 TipTap 原实现一致的空行格式。 */
export function renderFencedCode(language: string, code: string): string {
  const fence = fenceFor(code);
  if (code === '') return `${fence}${language}\n\n${fence}`;
  return `${fence}${language}\n${code}\n${fence}`;
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
