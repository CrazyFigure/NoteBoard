// NoteBoard GitHub Alerts 扩展
// 5 种 alert 类型，消费 --alert-* Token，工具栏/斜杠命令插入
// 详见 docs/09-开发路线图.md 8.6
//
// GitHub Alert 格式:
// > [!NOTE] / > [!TIP] / > [!IMPORTANT] / > [!WARNING] / > [!CAUTION]

import { Node, mergeAttributes, type JSONContent } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';

export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

// 提示块首行语法：`> [!NOTE]`，标记独占一行（大小写不敏感，与 GitHub 一致）
const ALERT_HEAD_PATTERN = /^ {0,3}> ?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;
const ALERT_START_PATTERN = /(?:^|\n) {0,3}> ?\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;
const ALERT_KINDS_SET = new Set<string>(['note', 'tip', 'important', 'warning', 'caution']);

const ALERT_META: Record<AlertKind, { icon: string; label: string }> = {
  note: { icon: 'ℹ️', label: 'Note' },
  tip: { icon: '💡', label: 'Tip' },
  important: { icon: '❗', label: 'Important' },
  warning: { icon: '⚠️', label: 'Warning' },
  caution: { icon: '🔴', label: 'Caution' },
};

function AlertComponent({ node, updateAttributes, selected }: NodeViewProps) {
  const kind = (node.attrs.kind as AlertKind) || 'note';
  const meta = ALERT_META[kind];

  return (
    <NodeViewWrapper
      as="div"
      selected={selected}
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderLeft: `4px solid var(--alert-${kind}-border, var(--editor-accent))`,
        background: `var(--alert-${kind}-background, var(--editor-surface))`,
        borderRadius: 'var(--radius-sm)',
        padding: '8px 12px',
        margin: '8px 0',
        position: 'relative',
      }}
    >
      <div
        contentEditable={false}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 4,
          fontSize: 13,
          fontWeight: 600,
          color: `var(--alert-${kind}-text, var(--editor-text))`,
        }}
      >
        <span>{meta.icon}</span>
        <span>{meta.label}</span>
        <select
          value={kind}
          onChange={(e) => updateAttributes({ kind: e.target.value })}
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            padding: '2px 4px',
            border: '1px solid var(--editor-border)',
            borderRadius: 3,
            background: 'transparent',
            color: 'var(--editor-text)',
          }}
        >
          {Object.entries(ALERT_META).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      {/* 正文挂载点：缺少 NodeViewContent 时 ProseMirror 会把正文渲染到提示框外部 */}
      <NodeViewContent className="nb-alert-content" style={{ flex: 1, fontSize: 'var(--content-font-size)' }} />
    </NodeViewWrapper>
  );
}

/** GitHub Alert 节点 */
export const GitHubAlert = Node.create({
  name: 'githubAlert',
  group: 'block',
  content: 'block+',
  selectable: true,
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: 'note' as AlertKind,
      },
    };
  },
  parseHTML() {
    return [
      { tag: 'div[data-alert]' },
    ];
  },

  // 块级 tokenizer：识别首行为 `> [!KIND]` 的引用块，优先于普通 blockquote 解析
  markdownTokenizer: {
    name: 'githubAlert',
    level: 'block',
    start: (src: string) => {
      const match = ALERT_START_PATTERN.exec(src);
      if (!match) return -1;
      // 匹配可能以换行开头，起始位置需跳过该换行符
      return match.index + (match[0].startsWith('\n') ? 1 : 0);
    },
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
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-alert': '' }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AlertComponent);
  },
  addCommands() {
    return {
      insertAlert:
        (kind: AlertKind) =>
        ({ commands }: { commands: { insertContent: (content: unknown) => boolean } }) => {
          return commands.insertContent({
            type: 'githubAlert',
            attrs: { kind },
            content: [{ type: 'paragraph' }],
          });
        },
    } as never;
  },
});

/** Alert 种类列表（供斜杠命令使用） */
export const ALERT_KINDS = Object.keys(ALERT_META) as AlertKind[];
export { ALERT_META };
