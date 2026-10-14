// 表格外拖选进表格时选区被吞掉的修正
//
// 问题：prosemirror-tables 的 tableEditing 插件在每次事务后执行 normalizeSelection，
// 其中 isTextSelectionAcrossCells 规则会把「起止于不同单元格、且终点位于段落开头」的文本选区
// 收缩为起点所在单元格的内容（本意是处理三击等从一格选到下一格开头的情况）。
// 但它把「不在任何单元格内」也当成另一个单元格：从表格外的空段落（或任意段落开头）拖选进表格时，
// 选区被收缩成单元格内的光标——拖动中只剩浏览器原生高亮，松手后选中效果直接消失；
// 从段落文字中间或末尾起拖则不受影响，两种拖法表现不一致。
//
// 方案：包装 tableEditing 插件的 appendTransaction，选区一端在单元格内、另一端在表格外时，
// 撤销这次收缩，保留原选区。两端都在单元格内（包括三击整格）仍走原有规则。

import type { ResolvedPos } from '@tiptap/pm/model';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { tableEditingKey } from '@tiptap/pm/tables';

/** 位置是否处在表格单元格（含表头单元格）内 */
function isInCell($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const role = $pos.node(depth).type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') return true;
  }
  return false;
}

/** 替换表格扩展插件列表中的 tableEditing 插件，修正其选区规整规则 */
export function fixTableEditingSelection(plugins: Plugin[]): Plugin[] {
  return plugins.map((plugin) => {
    const original = plugin.spec.appendTransaction;
    if (plugin.spec.key !== tableEditingKey || !original) return plugin;

    return new Plugin({
      ...plugin.spec,
      appendTransaction(transactions, oldState, newState) {
        const tr = original.call(plugin, transactions, oldState, newState);
        const selection = newState.selection;
        // 只处理「一端在单元格内、另一端在表格外」的非空文本选区，其余情况保持原规则
        if (
          !tr ||
          !(selection instanceof TextSelection) ||
          selection.empty ||
          isInCell(selection.$from) === isInCell(selection.$to)
        ) {
          return tr;
        }
        // 撤销误收缩：按本次修表（fixTables）产生的文档变更映射回原选区
        const kept = selection.map(tr.doc, tr.mapping);
        if (!tr.selection.eq(kept)) tr.setSelection(kept);
        // 只剩选区收缩时不再追加事务，否则规整规则会在下一轮再次触发，形成循环
        return tr.docChanged ? tr : null;
      },
    });
  });
}
