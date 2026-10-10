// NoteBoard AppShell
// 三栏布局：资源管理器 | 编辑区 | 大纲
// 详见 docs/07-UI布局与交互规范.md §1

import { useEffect, useRef } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelSize } from 'react-resizable-panels';
import { TitleBar } from './titlebar/TitleBar';
import { StatusBar } from './statusbar/StatusBar';
import { WelcomeScreen } from './WelcomeScreen';
import { ToastContainer } from './Toast';
import { RailToggle } from './rail/RailToggle';
import { FileDropOverlay } from './FileDropOverlay';
import { EditorStack } from './shell/EditorStack';
import { useCloseGuardHandlers, useMarkdownEditorRegistry, useRestoredTabLoader } from './shell/shellHooks';
import { useWindowStore } from '../stores/windowStore';
import {
  useLayoutStore,
  EXPLORER_MIN,
  EXPLORER_MAX,
  OUTLINE_MIN,
  OUTLINE_MAX,
} from '../stores/layoutStore';
// 🔴 S05：全部编辑器按类型懒加载（EditorStack → EditorHost + editorLoaders），壳不再静态导入任何编辑器
import { OutlinePanel } from '../features/outline/OutlinePanel';
import { UnsavedGuardDialog } from '../features/editor-code/UnsavedGuardDialog';
import { Explorer } from '../features/explorer/Explorer';
import { SearchReplaceBar } from '../features/search/SearchReplaceBar';
import { EditorToolbar } from '../features/toolbar/EditorToolbar';
import { useSearchStore } from '../stores/searchStore';
// 🔴 S03：快捷键与工具栏统一走 core 能力注册表，不再从编辑器组件导入实例 getter
import { getEditorCapabilities } from '../core/editor/editorRegistry';
import { registerShortcut } from '../core/shortcuts';
import { saveDocument } from '../features/editor-code/orchestration/saveDocument';
import {
  openFileDialog,
  openFolderDialog,
  openStagingArea,
  openSyncFolder,
  newMarkdown,
  newMindmap,
  newTextDiff,
  newDrawio,
  newBitable,
  newBoard,
  newMermaid,
  newPlantUml,
  newInfographic,
  newJson,
  newSql,
  newText,
} from '../features/welcome/welcomeActions';
import { useFavoritesStore } from '../features/favorites/favoritesStore';
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

export function AppShell(_props: { children?: React.ReactNode }) {
  const tabs = useWindowStore((s) => s.tabs);
  const activeKey = useWindowStore((s) => s.activeKey);
  // 🔴 迁移保护中的文档：阻断编辑输入（pointerEvents），避免迁移期间新修改无法同步到目标
  const transferringKeys = useWindowStore((s) => s.transferringKeys);
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

  // Markdown 内核登记（大纲数据源）：桌面/移动外壳共用
  const { activeEditor, getMarkdownEditorReadyHandler } = useMarkdownEditorRegistry(tabs, activeKey);

  const explorerWidthRef = useRef<number>(explorerWidth);
  const outlineWidthRef = useRef<number>(outlineWidth);

  // 统一关闭拦截状态与操作（桌面/移动外壳共用）
  const {
    dirtyPendingTabs,
    handleSaveAndClose,
    handleDiscardAndClose,
    handleStashAndClose,
    handleCancelClose,
  } = useCloseGuardHandlers(tabs);

  // 右把手仅 Markdown 显示（不变式 I-17）
  const activeTab = tabs.find((t) => t.key === activeKey);
  const showOutline = activeTab?.kind === 'markdown';
  // 仅活动画板可以接管应用外壳；切到其他格式时立即恢复常规布局
  const isBoardPresentationMode = boardPresentationMode && activeTab?.kind === 'board';

  // 🔴 S05：已移除 AppShell 的全局 Drawio 空闲预热（E 节 8：取消无意图的全编辑器空闲
  //    预热；.drawio 首次打开时由编辑器自身按需加载，远程资源耗时单独统计）

  // 🔴 S10：激活会话恢复的轻量标签时按需加载正文
  useRestoredTabLoader(activeKey);

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
        // 选中文本经能力注册表按当前模式获取（code / markdown visual / markdown source）
        const capabilities = getEditorCapabilities(currentTab.key);
        const selected = capabilities?.getSelectedText() ?? '';
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
        const capabilities = getEditorCapabilities(currentTab.key);
        const selected = capabilities?.getSelectedText() ?? '';
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
      // code 与 markdown 源码模式均通过能力注册表分发；能力内部按当前模式判断可用性
      getEditorCapabilities(currentTab.key)?.codeOps?.expandJson();
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
      getEditorCapabilities(currentTab.key)?.codeOps?.minifyJson();
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
      getEditorCapabilities(currentTab.key)?.codeOps?.validateJson();
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
  // 所有 action 都在触发时读取 store 中的活动标签，无需随文件切换反复注销和注册。
  }, []);

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

                {/* 🔴 N08：Home 与编辑器容器并存——显示 Home（无活动标签）不销毁 */}
                {/* 已打开文档的会话/实例；不可回收类型（Markdown/Board 等）的实例保持挂载。 */}
                {/* display:none 不卸载 React 组件，编辑器内核与撤销历史完整保留。 */}
                {tabs.length === 0 || !activeTab ? (
                  <WelcomeScreen
                    onOpenFile={openFileDialog}
                    onOpenFolder={openFolderDialog}
                    onOpenStaging={openStagingArea}
                    onOpenSyncFolder={openSyncFolder}
                    onOpenFavorites={() => useFavoritesStore.getState().openFavoritesModal()}
                    onNewMarkdown={newMarkdown}
                    onNewText={newText}
                    onNewBoard={newBoard}
                    onNewMindmap={newMindmap}
                    onTextDiff={newTextDiff}
                    onNewDrawio={newDrawio}
                    onNewBitable={newBitable}
                    onNewMermaid={newMermaid}
                    onNewPlantUml={newPlantUml}
                    onNewInfographic={newInfographic}
                    onNewJson={newJson}
                    onNewSql={newSql}
                  />
                ) : null}
                <EditorStack
                  tabs={tabs}
                  activeKey={activeKey}
                  transferringKeys={transferringKeys}
                  hasActiveTab={!!activeTab}
                  getMarkdownEditorReadyHandler={getMarkdownEditorReadyHandler}
                />

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
