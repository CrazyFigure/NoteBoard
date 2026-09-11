// NoteBoard Markdown 大纲运行时回归测试
// 覆盖多文件切换的 Effect 稳定性，以及 Ctrl+F 搜索选区与右侧大纲的职责隔离。

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, test } from 'vitest';
import { useHeadings } from '@/features/outline/useHeadings';
import { searchReplaceExtension } from '@/features/editor-md/searchReplace';
import { executeSearch } from '@/features/search/searchController';

/** 等待大纲选区监听的 100ms 防抖完成。 */
function waitForOutlineSelection(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 130));
}

/** 将 Hook 状态投影到 DOM，便于验证切换与搜索后的最终大纲状态。 */
function OutlineProbe({ editor }: { editor: Editor | null }) {
  const { headings, activeId } = useHeadings(editor);
  return (
    <div
      data-headings={headings.map((heading) => heading.text).join('|')}
      data-active-id={activeId ?? ''}
    />
  );
}

describe('Markdown 大纲运行时稳定性', () => {
  const mountedRoots: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];
  const editors: Editor[] = [];

  afterEach(async () => {
    for (const mounted of mountedRoots.splice(0)) {
      await act(async () => mounted.root.unmount());
      mounted.host.remove();
    }
    for (const editor of editors.splice(0)) editor.destroy();
  });

  /** 创建带真实 ProseMirror 状态的轻量编辑器，避免用不完整 mock 掩盖事务问题。 */
  function createEditor(content: string, withSearch = false): Editor {
    const editor = new Editor({
      extensions: withSearch ? [StarterKit, searchReplaceExtension()] : [StarterKit],
      content,
    });
    editors.push(editor);
    return editor;
  }

  /** 挂载大纲探针并登记统一清理。 */
  function mountProbe(editor: Editor) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push({ root, host });
    return { root, host, editor };
  }

  test('反复切换 Markdown editor 不形成 React #185 更新闭环', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const first = createEditor('<h1>第一份文档</h1><p>正文 A</p>');
    const second = createEditor('<h1>第二份文档</h1><h2>第二节</h2><p>正文 B</p>');
    const mounted = mountProbe(first);

    await act(async () => mounted.root.render(<OutlineProbe editor={first} />));
    for (let index = 0; index < 24; index += 1) {
      const current = index % 2 === 0 ? second : first;
      // 真实切换中可能短暂经过“活动 visual 内核尚未就绪”的 null 状态。
      await act(async () => mounted.root.render(<OutlineProbe editor={null} />));
      await act(async () => mounted.root.render(<OutlineProbe editor={current} />));
    }

    const probe = mounted.host.firstElementChild as HTMLElement;
    expect(probe.dataset.headings).toBe('第一份文档');
    expect(probe.dataset.activeId).toBe('h-0');
  });

  test('Ctrl+F 搜索只滚动正文，不驱动右侧大纲切换当前项', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const editor = createEditor(
      '<h1>第一章</h1><p>开头内容</p><h1>第二章</h1><p>唯一搜索词</p>',
      true,
    );
    const mounted = mountProbe(editor);
    await act(async () => mounted.root.render(<OutlineProbe editor={editor} />));
    const probe = mounted.host.firstElementChild as HTMLElement;
    const initialActiveId = probe.dataset.activeId;

    await act(async () => {
      const stats = executeSearch(
        { type: 'tiptap', editor },
        {
          searchText: '唯一搜索词',
          replaceText: '',
          caseSensitive: false,
          wholeWord: false,
          isRegex: false,
        },
      );
      expect(stats.matchCount).toBe(1);
      await waitForOutlineSelection();
    });

    // 搜索已把正文选区移动到第二章，但大纲仍保持用户搜索前的当前位置。
    expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe('唯一搜索词');
    expect(probe.dataset.activeId).toBe(initialActiveId);

    // 普通正文选区仍然需要驱动大纲，证明只隔离了搜索事务。
    let resolvedPosition = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'heading' && node.textContent === '第二章') resolvedPosition = position + 1;
    });
    expect(resolvedPosition).toBeGreaterThan(1);
    await act(async () => {
      editor.commands.setTextSelection(resolvedPosition);
      await waitForOutlineSelection();
    });
    expect(probe.dataset.activeId).not.toBe(initialActiveId);
  });
});
