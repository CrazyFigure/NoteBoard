// NoteBoard 编辑器宿主（S05 懒加载边界，docs/启动性能与低内存根治计划.md §E）
//
// 🔴 职责与不变量：
//   1. 按 kind + language 选择资源入口，经稳定订阅驱动 loading/ready/error；
//      fallback 有目标文件名、稳定背景/尺寸；标题栏与关闭保护不受加载影响。
//   2. ready 时直接渲染缓存组件；重渲染与成功资源复用不进入模块加载占位。
//   3. 失败恢复替换失败请求，但保留类型级订阅；retryGeneration 只重置渲染错误边界。
//   4. 引擎对某些模块求值失败也会缓存：重试仍失败时保留文档并提示安全重启/修复，
//      不强制刷新窗口丢稿。
//   5. 不切换文档状态表示（documentStore 语义不变），不改变后台标签挂载策略（S11 处理）。

import React, { Component, useState, useCallback, useEffect, useRef, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import {
  resolveEditorKind,
  subscribeEditorResource,
  getEditorResourceSnapshot,
  retryEditorLoad,
  noteEditorFallbackShown,
} from './editorLoaders';

interface EditorHostProps {
  tab: Tab;
  /** 文档字节数（图片/不支持视图显示用） */
  fileSize?: number;
  /** TipTap 编辑器就绪回调（仅 markdown 活动标签；import type 不产生运行时依赖） */
  onEditorReady?: (editor: Editor | null) => void;
  /** 不支持类型的轻量常驻视图（不懒加载，保持极小） */
  unsupportedView: ReactNode;
}

// ── 编辑区错误边界 ──

interface EditorErrorBoundaryProps {
  displayName: string;
  onRetry: () => void;
  onClose: () => void;
  children: ReactNode;
}

interface EditorErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/** 编辑器加载/渲染失败的局部错误边界（不影响标题栏与关闭保护） */
class EditorErrorBoundary extends Component<EditorErrorBoundaryProps, EditorErrorBoundaryState> {
  public state: EditorErrorBoundaryState = { hasError: false, error: null };

  public static getDerivedStateFromError(error: Error): EditorErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('编辑器加载/渲染失败:', error, errorInfo);
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            width: '100%',
            height: '100%',
            padding: 24,
            background: 'var(--editor-bg, #fff)',
            color: 'var(--editor-text, #1e293b)',
            fontFamily: 'var(--ui-font-family, sans-serif)',
            userSelect: 'text',
          }}
        >
          <div style={{ fontSize: 14, color: '#dc2626' }}>
            「{this.props.displayName}」的编辑器加载失败
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--editor-text-muted, #64748b)',
              maxWidth: 480,
              textAlign: 'center',
              wordBreak: 'break-word',
            }}
          >
            {this.state.error?.message || '未知错误'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="nb-btn-primary"
              style={{ padding: '6px 16px', fontSize: 13 }}
              onClick={this.props.onRetry}
            >
              重试加载
            </button>
            <button
              type="button"
              style={{ padding: '6px 16px', fontSize: 13, cursor: 'pointer' }}
              onClick={this.props.onClose}
            >
              关闭标签
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--editor-text-muted, #94a3b8)' }}>
            文档内容未受影响；多次重试仍失败时建议保存后重启应用
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── 加载中 fallback（目标文件名 + 稳定背景尺寸） ──

function EditorLoadingFallback({ displayName }: { displayName: string }): ReactNode {
  // 只统计真正挂载的加载占位，避免 render 重试及 StrictMode 重演把一次展示计成多次。
  const countedRef = useRef(false);
  useEffect(() => {
    if (countedRef.current) return;
    countedRef.current = true;
    noteEditorFallbackShown();
  }, []);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        width: '100%',
        height: '100%',
        background: 'var(--editor-bg, #fff)',
        color: 'var(--editor-text-muted, #64748b)',
        fontFamily: 'var(--ui-font-family, sans-serif)',
      }}
    >
      <div style={{ fontSize: 13 }}>正在加载「{displayName}」的编辑器…</div>
      <div
        style={{
          width: 28,
          height: 28,
          border: '2px solid var(--editor-border, #e2e8f0)',
          borderTopColor: 'var(--accent, #3b82f6)',
          borderRadius: '50%',
          animation: 'nb-editor-spin 0.8s linear infinite',
        }}
      />
      <style>{'@keyframes nb-editor-spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}

// ── 🔴 P0-1b：加载错误视图（资源 error 状态的可见错误 + 安全重试） ──

function EditorLoadErrorView({
  displayName,
  error,
  onRetry,
  onClose,
}: {
  displayName: string;
  error: unknown;
  onRetry: () => void;
  onClose: () => void;
}): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        width: '100%',
        height: '100%',
        padding: 24,
        background: 'var(--editor-bg, #fff)',
        color: 'var(--editor-text, #1e293b)',
        fontFamily: 'var(--ui-font-family, sans-serif)',
        userSelect: 'text',
      }}
    >
      <div style={{ fontSize: 14, color: '#dc2626' }}>「{displayName}」的编辑器加载失败</div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--editor-text-muted, #64748b)',
          maxWidth: 480,
          textAlign: 'center',
          wordBreak: 'break-word',
        }}
      >
        {error instanceof Error ? error.message : String(error ?? '未知错误')}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="nb-btn-primary"
          style={{ padding: '6px 16px', fontSize: 13 }}
          onClick={onRetry}
        >
          重试加载
        </button>
        <button
          type="button"
          style={{ padding: '6px 16px', fontSize: 13, cursor: 'pointer' }}
          onClick={onClose}
        >
          关闭标签
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--editor-text-muted, #94a3b8)' }}>
        文档内容未受影响；多次重试仍失败时建议保存后重启应用
      </div>
    </div>
  );
}

// ── EditorHost ──

/** unsupported 类型的空资源快照（引用稳定——useSyncExternalStore 不触发重渲染） */
const unsupportedSnapshot = {
  status: 'loading' as const,
  component: null,
  error: null,
};

export function EditorHost({
  tab,
  fileSize,
  onEditorReady,
  unsupportedView,
}: EditorHostProps): ReactNode {
  const [retryGeneration, setRetryGeneration] = useState(0);
  const kind = resolveEditorKind(tab);

  // 🔴 P0-1b：资源状态经 useSyncExternalStore 订阅——ready 时直接同步渲染缓存
  //    组件（零 Suspense、零 fallback 提交）；loading 渲染加载占位（不进入
  //    React.lazy 的 pending→微任务→retry 链——该链在 ready 后的首次渲染仍必
  //    提交一次 fallback，慢环境下被放大为"一直显示正在加载编辑器"）；
  //    error 渲染错误界面（重试经 retryEditorLoad 重建条目，状态变化自动重渲染）。
  const subscribe = useCallback(
    (listener: () => void) =>
      kind === 'unsupported' ? () => {} : subscribeEditorResource(kind, listener),
    [kind],
  );
  const getSnapshot = useCallback(
    () => (kind === 'unsupported' ? unsupportedSnapshot : getEditorResourceSnapshot(kind)),
    [kind],
  );
  const resource = useSyncExternalStore(subscribe, getSnapshot);

  if (kind === 'unsupported') {
    return unsupportedView;
  }

  // 各编辑器真实 props 的适配（键名与原 AppShell 渲染完全一致）
  const editorProps: Record<string, unknown> = (() => {
    switch (kind) {
      case 'markdown':
        return { docKey: tab.key, onEditorReady };
      case 'image':
        return {
          docKey: tab.key,
          filePath: tab.path ?? tab.key,
          fileName: tab.displayName,
          fileSize: fileSize ?? 0,
        };
      default:
        return { docKey: tab.key };
    }
  })();

  // 🔴 加载错误：可见错误界面 + 安全重试（不自动刷新、不销毁未保存内容）
  if (resource.status === 'error') {
    return (
      <EditorLoadErrorView
        displayName={tab.displayName}
        error={resource.error}
        onRetry={() => {
          // 🔴 R4-02：仅失败条目重建（成功资源不受影响）；重建后经订阅自动
          //    回到 loading→ready；retryGeneration 递增重置错误边界状态
          retryEditorLoad(kind);
          setRetryGeneration((g) => g + 1);
        }}
        onClose={() => {
          useWindowStore.getState().requestCloseTab(tab.key);
        }}
      />
    );
  }

  // 🔴 资源未就绪：加载占位（不进入 Suspense——避免 lazy 的必经 fallback 提交）
  if (resource.status === 'loading' || !resource.component) {
    return <EditorLoadingFallback displayName={tab.displayName} />;
  }

  const LoadedEditor = resource.component;
  return (
    <EditorErrorBoundary
      key={`${tab.key}:${retryGeneration}`}
      displayName={tab.displayName}
      onRetry={() => {
        // 🔴 R4-02：渲染期错误的重试——重置错误边界（generation 递增）；
        //    失败资源同时重建（retryEditorLoad 仅 error 条目生效）
        retryEditorLoad(kind);
        setRetryGeneration((g) => g + 1);
      }}
      onClose={() => {
        // 关闭标签（关闭保护由 requestCloseTab 统一处理）
        useWindowStore.getState().requestCloseTab(tab.key);
      }}
    >
      <LoadedEditor {...editorProps} />
    </EditorErrorBoundary>
  );
}
