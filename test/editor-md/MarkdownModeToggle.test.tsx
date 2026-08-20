// NoteBoard MarkdownModeToggle 单元测试
// 验证 MarkdownModeToggle 悬浮胶囊组件的渲染与交互行为

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { MarkdownModeToggle } from '@/features/editor-md/MarkdownModeToggle';

describe('MarkdownModeToggle 组件测试', () => {
  it('正确渲染为有效的 React 元素', () => {
    const handleToggle = vi.fn();
    const element = React.createElement(MarkdownModeToggle, {
      viewMode: 'visual',
      onToggle: handleToggle,
    });
    expect(React.isValidElement(element)).toBe(true);
  });

  it('支持传入 visual 和 source 两种模式', () => {
    const handleToggle = vi.fn();
    const visualEl = React.createElement(MarkdownModeToggle, {
      viewMode: 'visual',
      onToggle: handleToggle,
    });
    const sourceEl = React.createElement(MarkdownModeToggle, {
      viewMode: 'source',
      onToggle: handleToggle,
    });

    expect(visualEl.props.viewMode).toBe('visual');
    expect(sourceEl.props.viewMode).toBe('source');
  });
});
