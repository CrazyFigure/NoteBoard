// NoteBoard WelcomeScreen
// 无 tab 时的欢迎页：主放核心 4 格式 (md, txt, 画板, 脑图) + 更多格式展开/二级弹窗
// 详见 docs/07-UI布局与交互规范.md §11

import React, { useState } from 'react';
import {
  FolderOpen,
  FilePlus,
  PencilRuler,
  FileSearch,
  FileText,
  Network,
  Layout,
  Workflow,
  GitMerge,
  Braces,
  FileCode,
  Database,
  CodeXml,
  ChartColumn,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Archive,
  Table2,
} from 'lucide-react';

interface WelcomeScreenProps {
  onOpenFile?: () => void;
  onOpenFolder?: () => void;
  onOpenStaging?: () => void;
  onNewMarkdown?: () => void;
  onNewText?: () => void;
  onNewMindmap?: () => void;
  onNewBoard?: () => void;
  onNewDrawio?: () => void;
  onNewBitable?: () => void;
  onNewMermaid?: () => void;
  onNewPlantUml?: () => void;
  onNewInfographic?: () => void;
  onNewJson?: () => void;
  onNewYaml?: () => void;
  onNewSql?: () => void;
  onNewXml?: () => void;
}

export function WelcomeScreen({
  onOpenFile,
  onOpenFolder,
  onOpenStaging,
  onNewMarkdown,
  onNewText,
  onNewMindmap,
  onNewBoard,
  onNewDrawio,
  onNewBitable,
  onNewMermaid,
  onNewPlantUml,
  onNewInfographic,
  onNewJson,
  onNewYaml,
  onNewSql,
  onNewXml,
}: WelcomeScreenProps) {
  const [showMoreFormats, setShowMoreFormats] = useState(false);

  // 常用新建操作列表（5 大核心卡片，排入 3 列网格）
  const primaryCreateActions = [
    {
      icon: FilePlus,
      label: '新建 Markdown 笔记',
      desc: '富文本与源码双模笔记',
      shortcut: '',
      color: 'var(--editor-accent, #3b82f6)',
      onClick: onNewMarkdown,
    },
    {
      icon: FileText,
      label: '新建文本文档 (.txt)',
      desc: '轻量纯文本记录与备忘',
      shortcut: '',
      color: '#64748b',
      onClick: onNewText,
    },
    {
      icon: Table2,
      label: '多维表格 (.bitable)',
      desc: '结构化数据与看板视图',
      shortcut: '',
      color: '#2563eb',
      onClick: onNewBitable,
    },
    {
      icon: PencilRuler,
      label: '新建自由画板',
      desc: 'Excalidraw 自由手绘与白板',
      shortcut: '',
      color: 'var(--accent-strong, #8b5cf6)',
      onClick: onNewBoard,
    },
    {
      icon: Network,
      label: '新建思维导图 / XMind',
      desc: '幕布大纲 ⇄ 脑图双模切换',
      shortcut: '',
      color: '#f97316',
      onClick: onNewMindmap,
    },
  ];

  // 打开与工作区操作列表（3 个操作，整齐排成 1 行 3 列，配置多主题自适应微色调）
  const openActions = [
    {
      icon: FileSearch,
      label: '打开文件…',
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
      label: '打开文件夹…',
      desc: '载入工作区目录',
      shortcut: 'Ctrl+Shift+O',
      color: '#f59e0b',
      bg: 'rgba(245, 158, 11, 0.05)',
      border: 'rgba(245, 158, 11, 0.18)',
      hoverBg: 'rgba(245, 158, 11, 0.10)',
      hoverBorder: 'rgba(245, 158, 11, 0.38)',
      iconBg: 'rgba(245, 158, 11, 0.10)',
      badgeBg: 'rgba(245, 158, 11, 0.08)',
      badgeBorder: 'rgba(245, 158, 11, 0.22)',
      onClick: onOpenFolder,
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

  // 更多格式列表（8 项：Draw.io, 信息图, Mermaid, PlantUML, JSON, SQL, YAML, XML）
  const moreFormats = [
    {
      icon: Layout,
      label: 'Draw.io 架构图 (.drawio)',
      desc: '专业系统架构与业务流程图',
      color: '#ea580c',
      onClick: onNewDrawio,
    },
    {
      icon: ChartColumn,
      label: '信息图 (.infographic)',
      desc: '指标看板、时间线与漏斗等可视化',
      color: '#14b8a6',
      onClick: onNewInfographic,
    },
    {
      icon: Workflow,
      label: 'Mermaid 脚本图表 (.mmd)',
      desc: '时序图、流程图与状态机脚本',
      color: '#00bfb2',
      onClick: onNewMermaid,
    },
    {
      icon: GitMerge,
      label: 'PlantUML 架构建模 (.puml)',
      desc: '类图、时序图与系统组件图',
      color: '#a855f7',
      onClick: onNewPlantUml,
    },
    {
      icon: Braces,
      label: 'JSON 数据配置 (.json)',
      desc: 'JSON 数据、格式化与校验',
      color: '#eab308',
      onClick: onNewJson,
    },
    {
      icon: Database,
      label: 'SQL 数据库脚本 (.sql)',
      desc: 'SQL 数据库查询与 DDL 语句',
      color: '#3b82f6',
      onClick: onNewSql,
    },
    {
      icon: FileCode,
      label: 'YAML 配置文件 (.yaml)',
      desc: 'YAML 服务配置与清单管理',
      color: '#06b6d4',
      onClick: onNewYaml,
    },
    {
      icon: CodeXml,
      label: 'XML 标记文档 (.xml)',
      desc: 'XML 结构化标记与配置',
      color: '#ec4899',
      onClick: onNewXml,
    },
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
        padding: '32px 24px',
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
          gap: 12,
          marginBottom: 26,
        }}
      >
        <img
          src="/logo.ico"
          alt="NoteBoard"
          width={64}
          height={64}
          style={{ filter: 'drop-shadow(0 4px 12px rgba(0, 0, 0, 0.12))' }}
        />
        <h1
          style={{
            fontSize: 26,
            fontWeight: 600,
            color: 'var(--editor-heading)',
            margin: 0,
            letterSpacing: '-0.02em',
          }}
        >
          NoteBoard
        </h1>
        <span style={{ fontSize: 13, color: 'var(--editor-text-muted)' }}>
          轻量双模笔记、思维导图与专业图表工作台
        </span>
      </div>

      {/* 第一部分：常用新建核心卡片区（3 列网格） */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 12,
          width: '100%',
          maxWidth: 840,
        }}
      >
        {primaryCreateActions.map((action, i) => (
          <button
            key={i}
            type="button"
            className="nb-btn-card"
            onClick={action.onClick ?? (() => {})}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 14px',
              border: '1px solid var(--editor-border)',
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
              e.currentTarget.style.borderColor = 'var(--editor-border)';
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
            {/* 标题与描述 */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, lineHeight: 1.3, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                {action.label}
              </div>
              <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginTop: 2, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                {action.desc}
              </div>
            </div>
            {action.shortcut ? (
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
                {action.shortcut}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* 第二部分：横在中间的“更多格式”折叠通栏按钮 */}
      <div
        style={{
          width: '100%',
          maxWidth: 840,
          marginTop: 12,
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

      {/* 第三部分：展开的更多格式卡片区（3 列网格） */}
      {showMoreFormats && (
        <div
          style={{
            marginTop: 10,
            width: '100%',
            maxWidth: 840,
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 10,
            padding: 12,
            background: 'var(--editor-surface)',
            border: '1px solid var(--editor-border)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-sm)',
            boxSizing: 'border-box',
          }}
        >
          {moreFormats.map((fmt, idx) => (
            <button
              key={idx}
              type="button"
              onClick={fmt.onClick ?? (() => {})}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                border: '1px solid var(--editor-border)',
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
                e.currentTarget.style.borderColor = 'var(--editor-border)';
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
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                <div style={{ fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                  {fmt.label}
                </div>
                <div style={{ fontSize: 10, color: 'var(--editor-text-muted)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                  {fmt.desc}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 第四部分：打开与工作区操作区（3 列网格，整齐 1 行 3 列，专属微色调背景） */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 12,
          width: '100%',
          maxWidth: 840,
          marginTop: 12,
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
              gap: 12,
              padding: '10px 14px',
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
              <action.icon size={18} color={action.color} />
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
            {action.shortcut ? (
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
                {action.shortcut}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

