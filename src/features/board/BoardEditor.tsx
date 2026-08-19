// NoteBoard Excalidraw 画板编辑器
// 动态 import + 自动保存 + 视口保持 + 版本检查
// 详见 docs/09-开发路线图.md 10.1/10.6/10.7/10.10

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import '@excalidraw/excalidraw/index.css';
import { parseScene, serializeScene, createEmptyScene, cleanAppState, isVersionSupported, getElementCount, type ExcalidrawScene, type ExcalidrawElement } from './sceneIo';
import { mapTheme } from './excalidrawTheme';
import { FlowchartQuickConnect } from './FlowchartQuickConnect';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { useSettingsStore } from '../../stores/settingsStore';
import * as ipc from '../../core/ipc/commands';

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
  onApi: (api: { updateScene: (scene: Partial<ExcalidrawScene>) => void }) => void;
}

// 采用 React.memo 深度隔离 Excalidraw 画布组件，阻断父级任何状态更新导致的内部重渲染死锁
const ExcalidrawCanvas = React.memo(
  function ExcalidrawCanvas({
    Component,
    initialData,
    theme,
    onChange,
    onApi,
  }: CanvasProps) {
    return (
      <Component
        initialData={initialData}
        onChange={onChange}
        theme={theme}
        langCode="zh-CN"
        UIOptions={UI_OPTIONS}
        excalidrawAPI={onApi}
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
      prev.initialData === next.initialData
    );
  },
);

/**
 * 计算元素集的持久化版本签名（id + version + versionNonce + isDeleted）
 * Excalidraw 在侧边栏悬浮预览字体/颜色时不会递增 version/versionNonce，
 * 仅在真正点击提交或用户修改画布图元时递增，藉此彻底杜绝预览阶段误报未保存
 */
function getElementsVersionSignature(elements: readonly ExcalidrawElement[] = []): string {
  return elements.map((e) => `${e.id}:${e.version}:${e.versionNonce}:${e.isDeleted}`).join('|');
}

function BoardEditorInner({ docKey }: BoardEditorProps) {
  const [Component, setComponent] = useState<typeof ExcalidrawComponent>(null);
  const [initialData, setInitialData] = useState<ExcalidrawScene | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [elementCount, setElementCount] = useState(0);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  // 实时画板状态与元素列表（仅用于快捷连接浮层，ExcalidrawCanvas 本身由 React.memo 隔离不会触发内部重绘）
  const [liveAppState, setLiveAppState] = useState<ExcalidrawScene['appState'] | null>(null);
  const [liveElements, setLiveElements] = useState<ExcalidrawScene['elements']>([]);
  const storeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diskTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiRef = useRef<{ updateScene: (scene: Partial<ExcalidrawScene>) => void } | null>(null);
  const initializedDocKeyRef = useRef<string | null>(null);
  const sceneRef = useRef<ExcalidrawScene | null>(null);
  const docKeyRef = useRef(docKey);
  docKeyRef.current = docKey;

  const themeMode = useSettingsStore((s) => s.settings.appearance.themeMode);
  const theme = mapTheme(themeMode);
  const initialMountHandledRef = useRef<boolean>(false);
  const lastCommittedSignatureRef = useRef<string>('');

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
    lastCommittedSignatureRef.current = getElementsVersionSignature(parsed.elements);
    setInitialData(parsed);
    setLiveAppState(parsed.appState);
    setLiveElements(parsed.elements);
    setElementCount(getElementCount(parsed));
  }, [docKey, theme]);

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
        return;
      }

      // 计算当前元素版本签名与持久化属性变更
      const currentSig = getElementsVersionSignature(elements);
      const prevSig = lastCommittedSignatureRef.current;
      const bgChanged = prev?.appState?.viewBackgroundColor !== appState.viewBackgroundColor;
      const filesChanged = prev?.files !== files;
      const snapChanged = prev?.appState?.objectsSnapModeEnabled !== appState.objectsSnapModeEnabled;

      // 仅当图元真正发生提交变更（非悬浮预览）或场景持久属性变动（背景色、文件、吸附对齐开关等）时，才标记脏态
      if (currentSig === prevSig && !bgChanged && !filesChanged && !snapChanged) {
        return;
      }

      lastCommittedSignatureRef.current = currentSig;

      // 标记脏态（同步 windowStore 和 documentStore）
      const tab = useWindowStore.getState().getTab(key);
      if (tab && !tab.isDirty) {
        useWindowStore.getState().setTabDirty(key, true);
        useDocumentStore.getState().setDirty(key, true);
      }

      // 300ms 防抖更新 Store 内存镜像
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      storeTimerRef.current = setTimeout(() => {
        const content = serializeScene(newScene);
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
          const content = serializeScene(newScene);
          const result = await ipc.writeDocument(key, content, doc.encoding, doc.eol);
          if (result.ok) {
            useDocumentStore.getState().updateBaseline(key, result.mtime, result.size);
            useWindowStore.getState().setTabDirty(key, false);
            await ipc.setDocumentDirty(key, false);
          }
        } catch (e) {
          console.error('画板自动保存失败:', e);
        }
      }, 800);
    },
    [],
  );

  // 稳定的 API 注入回调
  const handleApi = useCallback((api: { updateScene: (scene: Partial<ExcalidrawScene>) => void }) => {
    apiRef.current = api;
  }, []);

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
        加载画板组件…
      </div>
    );
  }

  if (readOnly) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <Component
            initialData={stableInitialData as unknown as Record<string, unknown>}
            viewMode={true}
            theme={theme}
            langCode="zh-CN"
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 画板区域 */}
      <div style={{ flex: 1, height: '100%', width: '100%', overflow: 'hidden', position: 'relative' }}>
        <ExcalidrawCanvas
          Component={Component}
          initialData={stableInitialData as unknown as Record<string, unknown>}
          theme={theme}
          onChange={handleChange}
          onApi={handleApi}
        />
        {/* 流程图快速连线与节点延伸悬浮层 */}
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
      </div>

      {/* 状态栏画板区段 */}
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
          title="自动吸附对齐 (Alt+S) - 移动图元时自动靠近边缘与中心线对齐，并显示对齐辅助虚线"
        >
          <span>🧲 自动吸附</span>
          <span style={{ fontSize: 10, opacity: 0.85 }}>[{isSnapEnabled ? '开' : '关'}]</span>
        </button>

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
          title="重置缩放 (100%)"
        >
          {Math.round(zoomLevel * 100)}%
        </button>
      </div>
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
