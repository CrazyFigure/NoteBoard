// NoteBoard WelcomeScreen
// 无 tab 时的欢迎页：直接展示的新建格式卡片 + 更多格式展开（布局由设置「全局 → 新建入口」配置）
// 详见 docs/07-UI布局与交互规范.md §11

import React, { useEffect, useState } from 'react';
// 🔴 P0-1b：欢迎页空闲预取常用编辑器资源——用户看到"新建 Markdown"卡片即为预取
//    意图信号；空闲时机发起（不占首帧），点击新建/打开文件时资源已 ready，
//    渲染同步命中 fulfilled lazy（零 fallback、远低于 1s 目标）。
import { prefetchEditor } from '../features/editor-host/editorLoaders';
import {
  FolderOpen,
  FileSearch,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Archive,
  Star,
  FolderSync,
} from 'lucide-react';
import { useSyncStore } from '../stores/syncStore';
import { formatRelative } from '../features/sync/syncFormat';
import { formatShortcut } from '../core/shortcuts';
import { createFormatLabel, getCreateFormat, type CreateFormatId } from '../features/welcome/createFormats';
import { useCreateFormats } from '../features/welcome/useCreateFormats';
import { useLayoutStore } from '../stores/layoutStore';
import { Tooltip } from './Tooltip';

interface WelcomeScreenProps {
  onOpenFile?: () => void;
  onOpenFolder?: () => void;
  onOpenStaging?: () => void;
  onOpenFavorites?: () => void;
  onNewMarkdown?: () => void;
  onNewText?: () => void;
  onNewMindmap?: () => void;
  onTextDiff?: () => void;
  onNewBoard?: () => void;
  onNewDrawio?: () => void;
  onNewBitable?: () => void;
  onNewMermaid?: () => void;
  onNewPlantUml?: () => void;
  onNewInfographic?: () => void;
  onNewJson?: () => void;
  onNewSql?: () => void;
  /** 打开多端同步文件夹（设置了同步文件夹时显示入口） */
  onOpenSyncFolder?: () => void;
}

/** 极窄模式卡片较窄：去掉标题末尾的「(.md)」扩展名说明，避免截断 */
function stripExtension(label: string): string {
  return label.replace(/\s*[(（][^()（）]*[)）]\s*$/, '');
}

export function WelcomeScreen({
  onOpenFile,
  onOpenFolder,
  onOpenStaging,
  onOpenFavorites,
  onNewMarkdown,
  onNewText,
  onNewMindmap,
  onTextDiff,
  onNewBoard,
  onNewDrawio,
  onNewBitable,
  onNewMermaid,
  onNewPlantUml,
  onNewInfographic,
  onNewJson,
  onNewSql,
  onOpenSyncFolder,
}: WelcomeScreenProps) {
  const [showMoreFormats, setShowMoreFormats] = useState(false);
  // 极窄模式：新建卡片改为图标在上的紧凑三列，描述移入 Tooltip，打开类卡片隐藏快捷键徽标
  const compact = useLayoutStore((s) => s.compactMode);
  // 同步文件夹入口：路径与最近同步状态
  const syncRoot = useSyncStore((s) => s.config?.sync.rootDir?.trim() || null);
  const syncEnabled = useSyncStore((s) => s.config?.sync.enabled ?? false);
  const lastSyncAt = useSyncStore((s) => s.status?.lastSync?.at ?? 0);
  const syncing = useSyncStore((s) => s.status?.syncing ?? false);
  const syncStatusText = !syncEnabled
    ? '多端同步未开启'
    : syncing
      ? '正在同步…'
      : lastSyncAt
        ? `上次同步 ${formatRelative(lastSyncAt)}`
        : '尚未同步';

  // 🔴 P0-1b：首帧提交后空闲预取最常用入口（markdown 为主，code 次之）——
  //    requestIdleCallback 空闲发起（jsdom/旧环境回退 setTimeout），不与首屏
  //    渲染争资源；资源注册表与实际渲染共享（R4-02），完成后再打开直接命中。
  //    欢迎页离开后取消尚未开始的预取，避免文件关联打开其他格式时额外加载两个内核。
  useEffect(() => {
    let disposed = false;
    const preload = () => {
      // 取消调度与回调触发交错时，卸载标记仍能阻止无关模块装载。
      if (disposed) return;
      prefetchEditor('markdown');
      prefetchEditor('code');
    };
    if (typeof requestIdleCallback === 'function') {
      const idleId = requestIdleCallback(preload, { timeout: 2000 });
      return () => { disposed = true; cancelIdleCallback(idleId); };
    }
    // 不支持空闲调度的环境保持原等待时间，但卸载时同样取消。
    const timer = setTimeout(preload, 300);
    return () => { disposed = true; clearTimeout(timer); };
  }, []);

  // 新建格式布局与「+」菜单共用一份设置：直接展示的排入核心卡片网格，其余收进「更多格式」
  const createFormats = useCreateFormats();
  const createHandlers: Record<CreateFormatId, (() => void) | undefined> = {
    markdown: onNewMarkdown,
    text: onNewText,
    bitable: onNewBitable,
    board: onNewBoard,
    mindmap: onNewMindmap,
    textdiff: onTextDiff,
    drawio: onNewDrawio,
    infographic: onNewInfographic,
    mermaid: onNewMermaid,
    plantuml: onNewPlantUml,
    json: onNewJson,
    sql: onNewSql,
  };
  const toCreateAction = (id: CreateFormatId) => {
    const meta = getCreateFormat(id);
    return {
      id,
      icon: meta.icon,
      label: createFormatLabel(meta),
      desc: meta.desc,
      shortcut: '',
      color: meta.color,
      onClick: createHandlers[id],
    };
  };

  // 常用新建操作列表（直接展示的格式，排入 3 列网格）
  const primaryCreateActions = createFormats.primary.map(toCreateAction);

  // 打开与常用操作列表（4 个操作，整齐排成 2x2 网格，配置多主题自适应微色调）
  const openActions = [
    {
      icon: FileSearch,
      label: '打开文件',
      desc: '打开已有文档或图表',
      shortcut: 'Ctrl+O',
      color: 'var(--editor-accent, #3b82f6)',
      bg: 'rgba(59, 130, 246, 0.05)',
      border: 'rgba(59, 130, 246, 0.18)',
      hoverBg: 'rgba(59, 130, 246, 0.10)',
      hoverBorder: 'rgba(59, 130, 246, 0.38)',
      iconBg: 'rgba(59, 130, 246, 0.10)',
      badgeBg: 'rgba(59, 130, 246, 0.08)',
      badgeBorder: 'rgba(59, 130, 246, 0.22)',
      onClick: onOpenFile,
    },
    {
      icon: FolderOpen,
      label: '打开文件夹',
      desc: '载入本地文件夹',
      shortcut: 'Ctrl+Shift+O',
      color: '#eab308',
      bg: 'rgba(234, 179, 8, 0.04)',
      border: 'rgba(234, 179, 8, 0.16)',
      hoverBg: 'rgba(234, 179, 8, 0.09)',
      hoverBorder: 'rgba(234, 179, 8, 0.35)',
      iconBg: 'rgba(234, 179, 8, 0.09)',
      badgeBg: 'rgba(234, 179, 8, 0.07)',
      badgeBorder: 'rgba(234, 179, 8, 0.20)',
      onClick: onOpenFolder,
    },
    {
      icon: Star,
      iconFill: '#f97316',
      label: '打开收藏夹',
      desc: '查看与整理收藏文件',
      shortcut: '',
      color: '#f97316',
      bg: 'rgba(249, 115, 22, 0.05)',
      border: 'rgba(249, 115, 22, 0.18)',
      hoverBg: 'rgba(249, 115, 22, 0.10)',
      hoverBorder: 'rgba(249, 115, 22, 0.38)',
      iconBg: 'rgba(249, 115, 22, 0.10)',
      badgeBg: 'rgba(249, 115, 22, 0.08)',
      badgeBorder: 'rgba(249, 115, 22, 0.22)',
      onClick: onOpenFavorites,
    },
    {
      icon: Archive,
      label: '打开暂存区',
      desc: '恢复未保存或异常副本',
      shortcut: '',
      color: '#8b5cf6',
      bg: 'rgba(139, 92, 246, 0.05)',
      border: 'rgba(139, 92, 246, 0.18)',
      hoverBg: 'rgba(139, 92, 246, 0.10)',
      hoverBorder: 'rgba(139, 92, 246, 0.38)',
      iconBg: 'rgba(139, 92, 246, 0.10)',
      badgeBg: 'rgba(139, 92, 246, 0.08)',
      badgeBorder: 'rgba(139, 92, 246, 0.22)',
      onClick: onOpenStaging,
    },
  ];

  // 更多格式列表（收进「更多」的格式）
  const moreFormats = createFormats.more.map(toCreateAction);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: compact ? '20px 14px' : '32px 24px',
        boxSizing: 'border-box',
        background: 'var(--editor-bg)',
        color: 'var(--editor-text)',
        fontFamily: 'var(--content-font-family)',
        overflowY: 'auto',
      }}
    >
      {/* 顶部 Logo 与系统标语 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: compact ? 8 : 12,
          marginBottom: compact ? 18 : 26,
        }}
      >
        <img
          src="/logo.ico"
          alt="NoteBoard"
          width={compact ? 44 : 64}
          height={compact ? 44 : 64}
          style={{ filter: 'drop-shadow(0 4px 12px rgba(0, 0, 0, 0.12))' }}
        />
        <h1
          style={{
            fontSize: compact ? 20 : 26,
            fontWeight: 600,
            color: 'var(--editor-heading)',
            margin: 0,
            letterSpacing: '-0.02em',
          }}
        >
          NoteBoard
        </h1>
        <span style={{ fontSize: compact ? 12 : 13, color: 'var(--editor-text-muted)', textAlign: 'center' }}>
          轻量双模笔记、思维导图与专业图表工作台
        </span>
      </div>

      {/* 第一部分：常用新建核心卡片区（3 列网格；全部收进更多时不渲染） */}
      {primaryCreateActions.length > 0 && (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: compact ? 8 : 12,
          width: '100%',
          maxWidth: 840,
        }}
      >
        {primaryCreateActions.map((action) => (
          <Tooltip key={action.id} content={action.desc} disabled={!compact} side="bottom" sideOffset={6}>
          <button
            type="button"
            className="nb-btn-card"
            onClick={action.onClick ?? (() => {})}
            style={{
              display: 'flex',
              flexDirection: compact ? 'column' : 'row',
              alignItems: 'center',
              gap: compact ? 6 : 12,
              padding: compact ? '10px 6px 8px' : '10px 14px',
              minWidth: 0,
              border: '1px solid var(--control-border)',
              borderRadius: 8,
              background: 'var(--editor-surface)',
              cursor: 'pointer',
              fontSize: 13,
              color: 'var(--editor-text)',
              boxShadow: 'var(--shadow-sm, 0 1px 3px rgba(0, 0, 0, 0.04))',
              transition: 'all var(--transition-fast, 150ms ease)',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--editor-surface)';
              e.currentTarget.style.borderColor = 'var(--control-border)';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.transform = 'scale(0.98)';
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
          >
            {/* 图标容器 */}
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                background: 'var(--editor-bg)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <action.icon size={18} color={action.color} />
            </div>
            {/* 标题与描述（极窄模式只保留居中标题） */}
            <div style={{ flex: 1, minWidth: 0, width: compact ? '100%' : undefined, textAlign: compact ? 'center' : undefined }}>
              <div style={{ fontWeight: 500, lineHeight: 1.3, fontSize: compact ? 12 : undefined, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                {compact ? stripExtension(action.label) : action.label}
              </div>
              {!compact && (
                <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginTop: 2, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                  {action.desc}
                </div>
              )}
            </div>
            {action.shortcut && !compact ? (
              <span
                style={{
                  color: 'var(--editor-text-muted)',
                  fontSize: 10,
                  padding: '2px 5px',
                  background: 'var(--editor-bg)',
                  borderRadius: 4,
                  border: '1px solid var(--editor-border)',
                  flexShrink: 0,
                }}
              >
                {formatShortcut(action.shortcut)}
              </span>
            ) : null}
          </button>
          </Tooltip>
        ))}
      </div>
      )}

      {/* 第二部分：横在中间的“更多格式”折叠通栏按钮（没有收进更多的格式时不渲染） */}
      {moreFormats.length > 0 && (
      <div
        style={{
          width: '100%',
          maxWidth: 840,
          marginTop: primaryCreateActions.length > 0 ? 12 : 0,
        }}
      >
        <button
          type="button"
          onClick={() => setShowMoreFormats((prev) => !prev)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '8px 16px',
            border: showMoreFormats ? '1px solid var(--editor-border-focus)' : '1px solid var(--editor-border)',
            borderRadius: 8,
            background: showMoreFormats ? 'var(--toolbar-hover)' : 'var(--editor-surface)',
            cursor: 'pointer',
            fontSize: 12,
            color: 'var(--editor-text)',
            transition: 'all var(--transition-fast, 150ms ease)',
            boxShadow: 'var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.03))',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
            e.currentTarget.style.transform = 'translateY(-0.5px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = showMoreFormats ? 'var(--toolbar-hover)' : 'var(--editor-surface)';
            e.currentTarget.style.borderColor = showMoreFormats ? 'var(--editor-border-focus)' : 'var(--editor-border)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.transform = 'scale(0.99)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
          }}
        >
          <Sparkles size={14} color="var(--editor-accent, #3b82f6)" />
          <span style={{ fontWeight: 500 }}>
            {showMoreFormats ? '收起更多格式' : '更多格式新建'}
          </span>
          {showMoreFormats ? (
            <ChevronUp size={14} color="var(--editor-text-muted)" />
          ) : (
            <ChevronDown size={14} color="var(--editor-text-muted)" />
          )}
        </button>
      </div>
      )}

      {/* 第三部分：展开的更多格式卡片区（3 列网格） */}
      {showMoreFormats && moreFormats.length > 0 && (
        <div
          style={{
            marginTop: 10,
            width: '100%',
            maxWidth: 840,
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: compact ? 6 : 10,
            padding: compact ? 8 : 12,
            background: 'var(--editor-surface)',
            border: '1px solid var(--editor-border)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-sm)',
            boxSizing: 'border-box',
          }}
        >
          {moreFormats.map((fmt) => (
            <Tooltip key={fmt.id} content={fmt.desc} disabled={!compact} side="bottom" sideOffset={6}>
            <button
              type="button"
              onClick={fmt.onClick ?? (() => {})}
              style={{
                display: 'flex',
                flexDirection: compact ? 'column' : 'row',
                alignItems: 'center',
                gap: compact ? 4 : 10,
                padding: compact ? '8px 4px 6px' : '8px 12px',
                minWidth: 0,
                border: '1px solid var(--control-border)',
                borderRadius: 6,
                background: 'var(--editor-bg)',
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--editor-text)',
                textAlign: 'left',
                transition: 'all var(--transition-fast, 150ms ease)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--toolbar-hover)';
                e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--editor-bg)';
                e.currentTarget.style.borderColor = 'var(--control-border)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
              onMouseDown={(e) => {
                e.currentTarget.style.transform = 'scale(0.98)';
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
            >
              <fmt.icon size={16} color={fmt.color} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', width: compact ? '100%' : undefined, textAlign: compact ? 'center' : undefined }}>
                <div style={{ fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                  {compact ? stripExtension(fmt.label) : fmt.label}
                </div>
                {!compact && (
                  <div style={{ fontSize: 10, color: 'var(--editor-text-muted)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                    {fmt.desc}
                  </div>
                )}
              </div>
            </button>
            </Tooltip>
          ))}
        </div>
      )}

      {/* 第四部分：打开与常用操作区（2x2 网格，整齐 2 行 2 列，专属微色调背景） */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: compact ? 8 : 12,
          width: '100%',
          maxWidth: 840,
          marginTop: compact ? 8 : 12,
        }}
      >
        {openActions.map((action, i) => (
          <button
            key={i}
            type="button"
            className="nb-btn-card"
            onClick={action.onClick ?? (() => {})}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: compact ? 8 : 12,
              padding: compact ? '8px 10px' : '10px 14px',
              minWidth: 0,
              border: `1px solid ${action.border}`,
              borderRadius: 8,
              background: action.bg,
              cursor: 'pointer',
              fontSize: 13,
              color: 'var(--editor-text)',
              boxShadow: 'var(--shadow-sm, 0 1px 3px rgba(0, 0, 0, 0.03))',
              transition: 'all var(--transition-fast, 150ms ease)',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = action.hoverBg;
              e.currentTarget.style.borderColor = action.hoverBorder;
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = action.bg;
              e.currentTarget.style.borderColor = action.border;
              e.currentTarget.style.transform = 'translateY(0)';
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.transform = 'scale(0.98)';
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
          >
            {/* 图标容器（带主题协调的轻底色） */}
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                background: action.iconBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <action.icon
                size={18}
                color={action.color}
                fill={action.iconFill || 'none'}
              />
            </div>
            {/* 标题与描述 */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, lineHeight: 1.3, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                {action.label}
              </div>
              <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginTop: 2, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                {action.desc}
              </div>
            </div>
            {action.shortcut && !compact ? (
              <span
                style={{
                  color: 'var(--editor-text-secondary, var(--editor-text-muted))',
                  fontSize: 10,
                  padding: '2px 5px',
                  background: action.badgeBg,
                  borderRadius: 4,
                  border: `1px solid ${action.badgeBorder}`,
                  flexShrink: 0,
                }}
              >
                {formatShortcut(action.shortcut)}
              </span>
            ) : null}
          </button>
        ))}

        {/* 设置了同步文件夹时显示：横跨两列，附带路径与最近同步时间 */}
        {syncRoot && onOpenSyncFolder ? (
          <button
            type="button"
            className="nb-btn-card"
            onClick={onOpenSyncFolder}
            style={{
              gridColumn: '1 / -1',
              display: 'flex',
              alignItems: 'center',
              gap: compact ? 8 : 12,
              padding: compact ? '8px 10px' : '10px 14px',
              minWidth: 0,
              border: '1px solid rgba(14, 165, 233, 0.18)',
              borderRadius: 8,
              background: 'rgba(14, 165, 233, 0.05)',
              cursor: 'pointer',
              fontSize: 13,
              color: 'var(--editor-text)',
              boxShadow: 'var(--shadow-sm, 0 1px 3px rgba(0, 0, 0, 0.03))',
              transition: 'all var(--transition-fast, 150ms ease)',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(14, 165, 233, 0.10)';
              e.currentTarget.style.borderColor = 'rgba(14, 165, 233, 0.38)';
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(14, 165, 233, 0.05)';
              e.currentTarget.style.borderColor = 'rgba(14, 165, 233, 0.18)';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.transform = 'scale(0.99)';
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                background: 'rgba(14, 165, 233, 0.10)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <FolderSync size={18} color="#0ea5e9" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, lineHeight: 1.3 }}>打开同步文件夹</div>
              <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginTop: 2, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                {syncRoot}
              </div>
            </div>
            {!compact && <span style={{ fontSize: 11, color: 'var(--editor-text-muted)', flexShrink: 0 }}>{syncStatusText}</span>}
          </button>
        ) : null}
      </div>
    </div>
  );
}

