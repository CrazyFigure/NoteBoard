// NoteBoard Markdown 可视化编辑区滚动容器定位
// DOM 结构：.nb-md-visual-scroller（真正滚动）> EditorContent 包裹层 > .ProseMirror，
// contenteditable 与 EditorContent 包裹层都不自身滚动，读写 scrollTop 必须落在外层 scroller。

/** 查找可视化编辑区的滚动容器：优先固定类名，其次最近的可纵向滚动祖先 */
export function findVisualScrollContainer(editorDom: HTMLElement): HTMLElement | null {
  const scroller = editorDom.closest<HTMLElement>('.nb-md-visual-scroller');
  if (scroller) return scroller;
  for (let node = editorDom.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
  }
  return null;
}
