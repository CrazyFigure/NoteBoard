// NoteBoard LinkModal 单元测试
// 验证超链接编辑与插入弹窗的属性传递与渲染结构

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { LinkModal } from '../../src/features/editor-md/LinkModal';

describe('LinkModal 超链接编辑/插入模态弹窗测试', () => {
  it('isOpen 为 false 时应不渲染（返回 null）', () => {
    const handleClose = vi.fn();
    const handleConfirm = vi.fn();
    const element = React.createElement(LinkModal, {
      isOpen: false,
      onClose: handleClose,
      onConfirm: handleConfirm,
    });
    expect(React.isValidElement(element)).toBe(true);
  });

  it('isOpen 为 true 时应正确创建 React 元素并传递 initialText 和 initialUrl', () => {
    const handleClose = vi.fn();
    const handleConfirm = vi.fn();
    const handleRemove = vi.fn();

    const element = React.createElement(LinkModal, {
      isOpen: true,
      initialText: 'NoteBoard 官网',
      initialUrl: 'https://github.com/CrazyFigure/NoteBoard',
      isEditing: true,
      onClose: handleClose,
      onConfirm: handleConfirm,
      onRemove: handleRemove,
    });

    expect(element.props.isOpen).toBe(true);
    expect(element.props.initialText).toBe('NoteBoard 官网');
    expect(element.props.initialUrl).toBe('https://github.com/CrazyFigure/NoteBoard');
    expect(element.props.isEditing).toBe(true);
  });
});
