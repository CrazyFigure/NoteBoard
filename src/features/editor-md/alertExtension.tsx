// NoteBoard GitHub Alerts 扩展
// 5 种 alert 类型，消费 --alert-* Token，工具栏/斜杠命令插入
// 详见 docs/09-开发路线图.md 8.6
//
// GitHub Alert 格式:
// > [!NOTE] / > [!TIP] / > [!IMPORTANT] / > [!WARNING] / > [!CAUTION]

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

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
      <div style={{ flex: 1, fontSize: 'var(--content-font-size)' }} />
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
