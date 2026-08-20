// NoteBoard 文本与代码辅助操作工具
// 支持大小写转换（全部大写、全部小写、词首大写）、代码片段插入等

import type { EditorView } from '@codemirror/view';
import { showToast } from '../../stores/toastStore';

/**
 * 文本大小写转换类型
 */
export type CaseTransformMode = 'upper' | 'lower' | 'title';

/**
 * 词首大写转换算法
 */
function toTitleCase(str: string): string {
  return str.replace(/\b([a-zA-Z])/g, (char) => char.toUpperCase());
}

/**
 * 执行文本大小写转换
 * 若有选中文本则转换选区，若无选区则转换当前行
 */
export function handleTransformCase(view: EditorView, mode: CaseTransformMode): boolean {
  const selection = view.state.selection.main;
  const isSelected = !selection.empty;

  let from = selection.from;
  let to = selection.to;
  let text = '';
  let scopeLabel = '选中文本';

  // 1. 若选区不为空，针对选区执行转换
  if (isSelected) {
    text = view.state.sliceDoc(from, to);
  } else {
    // 2. 若选区为空，针对当前光标所在行执行转换
    const line = view.state.doc.lineAt(selection.head);
    from = line.from;
    to = line.to;
    text = line.text;
    scopeLabel = '当前行';
  }

  if (!text.trim()) {
    showToast(`${scopeLabel}内容为空，无需转换`, 'info');
    return false;
  }

  let transformed = text;
  let modeLabel = '';

  // 根据目标模式转换文本
  switch (mode) {
    case 'upper':
      transformed = text.toUpperCase();
      modeLabel = '全部大写';
      break;
    case 'lower':
      transformed = text.toLowerCase();
      modeLabel = '全部小写';
      break;
    case 'title':
      transformed = toTitleCase(text);
      modeLabel = '词首大写';
      break;
  }

  if (transformed === text) {
    showToast(`文本已经是${modeLabel}格式`, 'info');
    return true;
  }

  // 分发文本变更到 CodeMirror 视图
  view.dispatch({
    changes: { from, to, insert: transformed },
    selection: isSelected
      ? { anchor: from, head: from + transformed.length }
      : { anchor: Math.min(selection.head, from + transformed.length) },
    scrollIntoView: true,
  });

  view.focus();
  showToast(`✓ 已将${scopeLabel}转换为${modeLabel}`, 'success');
  return true;
}
