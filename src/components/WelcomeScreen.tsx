// NoteBoard WelcomeScreen
// 无 tab 时的欢迎页：四个动作 + 最近打开列表
// 详见 docs/07-UI布局与交互规范.md §11

import { FolderOpen, FilePlus, PencilRuler, FileSearch } from 'lucide-react';

interface WelcomeScreenProps {
  onOpenFile?: () => void;
  onOpenFolder?: () => void;
  onNewMarkdown?: () => void;
  onNewBoard?: () => void;
}

export function WelcomeScreen({ onOpenFile, onOpenFolder, onNewMarkdown, onNewBoard }: WelcomeScreenProps) {
  const actions = [
    { icon: FileSearch, label: '打开文件', shortcut: 'Ctrl+O', onClick: onOpenFile },
    { icon: FolderOpen, label: '打开文件夹', shortcut: 'Ctrl+K Ctrl+O', onClick: onOpenFolder },
    { icon: FilePlus, label: '新建 Markdown', shortcut: 'Ctrl+N', onClick: onNewMarkdown },
    { icon: PencilRuler, label: '新建画板', shortcut: '', onClick: onNewBoard },
  ];

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--editor-bg)',
        color: 'var(--editor-text)',
        fontFamily: 'var(--content-font-family)',
        gap: 32,
      }}
    >
      {/* Logo + 名称 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <img src="/logo.ico" alt="NoteBoard" width={64} height={64} />
        <h1
          style={{
            fontSize: 28,
            fontWeight: 600,
            color: 'var(--editor-heading)',
            margin: 0,
          }}
        >
          NoteBoard
        </h1>
      </div>

      {/* 四个动作 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {actions.map((action, i) => (
          <button
            key={i}
            onClick={action.onClick ?? (() => {})}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 16px',
              border: '1px solid var(--editor-border)',
              borderRadius: 6,
              background: 'var(--editor-surface)',
              cursor: 'pointer',
              minWidth: 320,
              fontSize: 14,
              color: 'var(--editor-text)',
              transition: 'background var(--transition-fast), border-color var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--editor-surface)';
              e.currentTarget.style.borderColor = 'var(--editor-border)';
            }}
          >
            <action.icon size={20} color="var(--editor-accent)" />
            <span style={{ flex: 1, textAlign: 'left' }}>{action.label}</span>
            {action.shortcut && (
              <span style={{ color: 'var(--editor-text-muted)', fontSize: 12 }}>
                {action.shortcut}
              </span>
            )}
          </button>
        ))}
      </div>

    </div>
  );
}
