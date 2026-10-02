// NoteBoard 移动端编辑页
// 顶栏（返回 / 文档名与保存状态 / 保存 / 更多）→ 编辑器全屏（复用保活编辑器堆栈）→ 底部格式栏。
// 底部格式栏直接复用桌面 Markdown / 代码工具栏（撤销重做、标题、列表、插入等），横向滚动展示；
// 大纲、查找替换、模式切换、另存为、分享、关闭等收纳到"更多"面板。

import { useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import {
  Code2,
  Eye,
  FileOutput,
  ListTree,
  MoreVertical,
  Save,
  Search,
  Share2,
  X,
  Files,
} from 'lucide-react';
import { emit } from '../core/emitter';
import { getExplorerFileIcon } from '../features/explorer/fileIcons';
import { OutlinePanel } from '../features/outline/OutlinePanel';
import { SearchReplaceBar } from '../features/search/SearchReplaceBar';
import { MarkdownToolbar } from '../features/toolbar/MarkdownToolbar';
import { CodeToolbar } from '../features/toolbar/CodeToolbar';
import { saveAs, saveDocument } from '../features/editor-code/orchestration/saveDocument';
import { getEditorCapabilities } from '../core/editor/editorRegistry';
import { useSearchStore } from '../stores/searchStore';
import { useLayoutStore } from '../stores/layoutStore';
import { useWindowStore, type Tab } from '../stores/windowStore';
import { EditorStack } from '../components/shell/EditorStack';
import { ActionSheet, BottomSheet, IconButton, TopBar, type SheetAction } from './components';
import { shareEntry } from './mobileFiles';
import { useMobileStore } from './mobileStore';

export interface MobileEditorPageProps {
  activeTab: Tab | null;
  activeEditor: Editor | null;
  getMarkdownEditorReadyHandler: (docKey: string) => (editor: Editor | null) => void;
}

/** 文档所在文件夹名（用作副标题） */
function folderLabel(tab: Tab): string {
  if (!tab.path) return '未保存的新文档';
  const parts = tab.path.split(/[/\\]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : tab.path;
}

export function MobileEditorPage({ activeTab, activeEditor, getMarkdownEditorReadyHandler }: MobileEditorPageProps) {
  const tabs = useWindowStore((s) => s.tabs);
  const activeKey = useWindowStore((s) => s.activeKey);
  const transferringKeys = useWindowStore((s) => s.transferringKeys);
  const activateTab = useWindowStore((s) => s.activateTab);
  const requestCloseTab = useWindowStore((s) => s.requestCloseTab);
  const setPage = useMobileStore((s) => s.setPage);
  const page = useMobileStore((s) => s.page);

  const [moreOpen, setMoreOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const isMarkdown = activeTab?.kind === 'markdown';
  const isTextual = !!activeTab && (activeTab.kind === 'markdown' || activeTab.kind === 'code') && activeTab.toolKind !== 'textdiff';
  const isVisible = page === 'editor' && !!activeTab;
  // 画板演示模式：隐藏顶栏与格式栏，画布独占屏幕
  const boardPresentationMode = useLayoutStore((s) => s.boardPresentationMode);
  const isPresenting = boardPresentationMode && activeTab?.kind === 'board';

  // 打开查找：带入当前选中文本（与桌面 Ctrl+F 一致）
  const openSearch = () => {
    if (!activeTab) return;
    const selected = getEditorCapabilities(activeTab.key)?.getSelectedText() ?? '';
    useSearchStore.getState().openSearch(selected.trim() ? selected : undefined, 'search');
  };

  const moreActions: SheetAction[] = [];
  if (activeTab) {
    if (isMarkdown) {
      moreActions.push({ key: 'outline', label: '大纲', icon: <ListTree size={18} />, onSelect: () => setOutlineOpen(true) });
      moreActions.push({
        key: 'mode',
        label: activeTab.viewMode === 'source' ? '切换到可视化模式' : '切换到源码模式',
        icon: activeTab.viewMode === 'source' ? <Eye size={18} /> : <Code2 size={18} />,
        onSelect: () => emit('toggle-md-view-mode', { key: activeTab.key }),
      });
    }
    if (isTextual) {
      moreActions.push({ key: 'search', label: '查找与替换', icon: <Search size={18} />, onSelect: openSearch });
    }
    if (activeTab.toolKind !== 'textdiff') {
      moreActions.push({ key: 'saveas', label: '另存为', icon: <FileOutput size={18} />, onSelect: () => void saveAs(activeTab.key, '') });
    }
    if (activeTab.path) {
      moreActions.push({
        key: 'share',
        label: '分享 / 用其他应用打开',
        description: '分享的是已保存的版本',
        icon: <Share2 size={18} />,
        onSelect: () => void shareEntry(activeTab.path!),
      });
    }
    if (tabs.length > 1) {
      moreActions.push({ key: 'switch', label: `切换文档（${tabs.length}）`, icon: <Files size={18} />, onSelect: () => setSwitcherOpen(true) });
    }
    moreActions.push({ key: 'close', label: '关闭文档', icon: <X size={18} />, onSelect: () => requestCloseTab(activeTab.key) });
  }

  let formatBar: ReactNode = null;
  if (activeTab && isTextual) {
    formatBar = activeTab.kind === 'markdown'
      ? <MarkdownToolbar docKey={activeTab.key} editor={activeEditor} viewMode={activeTab.viewMode} />
      : <CodeToolbar docKey={activeTab.key} language={activeTab.language} />;
  }

  return (
    <div className="nb-m-page nb-m-editor-page" style={{ display: isVisible ? 'flex' : 'none' }}>
      {activeTab && !isPresenting && (
        <TopBar
          onBack={() => setPage('home')}
          title={
            <span className="nb-m-doc-title">
              <span className="nb-m-doc-title-text">{activeTab.displayName}</span>
              {activeTab.isDirty && <span className="nb-m-dirty-dot" aria-label="未保存" />}
            </span>
          }
          subtitle={folderLabel(activeTab)}
          onTitleClick={tabs.length > 1 ? () => setSwitcherOpen(true) : undefined}
          actions={
            <>
              {activeTab.toolKind !== 'textdiff' && (activeTab.isDirty || !activeTab.path) && (
                <IconButton icon={<Save size={20} />} label="保存" onClick={() => void saveDocument(activeTab.key)} className="nb-m-save-btn" />
              )}
              <IconButton icon={<MoreVertical size={20} />} label="更多" onClick={() => setMoreOpen(true)} />
            </>
          }
        />
      )}

      {/* 编辑器区域：保活堆栈（id 与桌面一致，工具栏下拉据此计算可用宽度） */}
      <div id="nb-editor" className="nb-m-editor-body">
        <EditorStack
          tabs={tabs}
          activeKey={activeKey}
          transferringKeys={transferringKeys}
          hasActiveTab={!!activeTab}
          getMarkdownEditorReadyHandler={getMarkdownEditorReadyHandler}
        />
        <SearchReplaceBar />
      </div>

      {/* 底部格式栏：横向滚动；随键盘弹起贴住键盘上沿（interactive-widget=resizes-content） */}
      {formatBar && !isPresenting && <div className="nb-m-format-bar">{formatBar}</div>}

      <ActionSheet open={moreOpen} onClose={() => setMoreOpen(false)} title={activeTab?.displayName} actions={moreActions} />

      {/* 大纲：点击标题后跳转并收起 */}
      <BottomSheet open={outlineOpen} onClose={() => setOutlineOpen(false)} title="大纲" size="tall">
        <div
          className="nb-m-outline"
          onClickCapture={(event) => {
            // 点击标题行（非筛选输入框）后关闭面板，让用户看到跳转结果
            if ((event.target as HTMLElement).closest('input')) return;
            window.setTimeout(() => setOutlineOpen(false), 120);
          }}
        >
          <OutlinePanel editor={activeEditor} />
        </div>
      </BottomSheet>

      {/* 已打开文档切换 */}
      <BottomSheet open={switcherOpen} onClose={() => setSwitcherOpen(false)} title="已打开的文档">
        <div className="nb-m-action-list">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`nb-m-action${tab.key === activeKey ? ' is-current' : ''}`}
              onClick={() => {
                setSwitcherOpen(false);
                activateTab(tab.key);
              }}
            >
              <span className="nb-m-action-icon">{getExplorerFileIcon(tab.displayName, { size: 18 })}</span>
              <span className="nb-m-action-text">
                <span className="nb-m-action-label">
                  {tab.displayName}
                  {tab.isDirty && <span className="nb-m-dirty-dot" aria-label="未保存" />}
                </span>
                <span className="nb-m-action-desc">{tab.path ?? '未保存的新文档'}</span>
              </span>
            </button>
          ))}
        </div>
      </BottomSheet>
    </div>
  );
}
