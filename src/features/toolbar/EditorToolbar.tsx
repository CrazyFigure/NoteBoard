// NoteBoard 编辑器顶部统一操作栏容器
// 负责协调 Markdown 与代码/纯文本格式工具集渲染、收起与悬浮恢复机制
// 状态由 layoutStore 管理，与文档撤销/重做时间线完全隔离

import React, { lazy, Suspense } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { BookOpen, ChevronUp, History } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import type { Tab } from '../../stores/windowStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { CodeToolbar } from './CodeToolbar';
import { FloatingExpandHandle } from './FloatingExpandHandle';
import { ToolbarButton, ToolbarDivider, ToolbarDropdownItem } from './ToolbarComponents';
import { requestReadingMode } from '../reading/readingMode';
import { openVersionHistory } from '../versionHistory/versionHistoryStore';

// Markdown 专用按钮依赖富文本扩展与导出逻辑，只在该格式成为活动文档时装载。
const MarkdownToolbar = lazy(() => import('./MarkdownToolbar').then((module) => ({ default: module.MarkdownToolbar })));
const MarkdownExportMenu = lazy(() => import('./MarkdownExportMenu').then((module) => ({ default: module.MarkdownExportMenu })));

interface EditorToolbarProps {
  activeTab: Tab | null;
  activeEditor: Editor | null;
}

export function EditorToolbar({ activeTab, activeEditor }: EditorToolbarProps) {
  // 工具栏不跟随菜单计数或窗口停靠状态重绘，避免一次菜单操作刷新整套格式按钮。
  const { editorToolbarVisible, setEditorToolbarVisible, compactMode } = useLayoutStore(useShallow((s) => ({
    editorToolbarVisible: s.editorToolbarVisible, setEditorToolbarVisible: s.setEditorToolbarVisible, compactMode: s.compactMode,
  })));

  // 若当前无激活标签页、非文本格式或为纯前端工具视图（如文本对比），不渲染操作栏
  // 恢复标签正文加载中也不渲染：编辑器尚未挂载，且未知扩展名（.lnk/.docx 等）
  // 按路径暂推断为 code，加载后才知道真实类型，避免闪出无效的代码工具栏
  if (
    !activeTab ||
    (activeTab.kind !== 'markdown' && activeTab.kind !== 'code') ||
    activeTab.toolKind === 'textdiff' ||
    activeTab.lazySource
  ) {
    return null;
  }

  // 1. 操作栏处于收起状态：渲染顶部感应热区与悬浮展开胶囊
  if (!editorToolbarVisible) {
    return <FloatingExpandHandle onExpand={() => setEditorToolbarVisible(true)} />;
  }

  // 极窄模式：历史记录收进各格式的「更多」菜单，导出与沉浸阅读（需全屏）不提供
  const compactMoreItems = compactMode ? (
    <ToolbarDropdownItem
      icon={<History size={14} />}
      label="历史记录"
      shortcut="Ctrl+Alt+Z"
      onClick={() => openVersionHistory(activeTab.key)}
    />
  ) : undefined;

  // 2. 操作栏处于展开状态：渲染顶层工具栏容器
  return (
    <div
      style={{
        height: 36,
        minHeight: 36,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: compactMode ? '0 4px 0 6px' : '0 8px 0 10px',
        background: 'var(--editor-surface, var(--editor-bg))',
        borderBottom: '1px solid var(--editor-border)',
        zIndex: 15,
        position: 'relative',
        userSelect: 'none',
        flexShrink: 0,
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.02)',
      }}
    >
      {/* 格式针对性工具集 */}
      <Suspense fallback={null}>
      {activeTab.kind === 'markdown' ? (
        <MarkdownToolbar
          docKey={activeTab.key}
          editor={activeEditor}
          viewMode={activeTab.viewMode}
          compact={compactMode}
          moreItems={compactMoreItems}
        />
      ) : activeTab.kind === 'code' ? (
        <CodeToolbar
          docKey={activeTab.key}
          language={activeTab.language}
          compact={compactMode}
          moreItems={compactMoreItems}
        />
      ) : null}
      </Suspense>

      {/* 右侧视图操作：导出（仅 Markdown）、沉浸阅读（Markdown、代码与 Mermaid / PlantUML / 信息图）与收起按钮 */}
      <div style={{ marginLeft: compactMode ? 2 : 8, display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        {!compactMode && (
          <>
            {activeTab.kind === 'markdown' && <Suspense fallback={null}><MarkdownExportMenu tab={activeTab} editor={activeEditor} /></Suspense>}
            <ToolbarButton
              icon={<History size={15} strokeWidth={2.2} />}
              title="历史记录"
              shortcut="Ctrl+Alt+Z"
              onClick={() => openVersionHistory(activeTab.key)}
            />
            <ToolbarButton
              icon={<BookOpen size={15} strokeWidth={2.2} />}
              title="沉浸阅读"
              onClick={() => requestReadingMode(true)}
            />
          </>
        )}
        {!compactMode && <ToolbarDivider />}
        <ToolbarButton
          icon={<ChevronUp size={15} strokeWidth={2.2} />}
          title="收起操作栏"
          onClick={() => setEditorToolbarVisible(false)}
        />
      </div>
    </div>
  );
}
