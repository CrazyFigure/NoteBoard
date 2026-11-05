// NoteBoard GitHub Alerts 扩展
// 5 种 alert 类型，消费 --alert-* Token，工具栏/斜杠命令插入
// 详见 docs/09-开发路线图.md 8.6
//
// GitHub Alert 格式:
// > [!NOTE] / > [!TIP] / > [!IMPORTANT] / > [!WARNING] / > [!CAUTION]

import { useEffect, useRef, useState } from 'react';
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';
import { contentReactNodeViewRenderer } from './contentNodeView';
import { AlertCircle, AlertTriangle, Check, ChevronDown, Flame, Info, Lightbulb, type LucideIcon } from 'lucide-react';
import { GitHubAlertCore, AlertKind } from './alertCore';

// 保留既有导出入口，界面和调用方继续使用同一份核心规则。
export type { AlertKind } from './alertCore';

const ALERT_META: Record<AlertKind, { icon: string; label: string; desc: string }> = {
  note: { icon: 'ℹ️', label: 'Note', desc: '补充说明' },
  tip: { icon: '💡', label: 'Tip', desc: '技巧建议' },
  important: { icon: '❗', label: 'Important', desc: '重要提示' },
  warning: { icon: '⚠️', label: 'Warning', desc: '注意警告' },
  caution: { icon: '🔴', label: 'Caution', desc: '高危警告' },
};

/** 提示块类型切换：右上角轻量胶囊 + 下拉菜单（替代原生下拉框，与编辑器菜单风格统一） */
function AlertKindPicker({ kind, onChange }: { kind: AlertKind; onChange: (kind: AlertKind) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点按外部或按 Esc 关闭菜单
  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as globalThis.Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointer, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointer, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="nb-alert-picker">
      <button
        type="button"
        className={`nb-alert-picker-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="切换提示块类型"
        // 阻止按下时编辑器失焦或移动选区
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`nb-alert-picker-dot is-${kind}`} />
        <span>{ALERT_META[kind].label}</span>
        <ChevronDown size={13} className="nb-alert-picker-chevron" />
      </button>
      {open && (
        <div className="nb-alert-picker-menu" role="listbox">
          {ALERT_KINDS.map((item) => (
            <button
              key={item}
              type="button"
              role="option"
              aria-selected={item === kind}
              className={`nb-alert-picker-item${item === kind ? ' is-active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(item);
                setOpen(false);
              }}
            >
              <span className="nb-alert-picker-icon">{ALERT_META[item].icon}</span>
              <span className="nb-alert-picker-text">
                <span className="nb-alert-picker-label">{ALERT_META[item].label}</span>
                <span className="nb-alert-picker-desc">{ALERT_META[item].desc}</span>
              </span>
              {item === kind && <Check size={14} className="nb-alert-picker-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
        <AlertKindPicker kind={kind} onChange={(next) => updateAttributes({ kind: next })} />
      </div>
      {/* 正文挂载点：缺少 NodeViewContent 时 ProseMirror 会把正文渲染到提示框外部 */}
      <NodeViewContent className="nb-alert-content" style={{ flex: 1, fontSize: 'var(--content-font-size)' }} />
    </NodeViewWrapper>
  );
}

/** GitHub Alert 节点 */
export const GitHubAlert = GitHubAlertCore.extend({
  addNodeView() {
    return contentReactNodeViewRenderer(AlertComponent);
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
  }
});

/** Alert 种类列表（供斜杠命令使用） */
export const ALERT_KINDS = Object.keys(ALERT_META) as AlertKind[];
export { ALERT_META };

// 插入菜单（斜杠命令、工具栏、右键菜单）共用的图标与颜色，保证三处展示一致
const ALERT_MENU_ICON: Record<AlertKind, { Icon: LucideIcon; color: string }> = {
  note: { Icon: Info, color: '#3b82f6' },
  tip: { Icon: Lightbulb, color: '#10b981' },
  important: { Icon: AlertCircle, color: '#8b5cf6' },
  warning: { Icon: AlertTriangle, color: '#f59e0b' },
  caution: { Icon: Flame, color: '#ef4444' },
};

/** 插入菜单中的 GitHub 提示块图标 */
export function AlertMenuIcon({ kind, size = 15 }: { kind: AlertKind; size?: number }) {
  const { Icon, color } = ALERT_MENU_ICON[kind];
  return <Icon size={size} color={color} />;
}

/** 插入菜单中的 GitHub 提示块文案，如「Note 补充说明」 */
export function alertMenuLabel(kind: AlertKind): string {
  return `${ALERT_META[kind].label} ${ALERT_META[kind].desc}`;
}
