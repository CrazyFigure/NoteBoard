import type { EditorView } from '@codemirror/view';
import { readReadingPosition } from './readingPosition';

/** CM 虚拟文档须完成首次布局再应用像素位置，避免远处的阅读位置被初始高度截断。 */
export function restoreTextScroll(view: EditorView, scrollTop: number): void {
  view.scrollDOM.scrollTop = scrollTop;
  view.requestMeasure({
    read: () => null,
    write: () => { view.scrollDOM.scrollTop = scrollTop; },
  });
}

/** HTML / 图表源码同属文本类；不把保存的旧光标滚动到视口中。 */
export function restoreSplitReadingPosition(docKey: string, view: EditorView): void {
  const restored = readReadingPosition(docKey);
  if (restored?.kind !== 'split-diagram') return;
  if (restored.selection) {
    const max = view.state.doc.length;
    view.dispatch({ selection: {
      anchor: Math.min(restored.selection.anchor, max),
      head: Math.min(restored.selection.head, max),
    } });
  }
  restoreTextScroll(view, restored.scrollTop);
}
