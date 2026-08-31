// NoteBoard Excalidraw 画板编辑器
// 动态 import + 自动保存 + 视口保持 + 版本检查
// 详见 docs/09-开发路线图.md 10.1/10.6/10.7/10.10

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import '@excalidraw/excalidraw/index.css';
import { parseScene, serializeScene, createEmptyScene, cleanAppState, isVersionSupported, getElementCount, getBoardHistorySignature, type ExcalidrawScene, type ExcalidrawFileData } from './sceneIo';
import { mapTheme } from './excalidrawTheme';
import { BoardPresentationToggle } from './BoardPresentationToggle';
import { FlowchartQuickConnect } from './FlowchartQuickConnect';
import { Tooltip } from '../../components/Tooltip';
import { useDocumentStore } from '../../stores/documentStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useWindowStore } from '../../stores/windowStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { showToast } from '../../stores/toastStore';
import * as ipc from '../../core/ipc/commands';
import {
  getDocumentHistoryAvailability,
  initializeDocumentHistory,
  markDocumentHistoryModeBoundary,
  recordDocumentChange,
  redoDocumentHistory,
  registerDocumentHistoryAdapter,
  synchronizeCurrentDocumentHistoryContent,
  undoDocumentHistory,
} from '../history/documentHistory';

interface BoardEditorProps {
  docKey: string;
}

/** 活动画板场景全局获取注册表（供快捷保存与另存为立即取值） */
const activeBoardScenes = new Map<string, () => ExcalidrawScene | null>();

/** 获取指定文档当前处于内存中的最新画板场景对象 */
export function getActiveBoardScene(docKey: string): ExcalidrawScene | null {
  const getter = activeBoardScenes.get(docKey);
  return getter ? getter() : null;
}

/** Excalidraw 组件（延迟加载） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ExcalidrawComponent: React.ComponentType<any> | null = null;
let loadingPromise: Promise<typeof import('@excalidraw/excalidraw')> | null = null;

async function loadExcalidraw() {
  if (ExcalidrawComponent) return ExcalidrawComponent;
  if (!loadingPromise) {
    loadingPromise = import('@excalidraw/excalidraw').then((mod) => {
      ExcalidrawComponent = mod.Excalidraw;
      return mod;
    });
  }
  const mod = await loadingPromise;
  return mod.Excalidraw;
}

export function BoardEditor({ docKey }: BoardEditorProps) {
  return (
    <BoardErrorBoundary key={docKey} docKey={docKey}>
      <BoardEditorInner key={docKey} docKey={docKey} />
    </BoardErrorBoundary>
  );
}

const UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: true,
    clearCanvas: true,
    export: { saveAsImage: true },
    loadScene: false,
    saveToActiveFile: false,
    toggleTheme: false,
  },
};

interface CanvasProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Component: React.ComponentType<any>;
  initialData: Record<string, unknown>;
  theme: 'light' | 'dark';
  onChange: (elements: ExcalidrawScene['elements'], appState: ExcalidrawScene['appState'], files: ExcalidrawScene['files']) => void;
  onApi: (api: BoardApi) => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
  /** 纯净演示模式同时启用 Excalidraw 只读视图与禅模式，隐藏内部编辑操作栏 */
  presentationMode: boolean;
}

/** 画板历史应用所需的 Excalidraw 命令子集 */
interface BoardApi {
  updateScene: (scene: Partial<ExcalidrawScene> & { captureUpdate?: 'NEVER' | 'EVENTUALLY' | 'IMMEDIATELY' }) => void;
  addFiles?: (files: ExcalidrawFileData[]) => void;
  getSceneElements?: () => ExcalidrawScene['elements'];
}

// 采用 React.memo 深度隔离 Excalidraw 画布组件，阻断父级任何状态更新导致的内部重渲染死锁
const ExcalidrawCanvas = React.memo(
  function ExcalidrawCanvas({
    Component,
    initialData,
    theme,
    onChange,
    onApi,
    onPointerDown,
    onPointerUp,
    presentationMode,
  }: CanvasProps) {
    return (
      <Component
        initialData={initialData}
        onChange={onChange}
        theme={theme}
        langCode="zh-CN"
        UIOptions={UI_OPTIONS}
        excalidrawAPI={onApi}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        viewModeEnabled={presentationMode}
        zenModeEnabled={presentationMode}
      />
    );
  },
  (prev, next) => {
    // 仅在核心实体变更时重绘
    return (
      prev.Component === next.Component &&
      prev.theme === next.theme &&
      prev.onChange === next.onChange &&
      prev.onApi === next.onApi &&
      prev.onPointerDown === next.onPointerDown &&
      prev.onPointerUp === next.onPointerUp &&
      prev.presentationMode === next.presentationMode &&
      prev.initialData === next.initialData
    );
  },
);

function BoardEditorInner({ docKey }: BoardEditorProps) {
  const [Component, setComponent] = useState<typeof ExcalidrawComponent>(null);
  const [initialData, setInitialData] = useState<ExcalidrawScene | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [elementCount, setElementCount] = useState(0);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [historyAvailability, setHistoryAvailability] = useState({ canUndo: false, canRedo: false });
  // 实时画板状态与元素列表（仅用于快捷连接浮层，ExcalidrawCanvas 本身由 React.memo 隔离不会触发内部重绘）
  const [liveAppState, setLiveAppState] = useState<ExcalidrawScene['appState'] | null>(null);
  const [liveElements, setLiveElements] = useState<ExcalidrawScene['elements']>([]);
  const boardPresentationMode = useLayoutStore((s) => s.boardPresentationMode);
  const setBoardPresentationMode = useLayoutStore((s) => s.setBoardPresentationMode);
  const storeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diskTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 串行化原生窗口全屏请求，避免快速连点造成较晚完成的旧请求覆盖最新状态 */
  const fullscreenOperationRef = useRef<Promise<void>>(Promise.resolve());
  /** 保存用户最新期望值，供异步全屏请求和卸载清理判断 */
  const desiredPresentationModeRef = useRef(boardPresentationMode);
  const apiRef = useRef<BoardApi | null>(null);
  const boardRootRef = useRef<HTMLDivElement>(null);
  const initializedDocKeyRef = useRef<string | null>(null);
  const sceneRef = useRef<ExcalidrawScene | null>(null);
  const docKeyRef = useRef(docKey);
  docKeyRef.current = docKey;

  const themeMode = useSettingsStore((s) => s.settings.appearance.themeMode);
  const theme = mapTheme(themeMode);
  const initialMountHandledRef = useRef<boolean>(false);
  const lastCommittedSignatureRef = useRef<string>('');
  // 同一次鼠标手势内的连续 onChange 必须合并成一个撤销步骤
  const pointerGestureActiveRef = useRef(false);
  const pointerGestureChangedRef = useRef(false);
  const lastHistoryChangeAtRef = useRef(0);
  // 程序化应用历史后，等待 Excalidraw 的异步 onChange 到达并禁止反向记录成新分支
  const historyApplyTargetSignatureRef = useRef<string | null>(null);

  /** 非指针连续输入（例如文字键入）的历史分组间隔 */
  const BOARD_HISTORY_GROUP_DELAY_MS = 300;

  /**
   * 切换纯净画板与原生窗口全屏。
   * 这里只修改临时布局状态和 Tauri 窗口状态，绝不调用场景更新或文档历史接口。
   */
  const requestBoardPresentationMode = useCallback((enabled: boolean) => {
    desiredPresentationModeRef.current = enabled;
    setBoardPresentationMode(enabled);

    fullscreenOperationRef.current = fullscreenOperationRef.current
      .catch(() => undefined)
      .then(async () => {
        // 队列尚未执行时用户可能已经再次切换，过期请求可直接跳过
        if (desiredPresentationModeRef.current !== enabled) return;
        try {
          await getCurrentWindow().setFullscreen(enabled);
        } catch (error) {
          console.error(enabled ? '进入画板全屏演示失败:' : '退出画板全屏演示失败:', error);
          // 仅回滚仍是最新意图的失败请求，避免破坏后续切换结果
          if (desiredPresentationModeRef.current === enabled) {
            desiredPresentationModeRef.current = !enabled;
            setBoardPresentationMode(!enabled);
            showToast(enabled ? '无法进入系统全屏，请稍后重试' : '无法退出系统全屏，请按 Esc 重试', 'error');
          }
        }
      });
  }, [setBoardPresentationMode]);

  const handleTogglePresentationMode = useCallback(() => {
    requestBoardPresentationMode(!desiredPresentationModeRef.current);
  }, [requestBoardPresentationMode]);

  // 全屏演示期间用 Esc 退出；捕获阶段优先于 Excalidraw，避免按键被内部快捷键吞掉
  useEffect(() => {
    if (!boardPresentationMode) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      requestBoardPresentationMode(false);
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [boardPresentationMode, requestBoardPresentationMode]);

  // 切换标签页、文档或关闭画板时必须退出原生全屏，防止应用外壳长期不可见
  useEffect(() => {
    return () => {
      if (!desiredPresentationModeRef.current) return;
      desiredPresentationModeRef.current = false;
      setBoardPresentationMode(false);
      fullscreenOperationRef.current = fullscreenOperationRef.current
        .catch(() => undefined)
        .then(async () => {
          try {
            await getCurrentWindow().setFullscreen(false);
          } catch (error) {
            console.error('卸载画板时退出全屏失败:', error);
          }
        });
    };
  }, [setBoardPresentationMode]);

  /** 从文件级时间线刷新画板工具栏的撤销/重做可用状态 */
  const refreshHistoryAvailability = useCallback((key = docKeyRef.current) => {
    setHistoryAvailability(getDocumentHistoryAvailability(key));
  }, []);

  // 加载 Excalidraw 组件
  useEffect(() => {
    loadExcalidraw()
      .then((comp) => {
        setComponent(() => comp);
      })
      .catch((err) => {
        console.error('加载 Excalidraw 组件失败:', err);
      });
  }, []);

  // 初始化场景（仅在 docKey 改变时执行一次）
  useEffect(() => {
    if (initializedDocKeyRef.current === docKey) return;
    initializedDocKeyRef.current = docKey;
    initialMountHandledRef.current = false;

    const doc = useDocumentStore.getState().getDocument(docKey);
    const content = doc?.content?.trim() ?? '';
    let parsed: ExcalidrawScene;
    if (!content) {
      parsed = createEmptyScene(theme === 'dark');
    } else {
      try {
        parsed = parseScene(content);
        if (!isVersionSupported(parsed)) {
          setReadOnly(true);
        }
      } catch {
        parsed = createEmptyScene(theme === 'dark');
      }
    }

    sceneRef.current = parsed;
    lastCommittedSignatureRef.current = getBoardHistorySignature(parsed);
    initializeDocumentHistory(docKey, serializeScene(parsed), 'board');
    refreshHistoryAvailability(docKey);
    setInitialData(parsed);
    setLiveAppState(parsed.appState);
    setLiveElements(parsed.elements);
    setElementCount(getElementCount(parsed));
  }, [docKey, theme, refreshHistoryAvailability]);

  // onChange 回调（函数引用全局恒定，内部绝不直接触发同步 setState）
  const handleChange = useCallback(
    (elements: ExcalidrawScene['elements'], appState: ExcalidrawScene['appState'], files: ExcalidrawScene['files']) => {
      const prev = sceneRef.current;
      const key = docKeyRef.current;

      const newScene: ExcalidrawScene = {
        type: 'excalidraw',
        version: 2,
        source: 'noteboard',
        elements,
        appState: {
          ...appState,
          viewBackgroundColor: prev?.appState?.viewBackgroundColor ?? appState.viewBackgroundColor,
        },
        files: files ?? prev?.files ?? {},
      };

      sceneRef.current = newScene;

      // 实时更新浮层所依赖的状态（连线箭头、节点扩展等交互）
      setLiveAppState(appState);
      setLiveElements(elements);

      // 初次加载挂载触发的第一次 onChange 忽略标脏
      if (!initialMountHandledRef.current) {
        initialMountHandledRef.current = true;
        // Excalidraw 可能在恢复场景时规范化运行态；以首次稳定场景对齐首节点，避免第一次点击被误判
        lastCommittedSignatureRef.current = getBoardHistorySignature(newScene);
        synchronizeCurrentDocumentHistoryContent(key, serializeScene(newScene), 'board');
        return;
      }

      // 仅比较真正可撤销的画板内容；点击选择、缩放和滚动不会改变该签名
      const currentSig = getBoardHistorySignature(newScene);
      const prevSig = lastCommittedSignatureRef.current;

      if (currentSig === prevSig) {
        return;
      }

      lastCommittedSignatureRef.current = currentSig;
      const content = serializeScene(newScene);
      const isHistoryNavigation = historyApplyTargetSignatureRef.current === currentSig;
      historyApplyTargetSignatureRef.current = null;

      if (isHistoryNavigation) {
        // Excalidraw 的历史应用回调可能晚于统一历史锁，按目标签名识别并只同步当前节点
        synchronizeCurrentDocumentHistoryContent(key, content, 'board');
      } else {
        const now = Date.now();
        const startsNewGroup = pointerGestureActiveRef.current
          ? !pointerGestureChangedRef.current
          : now - lastHistoryChangeAtRef.current > BOARD_HISTORY_GROUP_DELAY_MS;
        recordDocumentChange(key, content, {
          mode: 'board',
          startsNewGroup,
        });
        refreshHistoryAvailability(key);
        pointerGestureChangedRef.current = pointerGestureActiveRef.current;
        lastHistoryChangeAtRef.current = now;
      }

      // 标记脏态（同步 windowStore 和 documentStore）
      const tab = useWindowStore.getState().getTab(key);
      if (tab && !tab.isDirty) {
        useWindowStore.getState().setTabDirty(key, true);
        useDocumentStore.getState().setDirty(key, true);
      }

      // 300ms 防抖更新 Store 内存镜像
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      storeTimerRef.current = setTimeout(() => {
        useDocumentStore.getState().setContent(key, content);
        const doc = useDocumentStore.getState().getDocument(key);
        // 如果内容与基线一致，自动解除脏态
        if (doc && content.trim() === (doc.baselineContent?.trim() ?? '')) {
          useWindowStore.getState().setTabDirty(key, false);
          useDocumentStore.getState().setDirty(key, false);
        }
        setElementCount(elements.length);
        const zoom = typeof appState.zoom === 'number' ? appState.zoom : (appState.zoom as { value?: number })?.value ?? 1;
        setZoomLevel(zoom);
      }, 300);

      // 800ms 防抖自动写入磁盘（仅在 auto 策略时执行）
      if (diskTimerRef.current) clearTimeout(diskTimerRef.current);
      diskTimerRef.current = setTimeout(async () => {
        const doc = useDocumentStore.getState().getDocument(key);
        if (doc?.savePolicy !== 'auto') return;
        try {
          const result = await ipc.writeDocument(key, content, doc.encoding, doc.eol);
          if (result.ok) {
            // 使用实际写入的画板快照更新基线，保存期间的新操作仍应保持未保存状态
            useDocumentStore.getState().updateBaseline(key, content, result.mtime, result.size);
            const stillDirty = useDocumentStore.getState().getDocument(key)?.isDirty ?? false;
            useWindowStore.getState().setTabDirty(key, stillDirty);
            await ipc.setDocumentDirty(key, stillDirty);
          }
        } catch (e) {
          console.error('画板自动保存失败:', e);
        }
      }, 800);
    },
    [refreshHistoryAvailability],
  );

  /** 开始画布指针手势；拖动或缩放产生的多帧变化应归并为一个历史分组 */
  const handleBoardPointerDown = useCallback(() => {
    pointerGestureActiveRef.current = true;
    pointerGestureChangedRef.current = false;
  }, []);

  /** 结束指针手势并封闭当前分组，下一次真实操作必须另起一步 */
  const handleBoardPointerUp = useCallback(() => {
    pointerGestureActiveRef.current = false;
    pointerGestureChangedRef.current = false;
    markDocumentHistoryModeBoundary(docKeyRef.current);
  }, []);

  // 稳定的 API 注入回调
  const handleApi = useCallback((api: BoardApi) => {
    apiRef.current = api;
  }, []);

  // 画板统一历史只应用持久场景快照，并明确禁止写入 Excalidraw 自带的选中态历史
  useEffect(() => {
    if (!initialData) return;
    return registerDocumentHistoryAdapter(docKey, {
      applyEntry: (entry) => {
        const api = apiRef.current;
        if (!api) {
          throw new Error('画板尚未完成初始化，无法应用撤销/重做');
        }
        const restored = parseScene(entry.content);
        historyApplyTargetSignatureRef.current = getBoardHistorySignature(restored);
        sceneRef.current = restored;
        api.addFiles?.(Object.values(restored.files ?? {}));
        api.updateScene({
          elements: restored.elements,
          appState: restored.appState,
          captureUpdate: 'NEVER',
        });
        refreshHistoryAvailability(docKey);
      },
    });
  }, [docKey, initialData, refreshHistoryAvailability]);

  // Excalidraw 的按钮状态来自它自己的历史栈；持续改写为文件级历史状态，防止重做按钮回落到旧栈
  useEffect(() => {
    const root = boardRootRef.current;
    if (!root) return;

    const synchronizeToolbarButtons = () => {
      const undoButton = root.querySelector<HTMLButtonElement>('[data-testid="button-undo"]');
      const redoButton = root.querySelector<HTMLButtonElement>('[data-testid="button-redo"]');

      /** 同步按钮行为、无障碍状态以及 Excalidraw 实际用于置灰图标的子节点属性 */
      const synchronizeButton = (button: HTMLButtonElement | null, enabled: boolean) => {
        if (!button) return;
        const disabled = !enabled;
        const ariaDisabled = String(disabled);
        if (button.disabled !== disabled) button.disabled = disabled;
        if (button.getAttribute('aria-disabled') !== ariaDisabled) {
          button.setAttribute('aria-disabled', ariaDisabled);
        }
        const icon = button.querySelector<HTMLElement>('.ToolIcon__icon');
        if (icon?.getAttribute('aria-disabled') !== ariaDisabled) {
          icon?.setAttribute('aria-disabled', ariaDisabled);
        }
      };

      synchronizeButton(undoButton, historyAvailability.canUndo);
      synchronizeButton(redoButton, historyAvailability.canRedo);
    };

    synchronizeToolbarButtons();
    const observer = new MutationObserver(synchronizeToolbarButtons);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled'],
    });
    return () => observer.disconnect();
  }, [historyAvailability, Component, initialData]);

  /** 最高优先级接管画板撤销快捷键，避开 Excalidraw 会记录点击选中态的原生历史 */
  const handleBoardKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    const key = event.key.toLowerCase();
    const isUndo = key === 'z' && !event.shiftKey;
    const isRedo = key === 'y' || (key === 'z' && event.shiftKey);
    if (!isUndo && !isRedo) return;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    if (isUndo) undoDocumentHistory(docKey);
    else redoDocumentHistory(docKey);
  }, [docKey]);

  /**
   * 工具栏撤销/重做按钮同样走文件级历史。
   * 使用 PointerDown 捕获可覆盖原生重做按钮处于 disabled、不会派发 click 的情况。
   */
  const handleBoardHistoryPointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const historyButton = target.closest<HTMLElement>('[data-testid="button-undo"], [data-testid="button-redo"]');
    if (!historyButton || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    if (historyButton.dataset.testid === 'button-undo') undoDocumentHistory(docKey);
    else redoDocumentHistory(docKey);
  }, [docKey]);

  /**
   * PointerDown 后浏览器仍会继续合成 click；必须在捕获阶段吞掉，禁止 Excalidraw 原生历史再次执行。
   * detail=0 表示通过键盘激活按钮，此时没有前置 PointerDown，需要在这里执行一次统一历史。
   */
  const handleBoardHistoryClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const historyButton = target.closest<HTMLElement>('[data-testid="button-undo"], [data-testid="button-redo"]');
    if (!historyButton) return;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    if (event.detail !== 0) return;
    if (historyButton.dataset.testid === 'button-undo') undoDocumentHistory(docKey);
    else redoDocumentHistory(docKey);
  }, [docKey]);

  // 自动吸附对齐开关状态（默认开启）
  const isSnapEnabled = liveAppState?.objectsSnapModeEnabled ?? initialData?.appState?.objectsSnapModeEnabled ?? true;

  // 切换自动吸附对齐模式
  const handleToggleSnapMode = useCallback(() => {
    const currentScene = sceneRef.current;
    if (apiRef.current && currentScene) {
      const nextVal = !(currentScene.appState?.objectsSnapModeEnabled ?? true);
      apiRef.current.updateScene({
        appState: {
          ...currentScene.appState,
          objectsSnapModeEnabled: nextVal,
        } as ExcalidrawScene['appState'],
      });
    }
  }, []);

  // 注册全局场景获取器，供 saveDocument 快捷保存时获取最新内存数据
  useEffect(() => {
    activeBoardScenes.set(docKey, () => sceneRef.current);
    return () => {
      activeBoardScenes.delete(docKey);
    };
  }, [docKey]);

  // 清理计时器
  useEffect(() => {
    return () => {
      // 防抖尚未触发时也要把画板最新快照写回内存，避免切换标签丢失操作
      const latestScene = sceneRef.current;
      if (latestScene) {
        useDocumentStore.getState().setContent(docKey, serializeScene(latestScene));
      }
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      if (diskTimerRef.current) clearTimeout(diskTimerRef.current);
    };
  }, [docKey]);

  const stableInitialData = useMemo(() => {
    if (!initialData) return null;
    return {
      elements: initialData.elements ?? [],
      appState: cleanAppState(initialData.appState),
      files: initialData.files ?? {},
    };
  }, [initialData]);

  if (!Component || !stableInitialData) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--editor-text-muted)' }}>
        加载画板组件
      </div>
    );
  }

  if (readOnly) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
        {!boardPresentationMode && (
          <div
            style={{
              padding: '8px 12px',
              background: 'var(--warning-50)',
              borderBottom: '1px solid var(--warning-200)',
              fontSize: 13,
              color: 'var(--editor-text)',
            }}
          >
            ⚠ 此文件使用的 Excalidraw 版本高于支持版本，以只读模式打开。
          </div>
        )}
        <div
          key="readonly-board-canvas"
          style={{ flex: 1, overflow: 'hidden', position: 'relative' }}
        >
          <Component
            initialData={stableInitialData as unknown as Record<string, unknown>}
            viewModeEnabled={true}
            zenModeEnabled={boardPresentationMode}
            theme={theme}
            langCode="zh-CN"
          />
          <BoardPresentationToggle
            enabled={boardPresentationMode}
            onToggle={handleTogglePresentationMode}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={boardRootRef}
      onKeyDownCapture={handleBoardKeyDownCapture}
      onPointerDownCapture={handleBoardHistoryPointerDownCapture}
      onClickCapture={handleBoardHistoryClickCapture}
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      {/* 画板区域 */}
      <div style={{ flex: 1, height: '100%', width: '100%', overflow: 'hidden', position: 'relative' }}>
        <ExcalidrawCanvas
          Component={Component}
          initialData={stableInitialData as unknown as Record<string, unknown>}
          theme={theme}
          onChange={handleChange}
          onApi={handleApi}
          onPointerDown={handleBoardPointerDown}
          onPointerUp={handleBoardPointerUp}
          presentationMode={boardPresentationMode}
        />
        {/* 流程图快速连线与节点延伸悬浮层 */}
        {!boardPresentationMode && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              overflow: 'hidden',
              zIndex: 5,
            }}
          >
            <FlowchartQuickConnect
              api={apiRef.current}
              appState={liveAppState ?? initialData?.appState}
              elements={liveElements.length > 0 ? liveElements : (initialData?.elements ?? [])}
              theme={theme}
            />
          </div>
        )}
        <BoardPresentationToggle
          enabled={boardPresentationMode}
          onToggle={handleTogglePresentationMode}
        />
      </div>

      {/* 状态栏画板区段 */}
      {!boardPresentationMode && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '2px 12px',
            height: 24,
            borderTop: '1px solid var(--editor-border)',
            background: 'var(--editor-surface)',
            fontSize: 11,
            color: 'var(--editor-text-muted)',
            flexShrink: 0,
          }}
        >
        <span>📊 {elementCount} 图元</span>

        {/* 自动吸附对齐开关 */}
        <Tooltip content="自动吸附对齐 - 移动图元时自动靠近边缘与中心线对齐，并显示对齐辅助虚线" shortcut="Alt+S" side="top" sideOffset={6}>
          <button
            type="button"
            onClick={handleToggleSnapMode}
            style={{
              background: isSnapEnabled ? 'var(--primary-subtle, rgba(14, 127, 214, 0.12))' : 'transparent',
              border: isSnapEnabled ? '1px solid var(--primary-500, #0e7fd6)' : '1px solid var(--editor-border)',
              borderRadius: 4,
              padding: '2px 8px',
              cursor: 'pointer',
              color: isSnapEnabled ? 'var(--primary-500, #0e7fd6)' : 'inherit',
              fontSize: 11,
              fontWeight: isSnapEnabled ? 500 : 400,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = isSnapEnabled
                ? 'var(--primary-subtle-hover, rgba(14, 127, 214, 0.2))'
                : 'var(--toolbar-hover)';
              e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
              if (!isSnapEnabled) e.currentTarget.style.color = 'var(--editor-text)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = isSnapEnabled
                ? 'var(--primary-subtle, rgba(14, 127, 214, 0.12))'
                : 'transparent';
              e.currentTarget.style.borderColor = isSnapEnabled
                ? 'var(--primary-500, #0e7fd6)'
                : 'var(--editor-border)';
              e.currentTarget.style.color = isSnapEnabled ? 'var(--primary-500, #0e7fd6)' : 'inherit';
              e.currentTarget.style.transform = 'scale(1)';
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-active)';
              e.currentTarget.style.transform = 'scale(0.92)';
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.background = isSnapEnabled
                ? 'var(--primary-subtle-hover, rgba(14, 127, 214, 0.2))'
                : 'var(--toolbar-hover)';
              e.currentTarget.style.transform = 'scale(1)';
            }}
            aria-label="自动吸附对齐"
          >
            <span>🧲 自动吸附</span>
            <span style={{ fontSize: 10, opacity: 0.85 }}>[{isSnapEnabled ? '开' : '关'}]</span>
          </button>
        </Tooltip>

        <Tooltip content="重置缩放" shortcut="100%" side="top" sideOffset={6}>
          <button
            type="button"
            onClick={() => {
              const currentScene = sceneRef.current;
              if (apiRef.current && currentScene) {
                apiRef.current.updateScene({
                  appState: {
                    ...currentScene.appState,
                    scrollX: 0,
                    scrollY: 0,
                    zoom: 1,
                  } as ExcalidrawScene['appState'],
                });
                setZoomLevel(1);
              }
            }}
            style={{
              background: 'transparent',
              border: '1px solid var(--editor-border)',
              borderRadius: 4,
              padding: '2px 8px',
              cursor: 'pointer',
              color: 'inherit',
              fontSize: 11,
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
              e.currentTarget.style.color = 'var(--editor-text)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.borderColor = 'var(--editor-border)';
              e.currentTarget.style.color = 'inherit';
              e.currentTarget.style.transform = 'scale(1)';
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-active)';
              e.currentTarget.style.transform = 'scale(0.92)';
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.transform = 'scale(1)';
            }}
            aria-label="重置缩放"
          >
            {Math.round(zoomLevel * 100)}%
          </button>
        </Tooltip>
        </div>
      )}
    </div>
  );
}

// ── 画板错误边界 ──

class BoardErrorBoundary extends React.Component<
  { docKey: string; children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { docKey: string; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('BoardErrorBoundary 捕获到画板渲染异常:', error, errorInfo);
  }

  componentDidUpdate(prevProps: { docKey: string }) {
    if (prevProps.docKey !== this.props.docKey && this.state.hasError) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: 32,
            gap: 16,
            color: 'var(--editor-text)',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 32 }}>🎨</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>画板加载或渲染出现异常</div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--editor-text-muted)',
              maxWidth: 480,
              wordBreak: 'break-all',
              fontFamily: 'var(--mono-font-family)',
              background: 'var(--editor-surface)',
              padding: '8px 12px',
              borderRadius: 4,
              border: '1px solid var(--editor-border)',
            }}
          >
            {this.state.error?.message ?? '未知错误'}
          </div>
          <button
            type="button"
            className="nb-btn-primary"
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '8px 20px',
              fontSize: 13,
            }}
          >
            重试加载画板
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
