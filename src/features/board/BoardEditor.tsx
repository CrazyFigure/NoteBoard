// NoteBoard Excalidraw 画板编辑器
// 动态 import + 自动保存 + 视口保持 + 版本检查
// 详见 docs/09-开发路线图.md 10.1/10.6/10.7/10.10

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import '@excalidraw/excalidraw/index.css';
import { parseScene, serializeScene, createEmptyScene, isVersionSupported, getElementCount, type ExcalidrawScene } from './sceneIo';
import { mapTheme } from './excalidrawTheme';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { useSettingsStore } from '../../stores/settingsStore';
import * as ipc from '../../core/ipc/commands';

interface BoardEditorProps {
  docKey: string;
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
    <BoardErrorBoundary docKey={docKey}>
      <BoardEditorInner docKey={docKey} />
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

function BoardEditorInner({ docKey }: BoardEditorProps) {
  const [Component, setComponent] = useState<typeof ExcalidrawComponent>(null);
  const [initialData, setInitialData] = useState<ExcalidrawScene | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [elementCount, setElementCount] = useState(0);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const storeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diskTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiRef = useRef<{ updateScene: (scene: Partial<ExcalidrawScene>) => void } | null>(null);
  const initializedDocKeyRef = useRef<string | null>(null);
  const sceneRef = useRef<ExcalidrawScene | null>(null);
  const docKeyRef = useRef(docKey);
  docKeyRef.current = docKey;

  const themeMode = useSettingsStore((s) => s.settings.appearance.themeMode);
  const theme = mapTheme(themeMode);

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
    setInitialData(parsed);
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

      // 仅在 tab 未标记为 dirty 时才触发一次更新，避免频繁通知 store
      const tab = useWindowStore.getState().getTab(key);
      if (tab && !tab.isDirty) {
        useWindowStore.getState().setTabDirty(key, true);
      }

      // 300ms 防抖更新 Store
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      storeTimerRef.current = setTimeout(() => {
        const content = serializeScene(newScene);
        useDocumentStore.getState().setContent(key, content);
        setElementCount(elements.length);
        const zoom = typeof appState.zoom === 'number' ? appState.zoom : (appState.zoom as { value?: number })?.value ?? 1;
        setZoomLevel(zoom);
      }, 300);

      // 800ms 防抖自动写入磁盘
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
      appState: initialData.appState ?? {},
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
        <button
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
            borderRadius: 3,
            padding: '0 6px',
            cursor: 'pointer',
            color: 'inherit',
            fontSize: 11,
          }}
          title="重置缩放"
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
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '6px 16px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--editor-border)',
              background: 'var(--accent-strong)',
              color: '#ffffff',
              fontSize: 13,
              cursor: 'pointer',
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
