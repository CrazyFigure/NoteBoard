// NoteBoard Markdown 可视化编辑区滚动容器定位测试
// 验证跳过不滚动的 EditorContent 包裹层，定位到真正滚动的外层 scroller。

import { afterEach, describe, expect, it } from 'vitest';
import { findVisualScrollContainer } from '@/features/editor-md/visualScroller';

/** 构造 scroller > EditorContent 包裹层 > .ProseMirror 的嵌套结构 */
function buildTree(scrollerSetup: (scroller: HTMLDivElement) => void): HTMLElement {
  const scroller = document.createElement('div');
  scrollerSetup(scroller);
  const wrapper = document.createElement('div');
  wrapper.style.height = '100%';
  const editorDom = document.createElement('div');
  editorDom.className = 'ProseMirror';
  wrapper.appendChild(editorDom);
  scroller.appendChild(wrapper);
  document.body.appendChild(scroller);
  return editorDom;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('findVisualScrollContainer', () => {
  it('优先返回带固定类名的外层 scroller，而非 EditorContent 包裹层', () => {
    const editorDom = buildTree((scroller) => {
      scroller.className = 'nb-md-visual-scroller';
    });
    expect(findVisualScrollContainer(editorDom)?.className).toBe('nb-md-visual-scroller');
  });

  it('无固定类名时回退到最近的可纵向滚动祖先', () => {
    const editorDom = buildTree((scroller) => {
      scroller.style.overflowY = 'auto';
      scroller.dataset.role = 'fallback';
    });
    expect(findVisualScrollContainer(editorDom)?.dataset.role).toBe('fallback');
  });

  it('没有任何滚动祖先时返回 null', () => {
    const editorDom = buildTree(() => undefined);
    expect(findVisualScrollContainer(editorDom)).toBeNull();
  });
});
