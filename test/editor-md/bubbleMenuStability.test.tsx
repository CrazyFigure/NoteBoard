// NoteBoard 选区气泡菜单稳定性回归测试
// TipTap 3.30 会在配置引用变化时派发事务；重复渲染必须保持配置引用不变，防止 React #185。

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
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

it('菜单先于正文渲染时应使用挂载后的滚动容器作为定位边界', async () => {
  // TipTap 在 EditorContent 挂载前把正文放在临时容器中，不能缓存该容器的零尺寸边界。
  const editor = new Editor({ extensions: [StarterKit], content: '<p>选中文字</p>' });
  const temporaryParent = editor.view.dom.parentElement;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <div style={{ overflowY: 'auto' }} data-testid="editor-scroll-container">
          <EditorBubbleMenu editor={editor} />
          <EditorContent editor={editor} />
        </div>
      );
    });

    const scrollContainer = host.querySelector('[data-testid="editor-scroll-container"]');
    expect(editor.view.dom.parentElement).not.toBe(temporaryParent);
    const options = bubbleProps.at(-1)?.options as {
      flip: { boundary: HTMLElement };
      shift: { boundary: HTMLElement };
      scrollTarget: HTMLElement;
    };
    // 定位约束和滚动监听必须指向同一个真实容器，否则选区会被挤向窗口左侧。
    expect(options.flip.boundary).toBe(scrollContainer);
    expect(options.shift.boundary).toBe(scrollContainer);
    expect(options.scrollTarget).toBe(scrollContainer);
  } finally {
    await act(async () => root.unmount());
    editor.destroy();
    host.remove();
  }
});
