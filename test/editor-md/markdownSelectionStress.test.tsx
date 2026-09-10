// NoteBoard Markdown 长文档选区压力回归测试
// 模拟用户持续滚动、选择与取消选择；事务触发宿主重渲染时不得形成 BubbleMenu 配置事务闭环。

import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { EditorBubbleMenu } from '../../src/features/editor-md/bubbleMenu';
import { TooltipProvider } from '../../src/components/Tooltip';
import { MathBlock, MathInline } from '../../src/features/editor-md/katexExtensions';
import { parseMarkdown } from '../../src/features/editor-md/serialize';

/** jsdom 没有文本 Range 布局信息，为浮动菜单提供稳定的零尺寸矩形。 */
function installRangeLayoutFallback(): () => void {
  const prototype = Range.prototype as Range & {
    getBoundingClientRect?: () => DOMRect;
    getClientRects?: () => DOMRectList;
  };
  const originalBounding = prototype.getBoundingClientRect;
  const originalClientRects = prototype.getClientRects;
  const rectangle = new DOMRect(0, 0, 1, 18);
  prototype.getBoundingClientRect = () => rectangle;
  prototype.getClientRects = () => ({
    0: rectangle,
    length: 1,
    item: (index: number) => index === 0 ? rectangle : null,
    [Symbol.iterator]: function* iterator() { yield rectangle; },
  }) as DOMRectList;
  return () => {
    prototype.getBoundingClientRect = originalBounding;
    prototype.getClientRects = originalClientRects;
  };
}

it('长文档反复滚动和切换文本选区时不能触发 React 无限更新', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const restoreRangeLayout = installRangeLayoutFallback();
  const markdown = Array.from({ length: 120 }, (_, index) => (
    `第 ${index + 1} 段：线程数 $2 \\times N_{cpu}$，用于选区与滚动压力验证。`
  )).join('\n\n');
  // 测试宿主挂载后由 effect 注入编辑器实例，后续压力循环只在挂载完成后执行。
  let activeEditor!: Editor;
  let observedTransactions = 0;

  function Host() {
    const editor = useEditor({
      extensions: [StarterKit, MathInline, MathBlock, Markdown],
      content: '',
    });
    const [, rerender] = useState(0);
    useEffect(() => {
      if (!editor) return;
      activeEditor = editor;
      const handleTransaction = () => {
        observedTransactions += 1;
        rerender((value) => value + 1);
      };
      editor.on('transaction', handleTransaction);
      return () => {
        editor.off('transaction', handleTransaction);
      };
    }, [editor]);

    return (
      <TooltipProvider>
        <div style={{ height: 400, overflow: 'auto' }} data-testid="scroll-container">
          <EditorContent editor={editor} />
          {editor && <EditorBubbleMenu editor={editor} />}
        </div>
      </TooltipProvider>
    );
  }

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Host />));
    expect(activeEditor).toBeDefined();
    await act(async () => {
      parseMarkdown(activeEditor, markdown);
    });

    const editor = activeEditor;
    const scrollContainer = host.querySelector('[data-testid="scroll-container"]') as HTMLElement;
    const selectableRanges: Array<{ from: number; to: number }> = [];
    editor.state.doc.descendants((node, position) => {
      if (node.isText && (node.text?.length ?? 0) >= 12) {
        selectableRanges.push({ from: position, to: position + 12 });
      }
    });
    expect(selectableRanges.length).toBeGreaterThan(40);
    for (let index = 0; index < 40; index += 1) {
      const { from, to } = selectableRanges[index];
      await act(async () => {
        editor.commands.setTextSelection({ from, to });
        editor.commands.setTextSelection(to);
        scrollContainer.scrollTop = index * 120;
        scrollContainer.dispatchEvent(new Event('scroll'));
      });
    }

    // 初始化与 80 次显式选区事务允许少量插件事务，但不能出现失控的配置更新风暴。
    expect(observedTransactions).toBeGreaterThanOrEqual(80);
    expect(observedTransactions).toBeLessThan(120);
    expect(host.textContent).toContain('第 120 段');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    restoreRangeLayout();
  }
}, 20_000);
