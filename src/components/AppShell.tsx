// NoteBoard AppShell
// 三栏布局：资源管理器 | 编辑区 | 大纲
// 详见 docs/07-UI布局与交互规范.md §1

import { useEffect, useRef, useState, useMemo } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelSize } from 'react-resizable-panels';
import type { Editor } from '@tiptap/core';
import { TitleBar } from './titlebar/TitleBar';
import { StatusBar } from './statusbar/StatusBar';
import { WelcomeScreen } from './WelcomeScreen';
import { UnsupportedView } from './UnsupportedView';
import { ToastContainer } from './Toast';
import { RailToggle } from './rail/RailToggle';
import { FileDropOverlay } from './FileDropOverlay';
import { useWindowStore } from '../stores/windowStore';
import { useDocumentStore } from '../stores/documentStore';
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
import { ImageViewer } from '../features/image-viewer/ImageViewer';
import { MindmapEditor } from '../features/mindmap/MindmapEditor';
import { DrawioEditor } from '../features/drawio/DrawioEditor';
import { BitableEditor } from '../features/bitable/BitableEditor';
import { DiagramSplitEditor } from '../features/diagram-preview/DiagramSplitEditor';
import { OutlinePanel } from '../features/outline/OutlinePanel';
import { UnsavedGuardDialog } from '../features/editor-code/UnsavedGuardDialog';
import { Explorer } from '../features/explorer/Explorer';
import { SearchReplaceBar } from '../features/search/SearchReplaceBar';
import { EditorToolbar } from '../features/toolbar/EditorToolbar';
import { useSearchStore } from '../stores/searchStore';
import { getSelectedText } from '../features/search/searchController';
import { getEditorView } from '../features/editor-code/CodeEditor';
import { getActiveTipTapEditor, getActiveSourceView } from '../features/editor-md/TipTapEditor';
import { registerShortcut } from '../core/shortcuts';
import {
  handleExpandJson,
  handleMinifyJson,
  handleValidateJson,
} from '../features/editor-code/jsonOps';
import type { LanguageId } from '../core/ipc/types';
import { saveDocument } from '../features/editor-code/orchestration/saveDocument';
import { performWindowClose } from '../features/window/windowManager';
import {
  openFileDialog,
  openFolderDialog,
  openStagingArea,
  newMarkdown,
  newMindmap,
  newDrawio,
  newBitable,
  newBoard,
  newMermaid,
  newPlantUml,
  newJson,
  newYaml,
  newSql,
  newXml,
  newText,
} from '../features/welcome/welcomeActions';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { discardStagedDocuments, stashPendingDocuments } from '../features/staging/stagingManager';
import { showToast } from '../stores/toastStore';
import { hasUnsavedWork } from '../features/staging/stagingPolicy';
import {
  saveCurrentWindowSnapshot,
} from '../features/session/closedWindowSession';
import { MissingFileDialog } from '../features/external/MissingFileDialog';
import { checkActiveDocumentStillExists } from '../features/external/missingFileGuard';

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
  const documents = useDocumentStore((s) => s.documents);

  const {
    explorerVisible,
    explorerWidth,
    outlineVisible,
    outlineWidth,
    statusBarVisible,
    boardPresentationMode,
    toggleExplorer,
    toggleOutline,
  } = useLayoutStore();

  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);

  const explorerWidthRef = useRef<number>(explorerWidth);
  const outlineWidthRef = useRef<number>(outlineWidth);

  // 统一关闭拦截状态与操作
  const pendingCloseKeys = useWindowStore((s) => s.pendingCloseKeys);
  const confirmCloseBatch = useWindowStore((s) => s.confirmCloseBatch);
  const clearPendingClose = useWindowStore((s) => s.clearPendingClose);

  // 待关闭列表中处于脏态的标签页列表
  const dirtyPendingTabs = useMemo(() => {
    if (pendingCloseKeys.length === 0) return [];
    return tabs.filter((tab) => pendingCloseKeys.includes(tab.key) && hasUnsavedWork(tab.key));
  }, [pendingCloseKeys, tabs]);

  // 保存并关闭
  const handleSaveAndClose = async (keys: string[]) => {
    // 逐个保存待关闭的脏文档
    for (const key of keys) {
      const ok = await saveDocument(key);
      if (!ok) {
        // 用户在另存为对话框中取消了保存，中断关闭流程
        return;
      }
    }
    const targetKeys = [...useWindowStore.getState().pendingCloseKeys];
    const willCloseWindow = useWindowStore.getState().isWindowClosing;
    if (willCloseWindow) {
      // 窗口级关闭必须在技术性移除标签前记录，否则会把仍打开的标签误判成已独立关闭。
      try {
        await saveCurrentWindowSnapshot();
      } catch (error) {
        console.error('保存最近文件快照失败:', error);
        showToast('最近文件记录失败，但文件已经保存', 'warning');
      }
      await performWindowClose(getCurrentWindow().label, true);
    } else {
      confirmCloseBatch(targetKeys);
    }
  };

  // 丢弃修改并关闭
  const handleDiscardAndClose = async (keys: string[]) => {
    const targetKeys = [...useWindowStore.getState().pendingCloseKeys];
    const willCloseWindow = useWindowStore.getState().isWindowClosing;
    // “不保存”保持彻底丢弃语义，清理由自动关闭保护产生的副本。
    await discardStagedDocuments(keys);
    if (willCloseWindow) {
      try {
        // 明确丢弃的标签不进入最近文件，其余仍打开标签继续记录。
        await saveCurrentWindowSnapshot(keys);
      } catch (error) {
        console.error('保存最近文件快照失败:', error);
        showToast('最近文件记录失败，但仍会按“不保存”关闭', 'warning');
      }
      await performWindowClose(getCurrentWindow().label, true);
    } else {
      confirmCloseBatch(targetKeys);
    }
  };

  // 暂存：确认所有目标文档已写入用户设置的位置后才真正移除标签/关闭窗口。
  const handleStashAndClose = async (keys: string[]) => {
    try {
      await stashPendingDocuments({ keys, retain: true });
    } catch (error) {
      showToast(`暂存失败，窗口尚未关闭：${error instanceof Error ? error.message : String(error)}`, 'error', 5000);
      return;
    }
    const targetKeys = [...useWindowStore.getState().pendingCloseKeys];
    const willCloseWindow = useWindowStore.getState().isWindowClosing;
    if (willCloseWindow) {
      try {
        await saveCurrentWindowSnapshot();
      } catch (error) {
        console.error('保存最近文件快照失败:', error);
        showToast('最近文件记录失败，但暂存文件已经保留', 'warning');
      }
      await performWindowClose(getCurrentWindow().label, true);
    } else {
      confirmCloseBatch(targetKeys);
    }
  };

  // 取消关闭
  const handleCancelClose = () => {
    clearPendingClose();
  };

  // 右把手仅 Markdown 显示（不变式 I-17）
  const activeTab = tabs.find((t) => t.key === activeKey);
  const showOutline = activeTab?.kind === 'markdown';
  // 仅活动画板可以接管应用外壳；切到其他格式时立即恢复常规布局
  const isBoardPresentationMode = boardPresentationMode && activeTab?.kind === 'board';

  // 在应用空闲时预热 Diagrams.net，消除新建/打开 .drawio 时的网络冷启动耗时
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = 'https://embed.diagrams.net/?embed=1&ui=min&spin=1&proto=json&libraries=1';
    document.head.appendChild(link);
    return () => {
      if (document.head.contains(link)) document.head.removeChild(link);
    };
  }, []);

  // Ctrl+S 快捷键注册
  useEffect(() => {
    const unregCtrlS = registerShortcut({
      key: 'Ctrl+S',
      action: () => {
        const cur = useWindowStore.getState().activeKey;
        if (cur) {
          saveDocument(cur);
        }
      },
      scope: 'global',
      description: '保存当前文档',
    });

    // Ctrl+F 查找
    const unregCtrlF = registerShortcut({
      key: 'Ctrl+F',
      action: () => {
        const currentTab = useWindowStore.getState().activeTab();
        if (!currentTab) return;
        let target = null;
        if (currentTab.kind === 'markdown') {
          if (currentTab.viewMode === 'source') {
            const view = getActiveSourceView(currentTab.key);
            if (view) target = { type: 'codemirror' as const, view };
          } else {
            const editor = getActiveTipTapEditor(currentTab.key);
            if (editor) target = { type: 'tiptap' as const, editor };
          }
        } else if (currentTab.kind === 'code') {
          const view = getEditorView();
          if (view) target = { type: 'codemirror' as const, view };
        }
        const selected = target ? getSelectedText(target) : '';
        const searchStore = useSearchStore.getState();
        searchStore.openSearch(selected.trim() ? selected : undefined, 'search');
      },
      scope: 'global',
      description: '查找文本',
    });

    // Ctrl+H 替换
    const unregCtrlH = registerShortcut({
      key: 'Ctrl+H',
      action: () => {
        const currentTab = useWindowStore.getState().activeTab();
        if (!currentTab) return;
        let target = null;
        if (currentTab.kind === 'markdown') {
          if (currentTab.viewMode === 'source') {
            const view = getActiveSourceView(currentTab.key);
            if (view) target = { type: 'codemirror' as const, view };
          } else {
            const editor = getActiveTipTapEditor(currentTab.key);
            if (editor) target = { type: 'tiptap' as const, editor };
          }
        } else if (currentTab.kind === 'code') {
          const view = getEditorView();
          if (view) target = { type: 'codemirror' as const, view };
        }
        const selected = target ? getSelectedText(target) : '';
        const searchStore = useSearchStore.getState();
        searchStore.openSearch(selected.trim() ? selected : undefined, 'replace');
      },
      scope: 'global',
      description: '替换文本',
    });

    // Ctrl+W 关闭当前标签页
    const unregCtrlW = registerShortcut({
      key: 'Ctrl+W',
      action: () => {
        const curKey = useWindowStore.getState().activeKey;
        if (curKey) {
          useWindowStore.getState().requestCloseTab(curKey);
        }
      },
      scope: 'global',
      description: '关闭当前标签页',
    });

    // ── JSON 快捷操作（支持 .json / .txt / 源码模式等） ──

    // 1. JSON 展开 / 格式化 (Shift+Alt+F / Ctrl+Alt+L)
    const handleExpandAction = () => {
      const currentTab = useWindowStore.getState().activeTab();
      if (!currentTab) return;
      if (currentTab.kind === 'code') {
        const view = getEditorView();
        const doc = currentTab.key ? useDocumentStore.getState().documents.get(currentTab.key) : undefined;
        if (view) handleExpandJson(view, doc?.language as LanguageId);
      } else if (currentTab.kind === 'markdown' && currentTab.viewMode === 'source') {
        const view = getActiveSourceView(currentTab.key);
        if (view) handleExpandJson(view, 'markdown');
      }
    };

    const unregExpandShiftAltF = registerShortcut({
      key: 'Shift+Alt+F',
      action: handleExpandAction,
      scope: 'global',
      description: 'JSON 展开 / 格式化',
    });

    const unregExpandCtrlAltL = registerShortcut({
      key: 'Ctrl+Alt+L',
      action: handleExpandAction,
      scope: 'global',
      description: 'JSON 展开 / 格式化 (JetBrains)',
    });

    // 2. JSON 压缩 (Shift+Alt+M / Ctrl+Alt+M)
    const handleMinifyAction = () => {
      const currentTab = useWindowStore.getState().activeTab();
      if (!currentTab) return;
      if (currentTab.kind === 'code') {
        const view = getEditorView();
        if (view) handleMinifyJson(view);
      } else if (currentTab.kind === 'markdown' && currentTab.viewMode === 'source') {
        const view = getActiveSourceView(currentTab.key);
        if (view) handleMinifyJson(view);
      }
    };

    const unregMinifyShiftAltM = registerShortcut({
      key: 'Shift+Alt+M',
      action: handleMinifyAction,
      scope: 'global',
      description: 'JSON 压缩为单行',
    });

    const unregMinifyCtrlAltM = registerShortcut({
      key: 'Ctrl+Alt+M',
      action: handleMinifyAction,
      scope: 'global',
      description: 'JSON 压缩为单行',
    });

    // 3. JSON 格式校验 (Shift+Alt+V / Ctrl+Alt+V)
    const handleValidateAction = () => {
      const currentTab = useWindowStore.getState().activeTab();
      if (!currentTab) return;
      if (currentTab.kind === 'code') {
        const view = getEditorView();
        if (view) handleValidateJson(view);
      } else if (currentTab.kind === 'markdown' && currentTab.viewMode === 'source') {
        const view = getActiveSourceView(currentTab.key);
        if (view) handleValidateJson(view);
      }
    };

    const unregValidateShiftAltV = registerShortcut({
      key: 'Shift+Alt+V',
      action: handleValidateAction,
      scope: 'global',
      description: 'JSON 格式校验',
    });

    const unregValidateCtrlAltV = registerShortcut({
      key: 'Ctrl+Alt+V',
      action: handleValidateAction,
      scope: 'global',
      description: 'JSON 格式校验',
    });

    return () => {
      unregCtrlS();
      unregCtrlF();
      unregCtrlH();
      unregCtrlW();
      unregExpandShiftAltF();
      unregExpandCtrlAltL();
      unregMinifyShiftAltM();
      unregMinifyCtrlAltM();
      unregValidateShiftAltV();
      unregValidateCtrlAltV();
    };
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
      {!isBoardPresentationMode && <TitleBar key="app-titlebar" />}

      {/* 主区域 */}
      <div
        key="app-main"
        style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}
      >
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
          {!isBoardPresentationMode && explorerVisible && (
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
            key="nb-editor-panel"
            id="nb-editor"
            minSize="30%"
          >
            <div
              onFocusCapture={() => {
                checkActiveDocumentStillExists().catch(() => {});
              }}
              onPointerDownCapture={() => {
                checkActiveDocumentStillExists().catch(() => {});
              }}
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
              {!isBoardPresentationMode && (
                <RailToggle
                  side="left"
                  visible={explorerVisible}
                  onToggle={toggleExplorer}
                  ariaLabel="展开/收起资源管理器"
                />
              )}

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
                {/* 顶部操作栏（针对 Markdown 与代码/纯文本格式，支持多级菜单与收起/悬浮恢复） */}
                {!isBoardPresentationMode && tabs.length > 0 && activeTab && (
                  <EditorToolbar
                    activeTab={activeTab}
                    activeEditor={activeEditor}
                  />
                )}

                {tabs.length === 0 || !activeTab ? (
                  <WelcomeScreen
                    onOpenFile={openFileDialog}
                    onOpenFolder={openFolderDialog}
                    onOpenStaging={openStagingArea}
                    onNewMarkdown={newMarkdown}
                    onNewText={newText}
                    onNewBoard={newBoard}
                    onNewMindmap={newMindmap}
                    onNewDrawio={newDrawio}
                    onNewBitable={newBitable}
                    onNewMermaid={newMermaid}
                    onNewPlantUml={newPlantUml}
                    onNewJson={newJson}
                    onNewYaml={newYaml}
                    onNewSql={newSql}
                    onNewXml={newXml}
                  />
                ) : (
                  <div style={{ flex: 1, position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
                    {tabs.map((tab) => {
                      const isTabActive = tab.key === activeKey;
                      const tabDoc = documents.get(tab.key);

                      return (
                        <div
                          key={tab.key}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            width: '100%',
                            height: '100%',
                            overflow: 'hidden',
                            ...(isTabActive
                              ? { position: 'relative' }
                              : {
                                  position: 'absolute',
                                  top: -99999,
                                  left: -99999,
                                  opacity: 0,
                                  pointerEvents: 'none',
                                  visibility: 'hidden',
                                  zIndex: -1,
                                }),
                          }}
                        >
                          {tab.kind === 'unsupported' ? (
                            <UnsupportedView
                              filePath={tab.path ?? tab.key}
                              fileName={tab.displayName}
                              fileSize={tabDoc?.size}
                            />
                          ) : tab.kind === 'mindmap' ? (
                            <MindmapEditor docKey={tab.key} />
                          ) : tab.kind === 'drawio' ? (
                            <DrawioEditor docKey={tab.key} />
                          ) : tab.kind === 'bitable' ? (
                            <BitableEditor docKey={tab.key} />
                          ) : tab.kind === 'code' ? (
                            tab.language === 'mermaid' || tab.language === 'plantuml' ? (
                              <DiagramSplitEditor docKey={tab.key} />
                            ) : (
                              <CodeEditor docKey={tab.key} />
                            )
                          ) : tab.kind === 'markdown' ? (
                            <TipTapEditor
                              docKey={tab.key}
                              onEditorReady={isTabActive ? setActiveEditor : undefined}
                            />
                          ) : tab.kind === 'board' ? (
                            <BoardEditor docKey={tab.key} />
                          ) : tab.kind === 'image' ? (
                            <ImageViewer
                              filePath={tab.path ?? tab.key}
                              fileName={tab.displayName}
                              fileSize={tabDoc?.size}
                            />
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
                                    {tab.displayName}
                                  </div>
                                </div>
                              </div>
                            )
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* 右折叠把手（仅 Markdown） */}
                {!isBoardPresentationMode && tabs.length > 0 && (
                  <RailToggle
                    side="right"
                    visible={outlineVisible}
                    onToggle={toggleOutline}
                    show={showOutline}
                    ariaLabel="展开/收起大纲"
                  />
                )}

                {/* 自研现代搜索与替换栏 */}
                {!isBoardPresentationMode && <SearchReplaceBar />}
              </div>
            </div>
          </Panel>

          {/* 大纲 */}
          {!isBoardPresentationMode && outlineVisible && showOutline && (
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
      {!isBoardPresentationMode && statusBarVisible && <StatusBar key="app-statusbar" />}
      <UnsavedGuardDialog
        dirtyTabs={dirtyPendingTabs}
        visible={dirtyPendingTabs.length > 0}
        onSave={handleSaveAndClose}
        onStash={handleStashAndClose}
        onDiscard={handleDiscardAndClose}
        onCancel={handleCancelClose}
      />

      {/* 仅处理应用运行期间原文件被删除的活动标签；重启恢复缺失文件会直接跳过。 */}
      <MissingFileDialog />

      {/* 全局 Toast 提示 */}
      <ToastContainer />

      {/* 全局文件拖拽释放提示 */}
      {!isBoardPresentationMode && <FileDropOverlay />}
    </div>
  );
}
