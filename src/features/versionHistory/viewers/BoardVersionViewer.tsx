// NoteBoard 文档历史记录：画板可视化差异查看
// 只读 Excalidraw 呈现合并场景（删除的元素为半透明锁定副本），
// 覆盖层按画布滚动与缩放为改动元素描边：新增绿色、修改琥珀色、删除红色虚线。
// Excalidraw 与画板编辑器共用同一个懒加载模块；解析失败时回退源码对比。

import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import '@excalidraw/excalidraw/index.css';
import { parseScene, cleanAppState, type ExcalidrawScene } from '../../board/sceneIo';
import { mapTheme } from '../../board/excalidrawTheme';
import { useSettingsStore } from '../../../stores/settingsStore';
import { diffBoards, type BoardChange } from '../diff/boardDiff';
import type { VersionViewerProps } from './viewerTypes';

const TextVersionViewer = lazy(() => import('./TextVersionViewer'));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = React.ComponentType<any>;
let excalidrawPromise: Promise<AnyComponent> | null = null;
/** 画布重建序号：版本或开关变化时递增（Excalidraw 的 initialData 只在挂载时读取） */
let sceneSeq = 0;

function loadExcalidraw(): Promise<AnyComponent> {
  if (!excalidrawPromise) excalidrawPromise = import('@excalidraw/excalidraw').then((m) => m.Excalidraw as AnyComponent);
  return excalidrawPromise;
}

/** 只读画布的界面：隐藏全部编辑类操作 */
const UI_OPTIONS = {
  canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, toggleTheme: false, saveAsImage: false },
  tools: { image: false },
};

interface BoardApi {
  scrollToContent: (target: unknown, opts?: { fitToViewport?: boolean; animate?: boolean; viewportZoomFactor?: number }) => void;
  getSceneElements: () => Array<{ id: string }>;
  getAppState: () => { scrollX: number; scrollY: number; zoom: { value: number } };
}

function parseSafe(text: string): ExcalidrawScene | null {
  try {
    const scene = parseScene(text);
    return Array.isArray(scene.elements) ? scene : null;
  } catch {
    return null;
  }
}

export default function BoardVersionViewer(props: VersionViewerProps) {
  const { base, target, showChanges, onChangeInfo, navigatorRef } = props;
  const themeMode = useSettingsStore((s) => s.settings.appearance.themeMode);
  const parsed = useMemo(() => {
    const b = parseSafe(target);
    const a = base === null ? null : parseSafe(base);
    if (!b || (base !== null && !a)) return null;
    return { target: b, diff: diffBoards(a, b) };
  }, [base, target]);
  const [Excalidraw, setExcalidraw] = useState<AnyComponent | null>(null);
  const [view, setView] = useState({ scrollX: 0, scrollY: 0, zoom: 1 });
  const [current, setCurrent] = useState(-1);
  const apiRef = useRef<BoardApi | null>(null);
  const changes: BoardChange[] = parsed && showChanges ? parsed.diff.changes : [];
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const currentRef = useRef(current);
  currentRef.current = current;
  const onChangeInfoRef = useRef(onChangeInfo);
  onChangeInfoRef.current = onChangeInfo;

  useEffect(() => {
    let alive = true;
    void loadExcalidraw().then((c) => alive && setExcalidraw(() => c));
    return () => {
      alive = false;
    };
  }, []);

  // 版本或开关变化时重新创建画布
  const sceneKey = useMemo(() => ++sceneSeq, [parsed, showChanges]);
  const initialData = useMemo(
    () =>
      parsed
        ? {
            // 关闭显示更改：只呈现该版本自身的元素
            elements: showChanges ? parsed.diff.elements : parsed.target.elements.filter((e) => !e.isDeleted),
            files: parsed.diff.files,
            appState: { ...cleanAppState(parsed.target.appState), viewModeEnabled: true },
            scrollToContent: true,
          }
        : null,
    [parsed, showChanges],
  );

  const focusChange = (index: number) => {
    const change = changesRef.current[index];
    const api = apiRef.current;
    if (!change || !api) return;
    setCurrent(index);
    onChangeInfoRef.current({ count: changesRef.current.length, index });
    const el = api.getSceneElements().find((e) => e.id === change.id);
    if (el) api.scrollToContent(el, { fitToViewport: false, animate: true });
  };

  useEffect(() => {
    setCurrent(-1);
    if (changes.length === 0) onChangeInfoRef.current({ count: 0, index: -1 });
  }, [sceneKey]);

  useEffect(() => {
    navigatorRef.current = {
      next: () => focusChange(Math.min(changesRef.current.length - 1, currentRef.current + 1)),
      prev: () => focusChange(Math.max(0, currentRef.current - 1)),
    };
    return () => {
      navigatorRef.current = null;
    };
  }, [navigatorRef]);

  if (!parsed) {
    return (
      <>
        <div className="nb-vh-banner">无法按画板呈现，显示源码对比</div>
        <Suspense fallback={null}>
          <TextVersionViewer {...props} />
        </Suspense>
      </>
    );
  }

  const focused = current >= 0 ? changes[current] : undefined;
  return (
    <div className="nb-vh-board">
      {Excalidraw && initialData && (
        <Excalidraw
          key={sceneKey}
          initialData={initialData}
          theme={mapTheme(themeMode)}
          langCode="zh-CN"
          viewModeEnabled
          zenModeEnabled
          UIOptions={UI_OPTIONS}
          excalidrawAPI={(api: BoardApi) => {
            apiRef.current = api;
            const s = api.getAppState();
            setView({ scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value });
            // 画布就绪后定位到第一处改动
            if (changesRef.current.length > 0) window.setTimeout(() => focusChange(0), 120);
          }}
          onScrollChange={(scrollX: number, scrollY: number, zoom: { value: number }) => setView({ scrollX, scrollY, zoom: zoom.value })}
        />
      )}
      {showChanges && (
        <div className="nb-vh-board-overlay" aria-hidden>
          {changes.map((c, i) => {
            const pad = 6;
            return (
              <div
                key={c.id}
                className={`nb-vh-board-mark is-${c.kind}${i === current ? ' is-current' : ''}`}
                style={{
                  left: (c.bounds.x + view.scrollX) * view.zoom - pad,
                  top: (c.bounds.y + view.scrollY) * view.zoom - pad,
                  width: c.bounds.width * view.zoom + pad * 2,
                  height: c.bounds.height * view.zoom + pad * 2,
                }}
              />
            );
          })}
        </div>
      )}
      {focused && <div className="nb-vh-caption">{focused.label}</div>}
    </div>
  );
}
