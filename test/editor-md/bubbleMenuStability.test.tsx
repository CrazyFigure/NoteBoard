// NoteBoard 选区气泡菜单稳定性回归测试
// TipTap 3.30 会在配置引用变化时派发事务；重复渲染必须保持配置引用不变，防止 React #185。

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import { EditorBubbleMenu } from '../../src/features/editor-md/bubbleMenu';

const bubbleProps = vi.hoisted(() => [] as Array<{ shouldShow: unknown; options: unknown }>);

vi.mock('@tiptap/react/menus', () => ({
  BubbleMenu: (props: { shouldShow: unknown; options: unknown; children: React.ReactNode }) => {
    bubbleProps.push({ shouldShow: props.shouldShow, options: props.options });
    return props.children;
  },
}));

vi.mock('../../src/components/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(() => {
  bubbleProps.length = 0;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

it('父组件重复渲染时 BubbleMenu 的事务配置引用应保持稳定', async () => {
  const scrollContainer = document.createElement('div');
  scrollContainer.style.overflowY = 'auto';
  const editorDom = document.createElement('div');
  scrollContainer.appendChild(editorDom);
  document.body.appendChild(scrollContainer);
  const editor = {
    view: { dom: editorDom },
    isActive: () => false,
    getAttributes: () => ({}),
  } as unknown as Editor;

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    for (let index = 0; index < 8; index += 1) {
      await act(async () => {
        root.render(<EditorBubbleMenu editor={editor} />);
      });
    }

    expect(bubbleProps).toHaveLength(8);
    expect(new Set(bubbleProps.map((item) => item.shouldShow)).size).toBe(1);
    expect(new Set(bubbleProps.map((item) => item.options)).size).toBe(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    scrollContainer.remove();
  }
});
