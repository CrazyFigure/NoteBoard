// 思维导图节点标题搜索替换单元测试
// 验证：前序匹配顺序、搜索不跳转、上/下一个回绕、折叠分支自动展开、单处/全部替换与正则引用

import { describe, test, expect } from 'vitest';
import type { MindNode } from '@/features/mindmap/mindmapTypes';
import {
  createMindmapSearchCapabilities,
  type MindmapSearchHighlight,
} from '@/features/mindmap/mindmapSearch';
import type { TextSearchOptions } from '@/core/editor/editorTypes';

function node(id: string, text: string, children: MindNode[] = [], isExpanded?: boolean): MindNode {
  return { id, text, children, ...(isExpanded === undefined ? {} : { isExpanded }) };
}

function setup(root: MindNode) {
  const state = { root, commits: 0, highlight: null as MindmapSearchHighlight | null };
  const search = createMindmapSearchCapabilities({
    getRoot: () => state.root,
    commitRoot: (next) => {
      state.root = next;
      state.commits += 1;
    },
    onHighlight: (h) => {
      state.highlight = h;
    },
  });
  return { state, search };
}

const opts = (searchText: string, extra: Partial<TextSearchOptions> = {}): TextSearchOptions => ({
  searchText,
  replaceText: '',
  caseSensitive: false,
  wholeWord: false,
  isRegex: false,
  ...extra,
});

const tree = () =>
  node('r', 'Foo 中心', [
    node('a', 'alpha foo', [node('a1', 'foo foo')]),
    node('b', 'beta', [node('b1', 'hidden foo')], false),
  ]);

describe('思维导图搜索', () => {
  test('search 只统计与高亮，不跳转、不改树', () => {
    const { state, search } = setup(tree());
    expect(search.search(opts('foo'))).toEqual({ matchIndex: 0, matchCount: 5 });
    expect(state.commits).toBe(0);
    expect(state.highlight?.currentId).toBeNull();
    expect(state.highlight?.ranges.get('a1')).toEqual([[0, 3], [4, 7]]);
  });

  test('下一个按前序顺序前进并回绕，上一个反向', () => {
    const { state, search } = setup(tree());
    const order = [1, 2, 3, 4, 5, 1].map(() => {
      search.findNext(opts('foo'));
      return state.highlight?.currentId;
    });
    expect(order).toEqual(['r', 'a', 'a1', 'a1', 'b1', 'r']);
    search.findPrev(opts('foo'));
    expect(state.highlight?.currentId).toBe('b1');
  });

  test('跳转到折叠分支内的匹配项时展开祖先', () => {
    const original = tree();
    const { state, search } = setup(original);
    expect(search.findLast(opts('foo'))).toEqual({ matchIndex: 5, matchCount: 5 });
    expect(state.root.children[1].isExpanded).toBe(true);
    expect(state.commits).toBe(1);
    // 未改动的分支共享原引用，原树不被修改
    expect(state.root.children[0]).toBe(original.children[0]);
    expect(original.children[1].isExpanded).toBe(false);
  });

  test('区分大小写与全字匹配', () => {
    const { search } = setup(tree());
    expect(search.search(opts('Foo', { caseSensitive: true })).matchCount).toBe(1);
    expect(search.search(opts('fo', { wholeWord: true })).matchCount).toBe(0);
  });

  test('替换当前项后定位到下一个，支持连续替换', () => {
    const { state, search } = setup(tree());
    search.findNext(opts('foo'));
    search.findNext(opts('foo'));
    // 当前项为 a 的 foo
    const result = search.replace(opts('foo', { replaceText: 'X' }));
    expect(result).toMatchObject({ success: true, replacedCount: 1, matchCount: 4 });
    expect(state.root.children[0].text).toBe('alpha X');
    expect(state.highlight?.currentId).toBe('a1');
    search.replace(opts('foo', { replaceText: 'X' }));
    search.replace(opts('foo', { replaceText: 'X' }));
    expect(state.root.children[0].children[0].text).toBe('X X');
  });

  test('替换文本包含搜索词时不会重复命中自身', () => {
    const { state, search } = setup(node('r', 'foo foo'));
    search.findNext(opts('foo'));
    search.replace(opts('foo', { replaceText: 'foofoo' }));
    expect(state.root.text).toBe('foofoo foo');
    expect(state.highlight?.ranges.get('r')).toContainEqual([7, 10]);
  });

  test('全部替换一次提交，正则支持分组引用', () => {
    const { state, search } = setup(tree());
    const result = search.replaceAll(opts('(f)(oo)', { isRegex: true, replaceText: '$2$1' }));
    expect(result).toMatchObject({ success: true, replacedCount: 5, matchCount: 0 });
    expect(state.commits).toBe(1);
    expect(state.root.children[0].children[0].text).toBe('oof oof');
  });

  test('非法正则返回错误且不改树', () => {
    const { state, search } = setup(tree());
    const result = search.replaceAll(opts('(', { isRegex: true }));
    expect(result.error).toBeTruthy();
    expect(state.commits).toBe(0);
  });
});
