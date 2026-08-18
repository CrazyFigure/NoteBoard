// NoteBoard 错误边界
// 每个 tab 一个 ErrorBoundary，单 tab 崩溃显示错误页不影响其他 tab
// 详见 docs/09-开发路线图.md 13.7 (NFR-303)

import { Component, type ReactNode, type ErrorInfo } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] 捕获错误:', error, info);
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: 24,
            gap: 12,
            color: 'var(--editor-text)',
            fontFamily: 'var(--ui-font-family)',
            fontSize: 14,
          }}
        >
          <div style={{ fontSize: 48 }}>💥</div>
          <h2 style={{ fontSize: 18, margin: 0 }}>此标签页出现问题</h2>
          <p style={{ color: 'var(--editor-text-muted)', textAlign: 'center', maxWidth: 400, fontSize: 13 }}>
            {this.state.error?.message ?? '未知错误'}
          </p>
          <pre
            style={{
              fontSize: 11,
              color: 'var(--editor-text-muted)',
              background: 'var(--cm-gutter-background)',
              padding: 8,
              borderRadius: 4,
              maxWidth: 600,
              overflow: 'auto',
              maxHeight: 200,
            }}
          >
            {this.state.error?.stack ?? ''}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '6px 16px',
              border: '1px solid var(--editor-border)',
              borderRadius: 4,
              background: 'var(--editor-surface)',
              color: 'var(--editor-text)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
