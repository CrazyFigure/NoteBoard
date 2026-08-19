// NoteBoard WelcomeScreen
// 无 tab 时的欢迎页：四个动作 + 最近打开列表
// 详见 docs/07-UI布局与交互规范.md §11

import { FolderOpen, FilePlus, PencilRuler, FileSearch, FileText } from 'lucide-react';

interface WelcomeScreenProps {
  onOpenFile?: () => void;
  onOpenFolder?: () => void;
  onNewMarkdown?: () => void;
  onNewText?: () => void;
  onNewBoard?: () => void;
}

export function WelcomeScreen({ onOpenFile, onOpenFolder, onNewMarkdown, onNewText, onNewBoard }: WelcomeScreenProps) {
  // 欢迎页主要快捷操作入口
  const actions = [
    { icon: FileSearch, label: '打开文件', shortcut: 'Ctrl+O', onClick: onOpenFile },
    { icon: FolderOpen, label: '打开文件夹', shortcut: 'Ctrl+K Ctrl+O', onClick: onOpenFolder },
    { icon: FilePlus, label: '新建 Markdown', shortcut: 'Ctrl+N', onClick: onNewMarkdown },
    { icon: FileText, label: '新建文本文档', shortcut: '', onClick: onNewText },
    { icon: PencilRuler, label: '新建画板', shortcut: '', onClick: onNewBoard },
  ];

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        // 整体下移偏移量，使视觉重心更居中平衡
        paddingTop: 48,
        boxSizing: 'border-box',
        background: 'var(--editor-bg)',
        color: 'var(--editor-text)',
        fontFamily: 'var(--content-font-family)',
        gap: 36,
      }}
    >
      {/* Logo + 名称 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <img
          src="/logo.ico"
          alt="NoteBoard"
          width={72}
          height={72}
          style={{ filter: 'drop-shadow(0 4px 12px rgba(0, 0, 0, 0.15))' }}
        />
        <h1
          style={{
            fontSize: 30,
            fontWeight: 600,
            color: 'var(--editor-heading)',
            margin: 0,
            letterSpacing: '-0.02em',
          }}
        >
          NoteBoard
        </h1>
        <span style={{ fontSize: 13, color: 'var(--editor-text-muted)' }}>
          轻量双模笔记与画板工具
        </span>
      </div>

      {/* 四个动作按钮 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {actions.map((action, i) => (
          <button
            key={i}
            className="nb-btn-card"
            onClick={action.onClick ?? (() => {})}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '10px 18px',
              border: '1px solid var(--editor-border)',
              borderRadius: 8,
              background: 'var(--editor-surface)',
              cursor: 'pointer',
              minWidth: 340,
              fontSize: 14,
              color: 'var(--editor-text)',
              boxShadow: 'var(--shadow-sm, 0 1px 3px rgba(0, 0, 0, 0.05))',
              transition: 'all var(--transition-fast, 150ms ease)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = 'var(--shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.1))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--editor-surface)';
              e.currentTarget.style.borderColor = 'var(--editor-border)';
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'var(--shadow-sm, 0 1px 3px rgba(0, 0, 0, 0.05))';
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-active)';
              e.currentTarget.style.transform = 'translateY(0) scale(0.985)';
              e.currentTarget.style.boxShadow = 'var(--shadow-sm, 0 1px 3px rgba(0, 0, 0, 0.05))';
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = 'var(--shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.1))';
            }}
          >
            <action.icon size={20} color="var(--editor-accent)" />
            <span style={{ flex: 1, textAlign: 'left', fontWeight: 500 }}>{action.label}</span>
            {action.shortcut && (
              <span
                style={{
                  color: 'var(--editor-text-muted)',
                  fontSize: 12,
                  padding: '2px 6px',
                  background: 'var(--editor-bg)',
                  borderRadius: 4,
                  border: '1px solid var(--editor-border)',
                }}
              >
                {action.shortcut}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
