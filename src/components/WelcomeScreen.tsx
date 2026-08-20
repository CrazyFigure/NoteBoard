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
  ChevronDown,
  ChevronUp,
  Sparkles,
} from 'lucide-react';

interface WelcomeScreenProps {
  onOpenFile?: () => void;
  onOpenFolder?: () => void;
  onNewMarkdown?: () => void;
  onNewText?: () => void;
  onNewMindmap?: () => void;
  onNewBoard?: () => void;
  onNewDrawio?: () => void;
  onNewMermaid?: () => void;
  onNewPlantUml?: () => void;
  onNewJson?: () => void;
  onNewYaml?: () => void;
  onNewSql?: () => void;
  onNewXml?: () => void;
}

export function WelcomeScreen({
  onOpenFile,
  onOpenFolder,
  onNewMarkdown,
  onNewText,
  onNewMindmap,
  onNewBoard,
  onNewDrawio,
  onNewMermaid,
  onNewPlantUml,
  onNewJson,
  onNewYaml,
  onNewSql,
  onNewXml,
}: WelcomeScreenProps) {
  const [showMoreFormats, setShowMoreFormats] = useState(false);

  // 核心主放 4 种新建格式
  const primaryFormats = [
    {
      icon: FilePlus,
      label: '新建 Markdown 笔记',
      desc: '富文本与源码双模笔记',
      shortcut: 'Ctrl+N',
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

  // 常用工作区操作
  const workspaceActions = [
    {
      icon: FileSearch,
      label: '打开文件…',
      desc: '打开本地已有的任何笔记或图表',
      shortcut: 'Ctrl+O',
      color: 'var(--editor-accent, #3b82f6)',
      onClick: onOpenFile,
    },
    {
      icon: FolderOpen,
      label: '打开文件夹…',
      desc: '将工作区目录加载到侧边栏',
      shortcut: 'Ctrl+Shift+O',
      color: '#f59e0b',
      onClick: onOpenFolder,
    },
  ];

  // 更多格式（Draw.io, Mermaid, PlantUML, JSON, YAML, SQL, XML）
  const moreFormats = [
    {
      icon: Layout,
      label: 'Draw.io 架构图 (.drawio)',
      desc: '专业系统架构与业务流程图',
      color: '#ea580c',
      onClick: onNewDrawio,
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
      icon: FileCode,
      label: 'YAML 配置文件 (.yaml)',
      desc: 'YAML 服务配置与清单管理',
      color: '#06b6d4',
      onClick: onNewYaml,
    },
    {
      icon: Database,
      label: 'SQL 数据库脚本 (.sql)',
      desc: 'SQL 数据库查询与 DDL 语句',
      color: '#3b82f6',
      onClick: onNewSql,
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
      {/* Logo + 标题 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          marginBottom: 28,
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

      {/* 主核心区：双栏网格 (左侧核心新建，右侧工作区操作与更多格式) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 20,
          width: '100%',
          maxWidth: 780,
        }}
      >
        {/* 左栏：核心 4 格式新建 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--editor-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              paddingLeft: 4,
            }}
          >
            快速新建
          </div>

          {primaryFormats.map((action, i) => (
            <button
              key={i}
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
            >
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
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, lineHeight: 1.3 }}>{action.label}</div>
                <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginTop: 2 }}>
                  {action.desc}
                </div>
              </div>
              {action.shortcut && (
                <span
                  style={{
                    color: 'var(--editor-text-muted)',
                    fontSize: 11,
                    padding: '2px 6px',
                    background: 'var(--editor-bg)',
                    borderRadius: 4,
                    border: '1px solid var(--editor-border)',
                    flexShrink: 0,
                  }}
                >
                  {action.shortcut}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* 右栏：工作区操作 + 更多格式入口 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--editor-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              paddingLeft: 4,
            }}
          >
            工作区与更多
          </div>

          {workspaceActions.map((action, i) => (
            <button
              key={i}
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
            >
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
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, lineHeight: 1.3 }}>{action.label}</div>
                <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginTop: 2 }}>
                  {action.desc}
                </div>
              </div>
              {action.shortcut && (
                <span
                  style={{
                    color: 'var(--editor-text-muted)',
                    fontSize: 11,
                    padding: '2px 6px',
                    background: 'var(--editor-bg)',
                    borderRadius: 4,
                    border: '1px solid var(--editor-border)',
                    flexShrink: 0,
                  }}
                >
                  {action.shortcut}
                </span>
              )}
            </button>
          ))}

          {/* 更多格式折叠/展开卡片 */}
          <button
            type="button"
            onClick={() => setShowMoreFormats((prev) => !prev)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              border: '1px dashed var(--editor-border)',
              borderRadius: 8,
              background: showMoreFormats ? 'var(--toolbar-hover)' : 'var(--editor-surface)',
              cursor: 'pointer',
              fontSize: 13,
              color: 'var(--editor-text)',
              transition: 'all var(--transition-fast, 150ms ease)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Sparkles size={16} color="var(--editor-accent, #3b82f6)" />
              <span style={{ fontWeight: 500 }}>
                {showMoreFormats ? '收起其他格式' : '更多格式新建 (Draw.io, Mermaid, UML, JSON…)'}
              </span>
            </div>
            {showMoreFormats ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>

      {/* 展开的更多格式卡片网格 */}
      {showMoreFormats && (
        <div
          style={{
            marginTop: 18,
            width: '100%',
            maxWidth: 780,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
            gap: 10,
            padding: 16,
            background: 'var(--editor-surface)',
            border: '1px solid var(--editor-border)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-sm)',
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
                padding: '8px 10px',
                border: '1px solid var(--editor-border)',
                borderRadius: 6,
                background: 'var(--editor-bg)',
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--editor-text)',
                textAlign: 'left',
                transition: 'all 0.12s ease',
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
    </div>
  );
}
