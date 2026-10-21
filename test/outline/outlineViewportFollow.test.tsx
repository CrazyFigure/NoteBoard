// NoteBoard 大纲当前项联动测试
// 验证编辑区滚动后：光标仍在可视区内时跟随光标，光标滚出可视区时跟随可视区最上方章节；
// 搜索产生的程序化选区本身不驱动大纲，但搜索把页面滚走后按可视区跟随。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import { useHeadings } from '../../src/features/outline/useHeadings';
import { EDITOR_SEARCH_NAVIGATION_META } from '../../src/core/editor/searchNavigation';

/** 构造固定视口矩形 */
function rect(top: number, height: number): DOMRect {
  return {
    x: 0, y: top, top, left: 0, right: 400, bottom: top + height, width: 400, height,
    toJSON: () => ({}),
  } as DOMRect;
}

function Probe({ editor }: { editor: Editor }) {
  const { activeId } = useHeadings(editor);
  return <span data-active={activeId ?? ''} />;
}

describe('useHeadings 可视区联动', () => {
  let host: HTMLDivElement;
  let root: Root;
  let scroller: HTMLDivElement;
  let editor: Editor;
  // 光标所在行相对视口的顶部坐标，测试中按需修改以模拟光标滚出可视区
  let cursorTop = 100;

  /** 读取 Probe 渲染出的当前项 id */
  const activeId = () => host.querySelector('span')?.getAttribute('data-active');

  /** 各标题 pos：h1 A、h2 B、h2 C 依次间隔一个段落 */
  const headingPos = () => {
    const list: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') list.push(pos);
    });
    return list;
  };

  /** 模拟各标题 DOM 相对视口的顶部坐标 */
  const mockHeadingTops = (tops: number[]) => {
    headingPos().forEach((pos, index) => {
      const dom = editor.view.nodeDOM(pos) as HTMLElement;
      vi.spyOn(dom, 'getBoundingClientRect').mockReturnValue(rect(tops[index], 30));
    });
  };

  /** 触发滚动并等待 debounce */
  const scroll = () => {
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(60);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    scroller = document.createElement('div');
    scroller.className = 'nb-md-visual-scroller';
    const mount = document.createElement('div');
    scroller.appendChild(mount);
    document.body.appendChild(scroller);
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, 500));

    editor = new Editor({
      element: mount,
      extensions: [StarterKit],
      content: '<h1>A</h1><p>a</p><h2>B</h2><p>b</p><h2>C</h2><p>c</p>',
    });
    cursorTop = 100;
    vi.spyOn(editor.view, 'coordsAtPos').mockImplementation(() => ({
      left: 0, right: 0, top: cursorTop, bottom: cursorTop + 20,
    }));
    // 光标放在第一段 a 内
    editor.commands.setTextSelection(headingPos()[0] + 4);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Probe editor={editor} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    editor.destroy();
    host.remove();
    scroller.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('光标仍在可视区内时滚动后跟随光标', () => {
    mockHeadingTops([-200, 10, 300]);
    scroll();
    expect(activeId()).toBe(`h-${headingPos()[0]}`);
  });

  it('光标滚出可视区后跟随可视区最上方章节', () => {
    cursorTop = -400;
    mockHeadingTops([-500, -200, 20]);
    scroll();
    // C 顶部进入顶端阈值内，视为当前章节
    expect(activeId()).toBe(`h-${headingPos()[2]}`);

    mockHeadingTops([-500, -200, 120]);
    scroll();
    expect(activeId()).toBe(`h-${headingPos()[1]}`);
  });

  it('搜索选区本身不驱动大纲，页面滚走后按可视区跟随', () => {
    const before = activeId();
    act(() => {
      const target = headingPos()[2] + 4;
      editor.view.dispatch(
        editor.state.tr
          .setSelection(TextSelection.create(editor.state.doc, target))
          .setMeta(EDITOR_SEARCH_NAVIGATION_META, true),
      );
      vi.advanceTimersByTime(150);
    });
    expect(activeId()).toBe(before);

    // 搜索把命中项滚到可视区中央：光标可见，跟随命中项所在章节
    mockHeadingTops([-800, -500, 200]);
    scroll();
    expect(activeId()).toBe(`h-${headingPos()[2]}`);
  });
});
