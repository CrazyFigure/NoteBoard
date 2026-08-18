// NoteBoard 全局错误边界（ErrorBoundary）
// 捕获子组件渲染期间的未处理异常，避免整屏无声白屏

import React, { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary 捕获到未处理的 React 渲染错误:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            padding: 32,
            background: 'var(--editor-bg, #ffffff)',
            color: 'var(--editor-text, #1e293b)',
            fontFamily: 'var(--content-font-family, sans-serif)',
            userSelect: 'text',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, color: '#dc2626' }}>
            界面渲染异常
          </div>
          <div
            style={{
              fontSize: 13,
              color: 'var(--editor-text-secondary, #64748b)',
              marginBottom: 16,
              maxWidth: 600,
              textAlign: 'center',
              wordBreak: 'break-word',
            }}
          >
            {this.state.error?.message || '未知错误'}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '6px 16px',
              borderRadius: 4,
              border: '1px solid var(--editor-border, #e5e7eb)',
              background: 'var(--accent-strong, #3b82f6)',
              color: '#ffffff',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            恢复并重新加载
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
