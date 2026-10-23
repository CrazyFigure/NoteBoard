// NoteBoard 还原历史版本：整篇替换作为一次新编辑写入统一时间线，Ctrl+Z 可撤销

import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyDocumentContentAsChange,
  clearAllDocumentHistories,
  getCurrentDocumentHistoryContent,
  initializeDocumentHistory,
  recordDocumentChange,
  redoDocumentHistory,
  registerDocumentHistoryAdapter,
  undoDocumentHistory,
} from '../../src/features/history/documentHistory';

const DOC_KEY = 'C:\\notes\\restore.md';

describe('applyDocumentContentAsChange', () => {
  beforeEach(() => clearAllDocumentHistories());

  it('替换内容后可撤销回替换前，重做回到还原内容', () => {
    initializeDocumentHistory(DOC_KEY, '原文', 'visual');
    let rendered = '原文';
    registerDocumentHistoryAdapter(DOC_KEY, { applyEntry: (entry) => { rendered = entry.content; } });
    recordDocumentChange(DOC_KEY, '原文+未保存', { mode: 'visual', startsNewGroup: true });

    expect(applyDocumentContentAsChange(DOC_KEY, '历史版本')).toBe(true);
    expect(rendered).toBe('历史版本');
    expect(getCurrentDocumentHistoryContent(DOC_KEY)).toBe('历史版本');

    expect(undoDocumentHistory(DOC_KEY)).toBe(true);
    expect(rendered).toBe('原文+未保存');
    expect(redoDocumentHistory(DOC_KEY)).toBe(true);
    expect(rendered).toBe('历史版本');
  });

  it('撤销后还原会丢弃旧的重做分支', () => {
    initializeDocumentHistory(DOC_KEY, 'A', 'code');
    registerDocumentHistoryAdapter(DOC_KEY, { applyEntry: () => {} });
    recordDocumentChange(DOC_KEY, 'AB', { mode: 'code', startsNewGroup: true });
    undoDocumentHistory(DOC_KEY);
    expect(applyDocumentContentAsChange(DOC_KEY, 'Z')).toBe(true);
    expect(redoDocumentHistory(DOC_KEY)).toBe(false);
    expect(undoDocumentHistory(DOC_KEY)).toBe(true);
    expect(getCurrentDocumentHistoryContent(DOC_KEY)).toBe('A');
  });

  it('没有已挂载编辑器或编辑器拒绝时返回 false 且时间线不变', () => {
    initializeDocumentHistory(DOC_KEY, 'A', 'code');
    expect(applyDocumentContentAsChange(DOC_KEY, 'B')).toBe(false);
    registerDocumentHistoryAdapter(DOC_KEY, { applyEntry: () => { throw new Error('未就绪'); } });
    expect(applyDocumentContentAsChange(DOC_KEY, 'B')).toBe(false);
    expect(getCurrentDocumentHistoryContent(DOC_KEY)).toBe('A');
    expect(undoDocumentHistory(DOC_KEY)).toBe(false);
  });

  it('内容相同直接成功，不新增步骤', () => {
    initializeDocumentHistory(DOC_KEY, 'A', 'code');
    registerDocumentHistoryAdapter(DOC_KEY, { applyEntry: () => {} });
    expect(applyDocumentContentAsChange(DOC_KEY, 'A')).toBe(true);
    expect(undoDocumentHistory(DOC_KEY)).toBe(false);
  });
});
