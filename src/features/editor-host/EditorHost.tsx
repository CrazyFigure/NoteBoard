// NoteBoard 编辑器宿主（S05 懒加载边界，docs/启动性能与低内存根治计划.md §E）
//
// 🔴 职责与不变量：
//   1. 按 kind + language 选择懒加载入口，Suspense + ErrorBoundary 包裹；
//      fallback 有目标文件名、稳定背景/尺寸；标题栏与关闭保护不受加载影响。
//   2. lazy 定义稳定位于模块作用域；每次 render 不新建导致状态重置。
//   3. 失败恢复同时考虑 loader Promise 与 React.lazy 已缓存的 rejection：
//      以 retryGeneration 重建失败资源包装及错误边界（key 强制重挂载），成功项复用。
//   4. 引擎对某些模块求值失败也会缓存：重试仍失败时保留文档并提示安全重启/修复，
//      不强制刷新窗口丢稿。
//   5. 不切换文档状态表示（documentStore 语义不变），不改变后台标签挂载策略（S11 处理）。

import React, { Component, Suspense, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import { createLazyEditor, resolveEditorKind } from './editorLoaders';

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

// ── EditorHost ──

export function EditorHost({
  tab,
  fileSize,
  onEditorReady,
  unsupportedView,
}: EditorHostProps): ReactNode {
  const [retryGeneration, setRetryGeneration] = useState(0);
  const kind = resolveEditorKind(tab);

  // lazy 包装：模块作用域工厂 + retryGeneration 重建（React.lazy 缓存 rejection 的恢复手段）
  const LazyEditor = useMemo(() => {
    if (kind === 'unsupported') return null;
    return createLazyEditor(kind);
  }, [kind, retryGeneration]);

  if (kind === 'unsupported' || !LazyEditor) {
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

  return (
    <EditorErrorBoundary
      key={retryGeneration}
      displayName={tab.displayName}
      onRetry={() => setRetryGeneration((g) => g + 1)}
      onClose={() => {
        // 关闭标签（关闭保护由 requestCloseTab 统一处理）
        useWindowStore.getState().requestCloseTab(tab.key);
      }}
    >
      <Suspense fallback={<EditorLoadingFallback displayName={tab.displayName} />}>
        <LazyEditor {...editorProps} />
      </Suspense>
    </EditorErrorBoundary>
  );
}
