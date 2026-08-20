// NoteBoard 文件级统一撤销/重做历史测试
// 覆盖跨模式逐步移动、连续输入分组、保存无关性与撤销后的分支行为

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllDocumentHistories,
  getCurrentDocumentHistoryContent,
  getDocumentHistoryAvailability,
  initializeDocumentHistory,
  markDocumentHistoryModeBoundary,
  recordDocumentChange,
  redoDocumentHistory,
  registerDocumentHistoryAdapter,
  synchronizeCurrentDocumentHistoryContent,
  undoDocumentHistory,
} from '../../src/features/history/documentHistory';

const DOC_KEY = 'C:\\notes\\unified-history.md';

describe('documentHistory 文件级统一时间线', () => {
  beforeEach(() => {
    clearAllDocumentHistories();
  });

  it('可视化与源码编辑按各自分组逐步撤销和重做', () => {
    initializeDocumentHistory(DOC_KEY, 'A', 'visual');
    let rendered = 'A';
    registerDocumentHistoryAdapter(DOC_KEY, {
      applyEntry: (entry) => {
        rendered = entry.content;
      },
    });

    recordDocumentChange(DOC_KEY, 'AB', { mode: 'visual', startsNewGroup: true });
    recordDocumentChange(DOC_KEY, 'ABC', { mode: 'visual', startsNewGroup: false });
    markDocumentHistoryModeBoundary(DOC_KEY);
    recordDocumentChange(DOC_KEY, 'ABCD', { mode: 'source', startsNewGroup: true });
    recordDocumentChange(DOC_KEY, 'ABCDE', { mode: 'source', startsNewGroup: true });

    expect(undoDocumentHistory(DOC_KEY)).toBe(true);
    expect(rendered).toBe('ABCD');
    expect(undoDocumentHistory(DOC_KEY)).toBe(true);
    expect(rendered).toBe('ABC');
    expect(undoDocumentHistory(DOC_KEY)).toBe(true);
    expect(rendered).toBe('A');

    expect(redoDocumentHistory(DOC_KEY)).toBe(true);
    expect(rendered).toBe('ABC');
    expect(redoDocumentHistory(DOC_KEY)).toBe(true);
    expect(rendered).toBe('ABCD');
    expect(redoDocumentHistory(DOC_KEY)).toBe(true);
    expect(rendered).toBe('ABCDE');
  });

  it('纯模式切换和保存不新增、不合并也不清空历史', () => {
    initializeDocumentHistory(DOC_KEY, '保存前', 'source');
    let rendered = '保存后';
    registerDocumentHistoryAdapter(DOC_KEY, {
      applyEntry: (entry) => {
        rendered = entry.content;
      },
    });
    recordDocumentChange(DOC_KEY, '保存后', { mode: 'source', startsNewGroup: true });

    // 模式边界和保存动作都不调用 recordDocumentChange，因此时间线仍只有真实编辑节点
    markDocumentHistoryModeBoundary(DOC_KEY);
    synchronizeCurrentDocumentHistoryContent(DOC_KEY, '保存后', 'visual');
    markDocumentHistoryModeBoundary(DOC_KEY);
    expect(undoDocumentHistory(DOC_KEY)).toBe(true);
    expect(rendered).toBe('保存前');
    expect(redoDocumentHistory(DOC_KEY)).toBe(true);
    expect(rendered).toBe('保存后');
  });

  it('撤销后输入会建立新分支并丢弃旧重做方向', () => {
    initializeDocumentHistory(DOC_KEY, 'A', 'visual');
    registerDocumentHistoryAdapter(DOC_KEY, { applyEntry: () => {} });
    recordDocumentChange(DOC_KEY, 'AB', { mode: 'visual', startsNewGroup: true });
    recordDocumentChange(DOC_KEY, 'ABC', { mode: 'visual', startsNewGroup: true });
    expect(undoDocumentHistory(DOC_KEY)).toBe(true);

    recordDocumentChange(DOC_KEY, 'ABX', { mode: 'source', startsNewGroup: false });
    expect(getCurrentDocumentHistoryContent(DOC_KEY)).toBe('ABX');
    expect(redoDocumentHistory(DOC_KEY)).toBe(false);
  });

  it('初始进入源码模式同样可以建立和移动历史', () => {
    initializeDocumentHistory(DOC_KEY, '# 初始', 'source');
    let rendered = '# 初始';
    registerDocumentHistoryAdapter(DOC_KEY, {
      applyEntry: (entry) => {
        rendered = entry.content;
      },
    });
    recordDocumentChange(DOC_KEY, '# 初始\n源码新增', {
      mode: 'source',
      startsNewGroup: true,
    });

    expect(undoDocumentHistory(DOC_KEY)).toBe(true);
    expect(rendered).toBe('# 初始');
    expect(redoDocumentHistory(DOC_KEY)).toBe(true);
    expect(rendered).toContain('源码新增');
  });

  it('撤销定位到分组开始前，重做定位到分组结束后', () => {
    initializeDocumentHistory(DOC_KEY, '开头\n结尾', 'source');
    const navigations: Array<{ content: string; direction: string; anchor?: number; changeOffset: number }> = [];
    registerDocumentHistoryAdapter(DOC_KEY, {
      applyEntry: (entry, navigation) => {
        navigations.push({
          content: entry.content,
          direction: navigation.direction,
          anchor: navigation.selection?.anchor,
          changeOffset: navigation.changeOffset,
        });
      },
    });

    recordDocumentChange(DOC_KEY, '开头A\n结尾', {
      mode: 'source',
      startsNewGroup: true,
      beforeSelection: { anchor: 2, head: 2 },
      selection: { anchor: 3, head: 3 },
    });
    recordDocumentChange(DOC_KEY, '开头AB\n结尾', {
      mode: 'source',
      startsNewGroup: false,
      beforeSelection: { anchor: 3, head: 3 },
      selection: { anchor: 4, head: 4 },
    });

    expect(undoDocumentHistory(DOC_KEY)).toBe(true);
    expect(navigations[0]).toEqual({
      content: '开头\n结尾',
      direction: 'undo',
      anchor: 2,
      changeOffset: 2,
    });
    expect(redoDocumentHistory(DOC_KEY)).toBe(true);
    expect(navigations[1]).toEqual({
      content: '开头AB\n结尾',
      direction: 'redo',
      anchor: 4,
      changeOffset: 2,
    });
  });

  it('工具栏可用状态始终跟随文件级历史索引', () => {
    initializeDocumentHistory(DOC_KEY, 'A', 'board');
    registerDocumentHistoryAdapter(DOC_KEY, { applyEntry: () => {} });
    expect(getDocumentHistoryAvailability(DOC_KEY)).toEqual({ canUndo: false, canRedo: false });

    recordDocumentChange(DOC_KEY, 'AB', { mode: 'board', startsNewGroup: true });
    expect(getDocumentHistoryAvailability(DOC_KEY)).toEqual({ canUndo: true, canRedo: false });

    undoDocumentHistory(DOC_KEY);
    expect(getDocumentHistoryAvailability(DOC_KEY)).toEqual({ canUndo: false, canRedo: true });

    redoDocumentHistory(DOC_KEY);
    expect(getDocumentHistoryAvailability(DOC_KEY)).toEqual({ canUndo: true, canRedo: false });
  });
});
