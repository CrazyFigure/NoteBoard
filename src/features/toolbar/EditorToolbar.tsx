// NoteBoard 编辑器顶部统一操作栏容器
// 负责协调 Markdown 与代码/纯文本格式工具集渲染、收起与悬浮恢复机制
// 状态由 layoutStore 管理，与文档撤销/重做时间线完全隔离

import React from 'react';
import { ChevronUp } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import type { Tab } from '../../stores/windowStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { MarkdownToolbar } from './MarkdownToolbar';
import { CodeToolbar } from './CodeToolbar';
import { FloatingExpandHandle } from './FloatingExpandHandle';
import { ToolbarButton } from './ToolbarComponents';

interface EditorToolbarProps {
  activeTab: Tab | null;
  activeEditor: Editor | null;
}

export function EditorToolbar({ activeTab, activeEditor }: EditorToolbarProps) {
  const { editorToolbarVisible, setEditorToolbarVisible } = useLayoutStore();

  // 若当前无激活标签页或为画板/图片/不支持视图，不渲染操作栏
  if (!activeTab || (activeTab.kind !== 'markdown' && activeTab.kind !== 'code')) {
    return null;
  }

  // 1. 操作栏处于收起状态：渲染顶部感应热区与悬浮展开胶囊
  if (!editorToolbarVisible) {
    return <FloatingExpandHandle onExpand={() => setEditorToolbarVisible(true)} />;
  }

  // 2. 操作栏处于展开状态：渲染顶层工具栏容器
  return (
    <div
      style={{
        height: 36,
        minHeight: 36,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 8px 0 10px',
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
      {activeTab.kind === 'markdown' ? (
        <MarkdownToolbar
          docKey={activeTab.key}
          editor={activeEditor}
          viewMode={activeTab.viewMode}
        />
      ) : activeTab.kind === 'code' ? (
        <CodeToolbar
          docKey={activeTab.key}
          language={activeTab.language}
        />
      ) : null}

      {/* 右侧收起按钮 */}
      <div style={{ marginLeft: 8, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <ToolbarButton
          icon={<ChevronUp size={15} strokeWidth={2.2} />}
          title="收起操作栏"
          onClick={() => setEditorToolbarVisible(false)}
        />
      </div>
    </div>
  );
}
