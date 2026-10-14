// NoteBoard CodeMirror 三击选行：不带行尾换行符
// 单独成模块，供基础扩展集与图表 / 信息图分屏源码编辑器共用，避免后者引入整套基础扩展

import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** 某位置所在视觉行的范围（软换行时为折行片段），不含行尾换行符 */
function visualLineRangeAt(view: EditorView, pos: number): { from: number; to: number } {
  const cursor = EditorSelection.cursor(pos);
  return {
    from: view.moveToLineBoundary(cursor, false, true).head,
    to: view.moveToLineBoundary(cursor, true, true).head,
  };
}

/**
 * 三击只选中本行文字，不带行尾换行符。
 * CM 默认三击会把换行符一并选入，选区终点落到下一行行首，
 * 活动行高亮与行号高亮随之跳到下一行，看起来像下一行也被选中了一截。
 * 其余逻辑（按视觉行选取、拖动逐行扩选、Shift 扩选、多选）与 CM 默认一致。
 * 双击无需处理：CM 的 groupAt 在行尾会向前取词、空行只放光标，不会选中换行。
 */
export const tripleClickLineSelection = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.detail < 3) return null;
  let start = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  let startSel = view.state.selection;
  return {
    update(update) {
      if (update.docChanged) {
        start = update.changes.mapPos(start);
        startSel = startSel.map(update.changes);
      }
    },
    get(curEvent, extend, multiple) {
      const cur = visualLineRangeAt(view, view.posAtCoords({ x: curEvent.clientX, y: curEvent.clientY }, false));
      const first = visualLineRangeAt(view, start);
      // 拖动跨行时从起始行扩展到当前行，方向跟随鼠标
      const from = Math.min(first.from, cur.from);
      const to = Math.max(first.to, cur.to);
      const range = cur.from < first.from ? EditorSelection.range(to, from) : EditorSelection.range(from, to);
      if (extend) return startSel.replaceRange(startSel.main.extend(range.from, range.to));
      if (multiple) return startSel.addRange(range);
      return EditorSelection.create([range]);
    },
  };
});
