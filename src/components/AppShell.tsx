// NoteBoard AppShell
// 三栏布局：资源管理器 | 编辑区 | 大纲
// 详见 docs/07-UI布局与交互规范.md §1

import { useEffect, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelSize } from 'react-resizable-panels';
import type { Editor } from '@tiptap/core';
import { TitleBar } from './titlebar/TitleBar';
import { StatusBar } from './statusbar/StatusBar';
import { WelcomeScreen } from './WelcomeScreen';
import { UnsupportedView } from './UnsupportedView';
import { ToastContainer } from './Toast';
import { RailToggle } from './rail/RailToggle';
import { useWindowStore } from '../stores/windowStore';
import { useDocumentStore } from '../stores/documentStore';
import { useReveal } from '../features/explorer/useReveal';
import {
  useLayoutStore,
  EXPLORER_MIN,
  EXPLORER_MAX,
  OUTLINE_MIN,
  OUTLINE_MAX,
} from '../stores/layoutStore';
import { CodeEditor } from '../features/editor-code/CodeEditor';
import { TipTapEditor } from '../features/editor-md/TipTapEditor';
import { BoardEditor } from '../features/board/BoardEditor';
import { OutlinePanel } from '../features/outline/OutlinePanel';
import { UnsavedGuardDialog, useUnsavedGuard } from '../features/editor-code/UnsavedGuardDialog';
import { Explorer } from '../features/explorer/Explorer';
import { registerShortcut } from '../core/shortcuts';
import { saveDocument } from '../features/editor-code/orchestration/saveDocument';
import { performWindowClose } from '../features/window/windowManager';
import {
  openFileDialog,
  openFolderDialog,
  newMarkdown,
  newBoard,
} from '../features/welcome/welcomeActions';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ── 分隔条样式 ──

function ResizeHandle() {
  return (
    <Separator
      style={{
        width: 4,
        height: '100%',
        background: 'var(--editor-border)',
        cursor: 'col-resize',
        transition: 'background var(--transition-fast)',
        flexShrink: 0,
      }}
      onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => {
        e.currentTarget.style.background = 'var(--editor-border-focus)';
      }}
      onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => {
        e.currentTarget.style.background = 'var(--editor-border)';
      }}
    />
  );
}

// ── AppShell ──

export function AppShell({ children }: { children?: React.ReactNode }) {
  const tabs = useWindowStore((s) => s.tabs);
  const activeKey = useWindowStore((s) => s.activeKey);
  const activeDoc = useDocumentStore((s) => (activeKey ? s.documents.get(activeKey) : undefined));

  // 纯跟随 + Reveal：全局跟随活跃 Tab 切换左侧资源管理器目录
  useReveal();

  const {
    explorerVisible,
    explorerWidth,
    outlineVisible,
    outlineWidth,
    toggleExplorer,
    toggleOutline,
  } = useLayoutStore();

  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);

  const explorerWidthRef = useRef<number>(explorerWidth);
  const outlineWidthRef = useRef<number>(outlineWidth);

  // 关闭拦截
  const {
    dirtyPendingTabs,
    cancelClose,
    confirmSaveAndClose,
    discardAndClose,
  } = useUnsavedGuard();

  // 窗口级关闭：当 pendingCloseKeys 由 windowManager 设置时，UnsavedGuardDialog 也响应
  const pendingCloseKeys = useWindowStore((s) => s.pendingCloseKeys);
  const confirmCloseBatch = useWindowStore((s) => s.confirmCloseBatch);
  const clearPendingClose = useWindowStore((s) => s.clearPendingClose);

  // 窗口级关闭的拦截对话框
  const isWindowClose = pendingCloseKeys.length > 0;
  const windowDirtyTabs = useWindowStore((s) =>
    s.pendingCloseKeys.length > 0
      ? s.tabs.filter((t) => s.pendingCloseKeys.includes(t.key) && t.isDirty)
      : dirtyPendingTabs
  );

  // 窗口级关闭的保存+关闭
  const handleWindowSaveAndClose = async (keys: string[]) => {
    for (const key of keys) {
      await saveDocument(key);
    }
    confirmCloseBatch(keys);
    // 所有 tab 关闭后 → 关窗口
    const remaining = useWindowStore.getState().tabs;
    if (remaining.length === 0 ||
        remaining.every((t) => keys.includes(t.key))) {
      await performWindowClose(getCurrentWindow().label);
    }
  };

  // 窗口级关闭的丢弃+关闭
  const handleWindowDiscardAndClose = (keys: string[]) => {
    confirmCloseBatch(keys);
    const remaining = useWindowStore.getState().tabs;
    if (remaining.length === 0) {
      performWindowClose(getCurrentWindow().label);
    }
  };

  // 窗口级关闭的取消
  const handleWindowCancelClose = () => {
    clearPendingClose();
  };

  // 右把手仅 Markdown 显示（不变式 I-17）
  const activeTab = tabs.find((t) => t.key === activeKey);
  const showOutline = activeTab?.kind === 'markdown';

  // Ctrl+S 快捷键注册
  useEffect(() => {
    const unreg = registerShortcut({
      key: 'Ctrl+S',
      action: () => {
        if (activeKey) {
          saveDocument(activeKey);
        }
      },
      scope: 'global',
      description: '保存当前文档',
    });
    return () => unreg();
  }, [activeKey]);

  // 组件卸载时将 ref 中的宽度写回 store（持久化）
  useEffect(() => {
    return () => {
      // 卸载时同步最终宽度到 store
      const finalExplorerW = explorerWidthRef.current;
      const finalOutlineW = outlineWidthRef.current;
      const store = useLayoutStore.getState();
      if (Math.abs(finalExplorerW - store.explorerWidth) > 1) {
        store.setExplorerWidth(finalExplorerW);
      }
      if (Math.abs(finalOutlineW - store.outlineWidth) > 1) {
        store.setOutlineWidth(finalOutlineW);
      }
    };
  }, []);

  const handleStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: 'var(--editor-bg)',
  };

  return (
    <div style={handleStyle}>
      {/* 标题栏 */}
      <TitleBar />

      {/* 主区域 */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        <Group
          id="nb-layout"
          orientation="horizontal"
          style={{ width: '100%', height: '100%' }}
          onLayoutChanged={(layout) => {
            // layout 是 Map<panelId, percentage>
            // ⚠️ 不能在此调用 setExplorerWidth/setOutlineWidth，
            // 否则会触发 Group 重渲染 → 再次 onLayoutChanged → 无限循环 → 白屏。
            // 宽度持久化通过 onResize 回调 + 组件卸载时写入 store。
            if (explorerVisible) {
              const pct = layout['nb-explorer'];
              if (typeof pct === 'number') {
                explorerWidthRef.current = (pct / 100) * window.innerWidth;
              }
            }
            if (outlineVisible && showOutline) {
              const pct = layout['nb-outline'];
              if (typeof pct === 'number') {
                outlineWidthRef.current = (pct / 100) * window.innerWidth;
              }
            }
          }}
        >
          {/* 资源管理器 */}
          {explorerVisible && (
            <>
              <Panel
                id="nb-explorer"
                defaultSize={explorerWidth}
                minSize={EXPLORER_MIN}
                maxSize={EXPLORER_MAX}
                onResize={(size: PanelSize) => {
                  explorerWidthRef.current = size.inPixels;
                }}
                style={{
                  background: 'var(--explorer-bg)',
                  borderRight: '1px solid var(--explorer-border)',
                  overflow: 'hidden',
                }}
              >
                <Explorer />
              </Panel>
              <ResizeHandle />
            </>
          )}

          {/* 编辑区 */}
          <Panel
            id="nb-editor"
            minSize="30%"
          >
            <div
              style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                background: 'var(--editor-bg)',
              }}
            >
              {/* 左折叠把手 */}
              <RailToggle
                side="left"
                visible={explorerVisible}
                onToggle={toggleExplorer}
                ariaLabel="展开/收起资源管理器"
              />

              {/* 编辑器内容 */}
              <div
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {tabs.length === 0 ? (
                  <WelcomeScreen
                    onOpenFile={openFileDialog}
                    onOpenFolder={openFolderDialog}
                    onNewMarkdown={newMarkdown}
                    onNewBoard={newBoard}
                  />
                ) : activeTab ? (
                  activeTab.kind === 'unsupported' ? (
                    <UnsupportedView
                      key={activeTab.key}
                      filePath={activeTab.path ?? activeTab.key}
                      fileName={activeTab.displayName}
                      fileSize={activeDoc?.size}
                    />
                  ) : activeTab.kind === 'code' ? (
                    <CodeEditor key={activeTab.key} docKey={activeTab.key} />
                  ) : activeTab.kind === 'markdown' ? (
                    <TipTapEditor key={activeTab.key} docKey={activeTab.key} onEditorReady={setActiveEditor} />
                  ) : activeTab.kind === 'board' ? (
                    <BoardEditor key={activeTab.key} docKey={activeTab.key} />
                  ) : (
                    children ?? (
                      <div
                        style={{
                          padding: 24,
                          overflow: 'auto',
                          height: '100%',
                        }}
                      >
                        <div style={{ maxWidth: 'var(--content-max-width)', margin: '0 auto' }}>
                          <div
                            style={{
                              fontSize: 'var(--content-font-size)',
                              lineHeight: 'var(--content-line-height)',
                              color: 'var(--editor-text)',
                            }}
                          >
                            {activeTab?.displayName}
                          </div>
                        </div>
                      </div>
                    )
                  )
                ) : null}

                {/* 右折叠把手（仅 Markdown） */}
                {tabs.length > 0 && (
                  <RailToggle
                    side="right"
                    visible={outlineVisible}
                    onToggle={toggleOutline}
                    show={showOutline}
                    ariaLabel="展开/收起大纲"
                  />
                )}
              </div>
            </div>
          </Panel>

          {/* 大纲 */}
          {outlineVisible && showOutline && (
            <>
              <ResizeHandle />
              <Panel
                id="nb-outline"
                defaultSize={outlineWidth}
                minSize={OUTLINE_MIN}
                maxSize={OUTLINE_MAX}
                onResize={(size: PanelSize) => {
                  outlineWidthRef.current = size.inPixels;
                }}
                style={{
                  background: 'var(--outline-bg)',
                  borderLeft: '1px solid var(--editor-border)',
                  overflow: 'hidden',
                }}
              >
                <OutlinePanel editor={activeEditor} />
              </Panel>
            </>
          )}
        </Group>
      </div>

      {/* 状态栏 */}
      <StatusBar />

      {/* 关闭拦截对话框 */}
      <UnsavedGuardDialog
        dirtyTabs={isWindowClose ? windowDirtyTabs : dirtyPendingTabs}
        visible={isWindowClose ? windowDirtyTabs.length > 0 : dirtyPendingTabs.length > 0}
        onSave={isWindowClose ? handleWindowSaveAndClose : confirmSaveAndClose}
        onDiscard={isWindowClose ? handleWindowDiscardAndClose : discardAndClose}
        onCancel={isWindowClose ? handleWindowCancelClose : cancelClose}
      />

      {/* 全局 Toast 提示 */}
      <ToastContainer />
    </div>
  );
}
