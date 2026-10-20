// NoteBoard 纯文本内嵌 JSON 高亮测试
// 验证 JSON 块识别、词法切分，以及在编辑器中复用 JSON 配色类名

import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { highlightingFor } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import {
  findJsonBlocks,
  tokenizeJson,
  plainJsonHighlight,
} from '../../src/features/editor-code/plainJsonHighlight';
import { nbSyntaxHighlighting } from '../../src/features/editor-code/highlightStyle';

function blockTexts(text: string): string[] {
  return findJsonBlocks(text).map((b) => text.slice(b.from, b.to));
}

describe('findJsonBlocks', () => {
  it('识别正文中的格式化 JSON 块', () => {
    const json = '{\n  "name": "nb",\n  "list": [1, true, null]\n}';
    const text = `说明文字\n${json}\n结尾`;
    expect(blockTexts(text)).toEqual([json]);
  });

  it('识别行尾开括号起始的多行块（选区格式化场景）', () => {
    const text = 'payload={\n  "a": 1\n} user=bob';
    expect(blockTexts(text)).toEqual(['{\n  "a": 1\n}']);
  });

  it('识别逐行 JSON（JSONL）', () => {
    const text = '{"a":1}\n{"b":2}\n';
    expect(blockTexts(text)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('不识别非法 JSON 与普通正文', () => {
    expect(blockTexts('{ 这不是 JSON }')).toEqual([]);
    expect(blockTexts("{'a': 1}")).toEqual([]);
    expect(blockTexts('[1] 见上文')).toEqual([]);
    expect(blockTexts('{\n  "a": 1,\n}')).toEqual([]);
  });

  it('未闭合块之后的合法块仍可识别', () => {
    const text = '{ "broken": \n{"ok": 1}';
    expect(blockTexts(text)).toEqual(['{"ok": 1}']);
  });
});

describe('tokenizeJson', () => {
  it('区分键名与字符串值', () => {
    const text = '{"k": "v", "n": -1.5e3, "b": false, "z": null}';
    const types = tokenizeJson(text, 0, text.length, text.length).map(
      (tk) => `${tk.type}:${text.slice(tk.from, tk.to)}`,
    );
    expect(types).toEqual([
      'brace:{',
      'property:"k"', 'separator::', 'string:"v"', 'separator:,',
      'property:"n"', 'separator::', 'number:-1.5e3', 'separator:,',
      'property:"b"', 'separator::', 'bool:false', 'separator:,',
      'property:"z"', 'separator::', 'null:null',
      'brace:}',
    ]);
  });

  it('处理转义引号与跨行冒号', () => {
    const text = '{"a\\"b"\n  : "x"}';
    const keys = tokenizeJson(text, 0, text.length, text.length).filter((tk) => tk.type === 'property');
    expect(keys.map((tk) => text.slice(tk.from, tk.to))).toEqual(['"a\\"b"']);
  });
});

describe('plainJsonHighlight 扩展', () => {
  it('为纯文本中的 JSON 键/值添加与 JSON 文件一致的高亮类名', () => {
    const doc = '前言\n{\n  "key": "value",\n  "num": 42\n}';
    const state = EditorState.create({ doc, extensions: [nbSyntaxHighlighting, plainJsonHighlight()] });
    const view = new EditorView({ state });
    const propCls = highlightingFor(view.state, [t.propertyName])!;
    const strCls = highlightingFor(view.state, [t.string])!;
    const numCls = highlightingFor(view.state, [t.number])!;

    expect(view.contentDOM.querySelector(`.${propCls}`)?.textContent).toBe('"key"');
    expect(Array.from(view.contentDOM.querySelectorAll(`.${strCls}`)).map((n) => n.textContent)).toContain('"value"');
    expect(view.contentDOM.querySelector(`.${numCls}`)?.textContent).toBe('42');
    // 正文不应被上色
    expect(view.contentDOM.querySelector('.cm-line')?.innerHTML).toBe('前言');
    view.destroy();
  });
});
