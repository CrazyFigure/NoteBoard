// NoteBoard Markdown 渲染级差异测试：块对齐、行内差异、容器递归、表格与整块替换

import { describe, expect, it } from 'vitest';
import { diffMarkdownDocs, DIFF_MARK, type PMNode, type SchemaInfo } from '../../src/features/versionHistory/diff/markdownDiff';
import { diffSequences } from '../../src/features/versionHistory/diff/seqDiff';

const schema: SchemaInfo = {
  isTextblock: (t) => ['paragraph', 'heading', 'codeBlock'].includes(t),
  allowsMarks: (t) => t !== 'codeBlock',
};

const text = (t: string, marks?: PMNode['marks']): PMNode => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const p = (...content: PMNode[]): PMNode => ({ type: 'paragraph', content });
const h = (level: number, t: string): PMNode => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const doc = (...content: PMNode[]): PMNode => ({ type: 'doc', content });
const li = (...content: PMNode[]): PMNode => ({ type: 'listItem', content });
const ul = (...items: PMNode[]): PMNode => ({ type: 'bulletList', content: items });

/** 提取带差异标记的文字：[+新增] [-删除] */
function render(node: PMNode): string {
  if (node.type === 'text') {
    const kind = node.marks?.find((m) => m.type === DIFF_MARK)?.attrs?.kind;
    return kind === 'ins' ? `[+${node.text}]` : kind === 'del' ? `[-${node.text}]` : (node.text ?? '');
  }
  return (node.content ?? []).map(render).join(node.type === 'doc' || node.type === 'bulletList' ? '|' : '');
}

describe('seqDiff', () => {
  it('输出相同 / 删除 / 新增序列', () => {
    const ops = diffSequences(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
    expect(ops?.map((o) => o.type)).toEqual(['equal', 'del', 'ins', 'equal', 'equal', 'ins']);
  });
  it('超过编辑距离上限返回 null', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(diffSequences(a, b, 10)).toBeNull();
  });
});

describe('diffMarkdownDocs', () => {
  it('中文按字、英文按词做行内差异', () => {
    const r = diffMarkdownDocs(doc(p(text('00001_基础概念 tracking agent'))), doc(p(text('基础概念 tracking core agent'))), schema);
    // 「 core」与「core 」两种对齐等价
    expect(['[-00001_]基础概念 tracking [+core ]agent', '[-00001_]基础概念 tracking[+ core] agent']).toContain(render(r.doc));
    expect(r.changed).toBe(true);
    expect(r.blocks).toEqual([]);
  });

  it('新增与删除的段落整块标记，位置保持原顺序', () => {
    const r = diffMarkdownDocs(doc(p(text('一')), p(text('删掉的段落')), p(text('三'))), doc(p(text('一')), p(text('三')), h(2, '新标题')), schema);
    expect(render(r.doc)).toBe('一|删掉的段落|三|新标题');
    expect(r.blocks).toEqual([
      { path: [1], kind: 'del' },
      { path: [3], kind: 'ins' },
    ]);
  });

  it('列表递归比较：修改的项做行内差异，新增的项整块标记', () => {
    const base = doc(ul(li(p(text('Tracking：链路追踪'))), li(p(text('tracking-core')))));
    const next = doc(ul(li(p(text('Tracking：链路追踪服务'))), li(p(text('tracking-core'))), li(p(text('tracking-plugin')))));
    const r = diffMarkdownDocs(base, next, schema);
    expect(render(r.doc)).toBe('Tracking：链路追踪[+服务]|tracking-core|tracking-plugin');
    expect(r.blocks).toEqual([{ path: [0, 2], kind: 'ins' }]);
  });

  it('列表新增大量项（含后面新增的块）时仍按同一列表递归比较', () => {
    const base = doc(ul(li(p(text('Tracking 平台项目组织：')))));
    const next = doc(
      ul(li(p(text('Tracking 平台项目组织：')), ul(li(p(text('Tracking：链路追踪'))), li(p(text('tracking-common')))))),
      p(text('新增的说明段落')),
      h(2, '新标题'),
    );
    const r = diffMarkdownDocs(base, next, schema);
    // 原列表未被整块替换：标记只出现在新增的子列表与新增的块上
    expect(r.blocks.some((b) => b.path.length === 1 && b.path[0] === 0)).toBe(false);
    expect(r.blocks).toContainEqual({ path: [1], kind: 'ins' });
    expect(r.blocks).toContainEqual({ path: [2], kind: 'ins' });
  });

  it('格式变化（加粗）显示为删除 + 新增', () => {
    const r = diffMarkdownDocs(doc(p(text('重点'))), doc(p(text('重点', [{ type: 'bold' }]))), schema);
    expect(render(r.doc)).toBe('[-重][-点][+重点]'.replace('[-重][-点]', '[-重点]'));
  });

  it('标题级别变化标记为修改', () => {
    const r = diffMarkdownDocs(doc(h(2, '概念')), doc(h(3, '概念')), schema);
    expect(r.blocks).toEqual([{ path: [0], kind: 'mod' }]);
  });

  it('代码块内容变化整块替换，语言变化标记为修改', () => {
    const code = (lang: string, t: string): PMNode => ({ type: 'codeBlock', attrs: { language: lang }, content: [text(t)] });
    const r = diffMarkdownDocs(doc(code('js', 'let a = 1;')), doc(code('js', 'let a = 2;')), schema);
    expect(r.blocks).toEqual([{ path: [0], kind: 'del' }, { path: [1], kind: 'ins' }]);
    const r2 = diffMarkdownDocs(doc(code('js', 'x')), doc(code('ts', 'x')), schema);
    expect(r2.blocks).toEqual([{ path: [0], kind: 'mod' }]);
  });

  it('表格列数变化整表替换，列数相同时逐单元格比较', () => {
    const cell = (t: string): PMNode => ({ type: 'tableCell', content: [p(text(t))] });
    const row = (...cells: string[]): PMNode => ({ type: 'tableRow', content: cells.map(cell) });
    const table = (...rows: PMNode[]): PMNode => ({ type: 'table', content: rows });
    const same = diffMarkdownDocs(doc(table(row('名称', '说明'), row('a', '旧'))), doc(table(row('名称', '说明'), row('a', '新'))), schema);
    expect(render(same.doc)).toBe('名称说明a[-旧][+新]');
    const widened = diffMarkdownDocs(doc(table(row('a', 'b'))), doc(table(row('a', 'b', 'c'))), schema);
    expect(widened.blocks).toEqual([{ path: [0], kind: 'del' }, { path: [1], kind: 'ins' }]);
  });

  it('没有对比版本时原样返回且无改动', () => {
    const target = doc(p(text('x')));
    const r = diffMarkdownDocs(null, target, schema);
    expect(r.doc).toBe(target);
    expect(r.changed).toBe(false);
  });

  it('完全相同的文档无改动', () => {
    const r = diffMarkdownDocs(doc(p(text('同样'))), doc(p(text('同样'))), schema);
    expect(r.changed).toBe(false);
    expect(r.blocks).toEqual([]);
  });
});
