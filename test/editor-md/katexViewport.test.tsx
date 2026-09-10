// NoteBoard KaTeX 视口门控集成测试
// 验证屏外公式不执行 KaTeX，进入预加载范围后才按节点分别渲染。

import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { MathBlock, MathInline } from '../../src/features/editor-md/katexExtensions';
import { parseMarkdown } from '../../src/features/editor-md/serialize';

/** 可手动触发相交事件的 IntersectionObserver，用于模拟公式滚入预加载范围。 */
class ManualIntersectionObserver {
  public static current: ManualIntersectionObserver | null = null;
  public readonly targets = new Set<Element>();

  public constructor(private readonly callback: IntersectionObserverCallback) {
    ManualIntersectionObserver.current = this;
  }

  public observe(target: Element): void {
    this.targets.add(target);
  }

  public unobserve(target: Element): void {
    this.targets.delete(target);
  }

  public disconnect(): void {
    this.targets.clear();
  }

  public takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** 只激活指定公式节点，其他屏外节点应继续保持 LaTeX 原文占位。 */
  public activate(target: Element): void {
    this.callback([
      {
        target,
        isIntersecting: true,
        intersectionRatio: 1,
      } as IntersectionObserverEntry,
    ], this as unknown as IntersectionObserver);
  }
}

it('屏外公式应延迟到进入预加载范围后再渲染', async () => {
  const originalObserver = globalThis.IntersectionObserver;
  const originalAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.IntersectionObserver = ManualIntersectionObserver as unknown as typeof IntersectionObserver;
  // jsdom 的 rAF 不保证在测试时间窗内推进；用零延迟定时器模拟下一帧调度。
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => (
    setTimeout(() => callback(performance.now()), 0) as unknown as number
  ));
  globalThis.cancelAnimationFrame = ((handle: number) => clearTimeout(handle));
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  let activeEditor: Editor | null = null;
  function Host() {
    const editor = useEditor({
      extensions: [StarterKit, MathInline, MathBlock, Markdown],
      content: '',
    });
    useEffect(() => {
      activeEditor = editor;
    }, [editor]);
    return <EditorContent editor={editor} />;
  }

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Host />));
    expect(activeEditor).not.toBeNull();
    await act(async () => {
      parseMarkdown(activeEditor as Editor, '首个 $x^2$，第二个 $y^2$。');
    });

    const observer = ManualIntersectionObserver.current;
    expect(observer?.targets.size).toBe(2);
    expect(host.querySelectorAll('.katex')).toHaveLength(0);

    const [firstTarget, secondTarget] = [...observer!.targets];
    await act(async () => observer!.activate(firstTarget));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(host.querySelectorAll('.katex')).toHaveLength(1);

    await act(async () => observer!.activate(secondTarget));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(host.querySelectorAll('.katex')).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.IntersectionObserver = originalObserver;
    globalThis.requestAnimationFrame = originalAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
}, 20_000);
