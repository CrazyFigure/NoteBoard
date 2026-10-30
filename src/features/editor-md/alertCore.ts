// 共享文档规则：后台解析与主线程使用同一份定义，禁止引入界面、store 或原生 API。
import { Node, mergeAttributes, type JSONContent } from '@tiptap/core';
import { createIndexedBlockStart } from './markdownBlockStart';

export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

// 提示块首行语法：`> [!NOTE]`，标记独占一行（大小写不敏感，与 GitHub 一致）
export const ALERT_HEAD_PATTERN = /^ {0,3}> ?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

export const ALERT_START_PATTERN = /(?:^|\n) {0,3}> ?\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

export const ALERT_KINDS_SET = new Set<string>(['note', 'tip', 'important', 'warning', 'caution']);

/** GitHubAlert 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const GitHubAlertCore = Node.create({
  name: 'githubAlert',
  group: 'block',
  content: 'block+',
  selectable: true,
  defining: true,
  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      kind: {
        default: 'note' as AlertKind,
      },
    };
  },
  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [
      { tag: 'div[data-alert]' },
    ];
  },

  // 块级 tokenizer：识别首行为 `> [!KIND]` 的引用块，优先于普通 blockquote 解析
  markdownTokenizer: {
    name: 'githubAlert',
    level: 'block',
    // 匹配可能以换行开头，起始位置需跳过该换行符；共用索引按同样规则还原。
    start: createIndexedBlockStart(ALERT_START_PATTERN),
    tokenize: (src, _tokens, lexer) => {
      const head = ALERT_HEAD_PATTERN.exec(src);
      if (!head) return undefined;
      const lines = src.split('\n');
      const bodyLines: string[] = [];
      let rawLineCount = 1;
      // 收集紧随其后的连续引用行，遇到非 `>` 开头的行即结束
      for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (!/^ {0,3}>/.test(line)) break;
        bodyLines.push(line.replace(/^ {0,3}> ?/, ''));
        rawLineCount += 1;
      }
      const raw = lines.slice(0, rawLineCount).join('\n') + (rawLineCount < lines.length ? '\n' : '');
      const body = bodyLines.join('\n');
      return {
        type: 'githubAlert',
        raw,
        kind: head[1].toLowerCase(),
        text: body,
        tokens: lexer.blockTokens(body),
      };
    },
  },

  /** 将共享词法结果转换为文档节点，解析阶段不读取界面状态。 */
  parseMarkdown: (token, helpers) => {
    const kind = (ALERT_KINDS_SET.has(token.kind) ? token.kind : 'note') as AlertKind;
    const parseBlocks = helpers.parseBlockChildren ?? helpers.parseChildren;
    const children = parseBlocks(token.tokens || []);
    // 节点内容约束为 block+，空提示块补一个空段落
    return helpers.createNode('githubAlert', { kind }, children.length > 0 ? children : [{ type: 'paragraph' }]);
  },

  // 序列化为 GitHub 语法：首行 `> [!KIND]`，正文逐行加 `> ` 前缀（与内置 blockquote 的分隔规则一致）
  renderMarkdown: (node, helpers) => {
    const kind = String(node.attrs?.kind || 'note').toUpperCase();
    const blocks: string[] = [];
    (node.content ?? []).forEach((child: JSONContent, index: number) => {
      const rendered = helpers.renderChild?.(child, index) ?? helpers.renderChildren([child]);
      blocks.push(
        rendered
          .split('\n')
          .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
          .join('\n'),
      );
    });
    const body = blocks.join('\n>\n');
    return body ? `> [!${kind}]\n${body}` : `> [!${kind}]`;
  },
  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-alert': '' }), 0];
  }
});
