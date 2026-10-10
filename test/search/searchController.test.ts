// NoteBoard 搜索替换控制器单元测试
// 验证反斜杠字面量检索、替换以及无匹配时的高亮与选区重置
// 以及"搜索不自动跳转、基于光标导航、首/末跳转"的交互语义

import { describe, test, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { search } from '@codemirror/search';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  executeSearch,
  executeFindNext,
  executeFindPrev,
  executeFindFirst,
  executeFindLast,
  executeReplace,
  executeReplaceAll,
  type SearchOptions,
} from '@/features/search/searchController';
import { searchReplaceExtension } from '@/features/editor-md/searchReplace';

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
    // 搜索不自动跳转：光标不在匹配项上，当前序号为 0
    expect(doubleStats.matchIndex).toBe(0);

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

  test('反斜杠字面量替换：单处与全部替换返回正确计数与状态', () => {
    const doc = 'a \\\\ b \\\\ c';
    const view = createCMView(doc);

    // 替换第一处双反斜杠为 "/"
    const res1 = executeReplace(
      { type: 'codemirror', view },
      {
        searchText: '\\\\',
        replaceText: '/',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    );
    expect(res1.success).toBe(true);
    expect(res1.replacedCount).toBe(1);
    expect(view.state.doc.toString()).toBe('a / b \\\\ c');

    // 替换全部双反斜杠为 "//"
    const res2 = executeReplaceAll(
      { type: 'codemirror', view },
      {
        searchText: '\\\\',
        replaceText: '//',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    );
    expect(res2.success).toBe(true);
    expect(res2.replacedCount).toBe(1);
    expect(view.state.doc.toString()).toBe('a / b // c');

    // 无匹配项时执行替换，返回 success: false, replacedCount: 0
    const res3 = executeReplace(
      { type: 'codemirror', view },
      {
        searchText: 'not_exist',
        replaceText: 'foo',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    );
    expect(res3.success).toBe(false);
    expect(res3.replacedCount).toBe(0);

    // 无匹配项时执行全部替换，返回 success: false, replacedCount: 0
    const res4 = executeReplaceAll(
      { type: 'codemirror', view },
      {
        searchText: 'not_exist',
        replaceText: 'foo',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    );
    expect(res4.success).toBe(false);
    expect(res4.replacedCount).toBe(0);

    // 正则表达式语法错误时返回 error 提示
    const res5 = executeReplace(
      { type: 'codemirror', view },
      {
        searchText: '[invalid_regex',
        replaceText: 'foo',
        caseSensitive: false,
        wholeWord: false,
        isRegex: true,
      },
    );
    expect(res5.success).toBe(false);
    expect(res5.error).toBe('正则表达式格式错误');
  });

  test('无匹配时自动折叠选区，避免关联高亮残留', () => {
    const doc = 'apple banana orange';
    const view = createCMView(doc);

    // 1. 搜索并跳转到 "apple"，命中 1 处并选中该范围
    const stats1 = executeFindNext(
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

/** 构造搜索选项 */
function opts(searchText: string, replaceText = ''): SearchOptions {
  return { searchText, replaceText, caseSensitive: false, wholeWord: false, isRegex: false };
}

describe('搜索导航语义（CodeMirror：TXT / 代码 / MD 源码）', () => {
  // 文档中 "foo" 位于 0、8、16
  const DOC = 'foo bar foo bar foo';

  function createView(cursor: number): EditorView {
    const state = EditorState.create({
      doc: DOC,
      selection: { anchor: cursor },
      extensions: [search({ top: false })],
    });
    return new EditorView({ state });
  }

  test('输入搜索词只更新计数，不移动光标', () => {
    const view = createView(10);
    const stats = executeSearch({ type: 'codemirror', view }, opts('foo'));
    expect(stats).toEqual({ matchIndex: 0, matchCount: 3 });
    expect(view.state.selection.main.from).toBe(10);
    expect(view.state.selection.main.empty).toBe(true);
  });

  test('编辑正文删掉当前匹配后重跑搜索，不会跳回第一个匹配', () => {
    const view = createView(0);
    const target = { type: 'codemirror' as const, view };
    executeFindNext(target, opts('foo'));
    executeFindNext(target, opts('foo'));
    expect(view.state.selection.main.from).toBe(8);
    // 模拟用户删除当前选中的 "foo"
    view.dispatch({ changes: { from: 8, to: 11 }, selection: { anchor: 8 } });
    const stats = executeSearch(target, opts('foo'));
    expect(stats).toEqual({ matchIndex: 0, matchCount: 2 });
    expect(view.state.selection.main.from).toBe(8);
  });

  test('下一个/上一个基于当前光标位置，并在两端回绕', () => {
    const view = createView(10); // 位于第二个 foo 内部
    const target = { type: 'codemirror' as const, view };
    expect(executeFindNext(target, opts('foo')).matchIndex).toBe(3);
    expect(view.state.selection.main.from).toBe(16);
    // 末尾回绕到首个
    expect(executeFindNext(target, opts('foo')).matchIndex).toBe(1);
    // 开头回绕到末个
    expect(executeFindPrev(target, opts('foo')).matchIndex).toBe(3);
    expect(executeFindPrev(target, opts('foo')).matchIndex).toBe(2);

    const view2 = createView(10);
    expect(executeFindPrev({ type: 'codemirror', view: view2 }, opts('foo')).matchIndex).toBe(1);
  });

  test('跳转到第一个 / 最后一个匹配项', () => {
    const view = createView(10);
    const target = { type: 'codemirror' as const, view };
    expect(executeFindLast(target, opts('foo'))).toEqual({ matchIndex: 3, matchCount: 3 });
    expect(view.state.selection.main.from).toBe(16);
    expect(executeFindFirst(target, opts('foo'))).toEqual({ matchIndex: 1, matchCount: 3 });
    expect(view.state.selection.main.from).toBe(0);
  });

  test('替换：光标不在匹配上时替换光标之后的下一处', () => {
    const view = createView(5);
    const res = executeReplace({ type: 'codemirror', view }, opts('foo', 'X'));
    expect(res.replacedCount).toBe(1);
    expect(view.state.doc.toString()).toBe('foo bar X bar foo');
  });
});

describe('搜索导航语义（TipTap：MD 可视化）', () => {
  // 三个段落，"foo" 各出现一次
  function createEditor(): Editor {
    return new Editor({
      extensions: [StarterKit, searchReplaceExtension()],
      content: '<p>foo one</p><p>foo two</p><p>foo three</p>',
    });
  }

  /** 选区文本 */
  function selectedText(editor: Editor): string {
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to);
  }

  /** 选区所在段落文本 */
  function currentParagraph(editor: Editor): string {
    return editor.state.selection.$from.parent.textContent;
  }

  test('输入搜索词只更新计数，不移动光标', () => {
    const editor = createEditor();
    editor.commands.setTextSelection(12); // 第二段内
    const before = editor.state.selection.from;
    const stats = executeSearch({ type: 'tiptap', editor }, opts('foo'));
    expect(stats).toEqual({ matchIndex: 0, matchCount: 3 });
    expect(editor.state.selection.from).toBe(before);
    editor.destroy();
  });

  test('下一个/上一个基于光标，首/末跳转正确', () => {
    const editor = createEditor();
    const target = { type: 'tiptap' as const, editor };
    editor.commands.setTextSelection(12); // 第二段 "foo two" 中的 "two" 附近
    expect(executeFindNext(target, opts('foo')).matchIndex).toBe(3);
    expect(currentParagraph(editor)).toBe('foo three');
    expect(selectedText(editor)).toBe('foo');
    expect(executeFindPrev(target, opts('foo')).matchIndex).toBe(2);
    expect(currentParagraph(editor)).toBe('foo two');
    expect(executeFindFirst(target, opts('foo')).matchIndex).toBe(1);
    expect(currentParagraph(editor)).toBe('foo one');
    expect(executeFindLast(target, opts('foo')).matchIndex).toBe(3);
    // 选区恰在匹配上时重跑搜索，序号保持
    expect(executeSearch(target, opts('foo')).matchIndex).toBe(3);
    editor.destroy();
  });

  test('替换当前匹配后定位到下一处，替换为空串不删除段落', () => {
    const editor = createEditor();
    const target = { type: 'tiptap' as const, editor };
    executeFindFirst(target, opts('foo'));
    const res = executeReplace(target, opts('foo', ''));
    expect(res.replacedCount).toBe(1);
    expect(res.matchCount).toBe(2);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(0).textContent).toBe(' one');
    expect(currentParagraph(editor)).toBe('foo two');
    editor.destroy();
  });
});
