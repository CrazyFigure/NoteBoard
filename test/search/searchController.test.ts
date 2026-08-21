// NoteBoard 搜索替换控制器单元测试
// 验证反斜杠字面量检索、替换以及无匹配时的高亮与选区重置

import { describe, test, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { search } from '@codemirror/search';
import {
  executeSearch,
  executeFindNext,
  executeFindPrev,
  executeReplace,
  executeReplaceAll,
} from '@/features/search/searchController';

// JSDOM 环境下补全 Range 测量接口以支持 CodeMirror 6
if (typeof Range !== 'undefined') {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;
  }
}

describe('searchController 搜索与替换控制器', () => {
  // 创建包含 search 扩展的 CodeMirror 实例辅助函数
  function createCMView(docText: string): EditorView {
    const state = EditorState.create({
      doc: docText,
      extensions: [search({ top: false })],
    });
    return new EditorView({ state });
  }

  test('精确匹配反斜杠字面量：搜索 \\\\ 时不匹配单个 \\', () => {
    // 文档包含：一个单反斜杠 \ 和一个双反斜杠 \\
    const doc = 'Single: \\ and Double: \\\\ end';
    const view = createCMView(doc);

    // 1. 搜索单反斜杠 "\"
    const singleStats = executeSearch(
      { type: 'codemirror', view },
      {
        searchText: '\\',
        replaceText: '',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    );
    // 全文共 3 个反斜杠字符（1个单反斜杠 + 2个连着的反斜杠 = 3 处匹配）
    expect(singleStats.matchCount).toBe(3);

    // 2. 搜索双反斜杠 "\\"
    const doubleStats = executeSearch(
      { type: 'codemirror', view },
      {
        searchText: '\\\\',
        replaceText: '',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    );
    // 双反斜杠字面量只有 1 处匹配，绝不匹配前面的单个反斜杠
    expect(doubleStats.matchCount).toBe(1);
    expect(doubleStats.matchIndex).toBe(1);

    // 3. 搜索四反斜杠 "\\\\"
    const quadStats = executeSearch(
      { type: 'codemirror', view },
      {
        searchText: '\\\\\\\\',
        replaceText: '',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    );
    // 文档中没有 4 个连续反斜杠，匹配数为 0
    expect(quadStats.matchCount).toBe(0);
    expect(quadStats.matchIndex).toBe(0);
  });

  test('反斜杠字面量替换：单处与全部替换', () => {
    const doc = 'a \\\\ b \\\\ c';
    const view = createCMView(doc);

    // 替换第一处双反斜杠为 "/"
    executeReplace(
      { type: 'codemirror', view },
      {
        searchText: '\\\\',
        replaceText: '/',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    );
    expect(view.state.doc.toString()).toBe('a / b \\\\ c');

    // 替换全部双反斜杠为 "//"
    executeReplaceAll(
      { type: 'codemirror', view },
      {
        searchText: '\\\\',
        replaceText: '//',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    );
    expect(view.state.doc.toString()).toBe('a / b // c');
  });

  test('无匹配时自动折叠选区，避免关联高亮残留', () => {
    const doc = 'apple banana orange';
    const view = createCMView(doc);

    // 1. 搜索 "apple"，命中 1 处并选中该范围
    const stats1 = executeSearch(
      { type: 'codemirror', view },
      {
        searchText: 'apple',
        replaceText: '',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    );
    expect(stats1.matchCount).toBe(1);
    expect(view.state.selection.main.empty).toBe(false);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('apple');

    // 2. 变更搜索词为 "apple123"（无匹配项）
    const stats2 = executeSearch(
      { type: 'codemirror', view },
      {
        searchText: 'apple123',
        replaceText: '',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    );
    expect(stats2.matchCount).toBe(0);
    expect(stats2.matchIndex).toBe(0);
    // 选区已被自动折叠为单光标，防止关联高亮残留
    expect(view.state.selection.main.empty).toBe(true);
  });
});
