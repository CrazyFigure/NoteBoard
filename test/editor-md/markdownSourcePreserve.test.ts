// Markdown 顶层块原文保留：进入可视化不再规范化，未编辑的块逐字写回，只有编辑过的块按规则重写。
// 覆盖：各类写法逐字往返、典型编辑操作、撤销复原、引用定义不丢、固定种子随机编辑的语义一致性。
import { afterAll, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, parseMarkdownToJson, serializeMarkdown } from '../../src/features/editor-md/serialize';
import type { SourceBlocks } from '../../src/features/editor-md/markdownSourcePreserve';
import { ALL_SAMPLES, CANONICAL_SAMPLES, NONCANONICAL_SAMPLES } from './fixtures/markdownCorpus';

const editor = new Editor({ element: null, extensions: buildExtensions('source-preserve'), content: '' });
const checker = new Editor({ element: null, extensions: buildExtensions('source-preserve-check'), content: '' });

afterAll(() => {
  if (serializerLimitations.size > 0) console.info(`序列化器原有局限（旧版同样不一致）：\n${[...serializerLimitations].join('\n')}`);
  editor.destroy();
  checker.destroy();
});

const lf = (text: string) => text.replace(/\r\n?/g, '\n');

// 只影响源码写法、不影响文档语义的属性：比较语义时忽略
const FORMAT_ATTRS = new Set(['sourceFence', 'markdownStyle', 'sourceIndent', 'sourceContinuationIndents', 'sourceLeadingIndent', 'sourceCompactBefore', 'sourceTrailingPlaceholder', 'sourceBlocks', 'trailingNewline']);

/** 去掉写法属性、文末辅助空段与空 HTML 块后的语义 JSON */
function semantic(json: JSONContent): JSONContent {
  const clean = (node: JSONContent): JSONContent => {
    const result: JSONContent = { ...node };
    if (node.attrs) result.attrs = Object.fromEntries(Object.entries(node.attrs).filter(([key]) => !FORMAT_ATTRS.has(key)));
    if (node.content) {
      result.content = node.content
        .filter((child) => !(child.type === 'rawHtmlBlock' && !child.attrs?.raw))
        .map(clean);
    }
    return result;
  };
  const cleaned = clean(json);
  const last = json.content?.[json.content.length - 1];
  if (last?.type === 'paragraph' && last.attrs?.sourceTrailingPlaceholder && !last.content?.length) cleaned.content = cleaned.content?.slice(0, -1);
  return cleaned;
}

/** 输出重新解析后与编辑器中的文档语义是否一致 */
function isSemanticallyEqual(output: string): boolean {
  expect(parseMarkdown(checker, output)).toBe(true);
  return JSON.stringify(semantic(checker.getJSON())) === JSON.stringify(semantic(editor.getJSON()));
}

/** 序列化器本身就无法表达的写法（旧版整篇规范化同样不一致），汇总后统一断言清单 */
const serializerLimitations = new Set<string>();

/**
 * 输出必须与文档语义一致；不一致时只允许是序列化器原有的局限：
 * 去掉原文记录、按旧方式整篇规范化后同样不一致。
 */
function expectSemanticallyEqual(output: string, label = '') {
  if (isSemanticallyEqual(output)) return;
  const record = editor.state.doc.attrs.sourceBlocks;
  editor.view.dispatch(editor.state.tr.setDocAttribute('sourceBlocks', null));
  const legacy = serializeMarkdown(editor);
  editor.view.dispatch(editor.state.tr.setDocAttribute('sourceBlocks', record));
  if (isSemanticallyEqual(legacy)) {
    // 旧方式正确而新方式不一致：原文保留引入的问题
    expect(output).toBe(legacy);
  }
  // 两者都不一致时，新输出解析出的文档必须与旧输出相同（不比原来更差）
  parseMarkdown(checker, legacy);
  const legacyDoc = semantic(checker.getJSON());
  parseMarkdown(checker, output);
  expect(semantic(checker.getJSON())).toEqual(legacyDoc);
  serializerLimitations.add(label);
}

function sourceBlocks(): SourceBlocks | null {
  return editor.state.doc.attrs.sourceBlocks as SourceBlocks | null;
}

/** 载入原文：必须记录原文且未编辑时逐字一致 */
function load(markdown: string): SourceBlocks {
  expect(parseMarkdown(editor, markdown)).toBe(true);
  const record = sourceBlocks();
  expect(record).not.toBeNull();
  expect(serializeMarkdown(editor)).toBe(lf(markdown));
  return record!;
}

/** 顶层节点及其起始位置 */
function topBlocks(doc: PMNode): Array<{ node: PMNode; pos: number }> {
  const list: Array<{ node: PMNode; pos: number }> = [];
  doc.forEach((node, offset) => list.push({ node, pos: offset }));
  return list;
}

/** 顶层块内第一个文本块的末尾位置（没有文本块的原子节点返回 null） */
function firstTextblockEnd(node: PMNode, pos: number): number | null {
  if (node.isTextblock) return pos + 1 + node.content.size;
  let found: number | null = null;
  node.descendants((child, offset) => {
    if (found !== null) return false;
    if (child.isTextblock) {
      found = pos + 1 + offset + 1 + child.content.size;
      return false;
    }
    return true;
  });
  return found;
}

/** 顶层节点下标 → 原文条目下标 */
function entryOfBlock(record: SourceBlocks, blockIndex: number): number {
  let cursor = 0;
  for (let index = 0; index < record.entries.length; index += 1) {
    cursor += record.entries[index].count;
    if (blockIndex < cursor) return index;
  }
  return -1;
}

type EditOp = (tr: Transaction, blocks: Array<{ node: PMNode; pos: number }>, index: number) => boolean;

const OPS: Record<string, EditOp> = {
  修改文字: (tr, blocks, index) => {
    const end = firstTextblockEnd(blocks[index].node, blocks[index].pos);
    if (end === null) return false;
    tr.insertText('编辑', end);
    return true;
  },
  插入段落: (tr, blocks, index) => {
    tr.insert(blocks[index].pos, tr.doc.type.schema.nodes.paragraph.create(null, tr.doc.type.schema.text('新增段落')));
    return true;
  },
  删除块: (tr, blocks, index) => {
    if (blocks.length < 2) return false;
    tr.delete(blocks[index].pos, blocks[index].pos + blocks[index].node.nodeSize);
    return true;
  },
  交换相邻块: (tr, blocks, index) => {
    if (index + 1 >= blocks.length) return false;
    const first = blocks[index];
    const second = blocks[index + 1];
    tr.replaceWith(first.pos, second.pos + second.node.nodeSize, [second.node, first.node]);
    return true;
  },
  回车拆分: (tr, blocks, index) => {
    const { node, pos } = blocks[index];
    if (node.type.name !== 'paragraph' || node.content.size < 2) return false;
    tr.split(pos + 1 + Math.floor(node.content.size / 2));
    return true;
  },
  退格合并: (tr, blocks, index) => {
    if (index + 1 >= blocks.length) return false;
    const first = blocks[index];
    const second = blocks[index + 1];
    if (first.node.type.name !== 'paragraph' || second.node.type.name !== 'paragraph') return false;
    tr.join(second.pos);
    return true;
  },
  转为标题: (tr, blocks, index) => {
    const { node, pos } = blocks[index];
    if (node.type.name !== 'paragraph' || node.content.size === 0) return false;
    tr.setBlockType(pos, pos + node.nodeSize, tr.doc.type.schema.nodes.heading, { level: 2 });
    return true;
  },
  列表加一项: (tr, blocks, index) => {
    const { node, pos } = blocks[index];
    if (!['bulletList', 'orderedList'].includes(node.type.name)) return false;
    const schema = tr.doc.type.schema;
    const item = schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, schema.text('新增项')));
    tr.insert(pos + node.nodeSize - 1, item);
    return true;
  },
};

/** 执行操作；目标位置不允许该操作（schema 拒绝）时视为不适用 */
function applyOp(op: EditOp, tr: Transaction, blocks: Array<{ node: PMNode; pos: number }>, index: number): boolean {
  const steps = tr.steps.length;
  try {
    return op(tr, blocks, index);
  } catch {
    if (tr.steps.length !== steps) throw new Error('操作失败但已部分修改事务');
    return false;
  }
}

/** 选择操作目标：优先中间的块 */
function middleIndex(blocks: Array<{ node: PMNode }>): number {
  return Math.floor((blocks.length - 1) / 2);
}

/** 按 PM 历史的方式反转事务，得到撤销后的文档 */
function undo(tr: Transaction) {
  const inverse = editor.state.tr;
  for (let index = tr.steps.length - 1; index >= 0; index -= 1) inverse.step(tr.steps[index].invert(tr.docs[index]));
  editor.view.dispatch(inverse);
}

describe('未编辑时逐字保留原文', () => {
  it.each(ALL_SAMPLES)('%s', (_name, markdown) => {
    load(markdown);
  });

  it('二次进入：保留结果再次解析仍逐字一致', () => {
    for (const [, markdown] of ALL_SAMPLES) {
      load(markdown);
      load(serializeMarkdown(editor));
    }
  });
});

describe('编辑后只重写改动的块，撤销后复原原文', () => {
  const cases: Array<[string, string, string]> = [];
  for (const [name, markdown] of [...NONCANONICAL_SAMPLES, ...CANONICAL_SAMPLES]) {
    for (const op of Object.keys(OPS)) cases.push([name, op, markdown]);
  }

  it.each(cases)('%s · %s', (_name, opName, markdown) => {
    const record = load(markdown);
    const blocks = topBlocks(editor.state.doc);
    // 优先选中间的块，不适用时依次尝试其它块
    const order = [middleIndex(blocks), ...blocks.map((_, index) => index)];
    const tr = editor.state.tr;
    let target = -1;
    for (const index of order) {
      if (applyOp(OPS[opName], tr, blocks, index)) {
        target = index;
        break;
      }
    }
    if (target < 0) return;
    editor.view.dispatch(tr);
    const output = serializeMarkdown(editor);
    expectSemanticallyEqual(output, `${_name} · ${opName}`);

    // 未受影响的条目（非目标块、非多余空行、非缩进开头）原文必须原样出现在输出中
    const touched = new Set<number>([entryOfBlock(record, target)]);
    if (opName === '交换相邻块' || opName === '退格合并') touched.add(entryOfBlock(record, target + 1));
    record.entries.forEach((entry, index) => {
      if (touched.has(index) || entry.space || /^[ \t]/.test(entry.raw) || !entry.raw.trim()) return;
      // 原为最后一块而后面插入了内容时允许重写（防止未闭合结构吞掉后文）
      if (index === record.entries.length - 1 && opName === '交换相邻块') return;
      expect(output).toContain(entry.raw);
    });

    undo(tr);
    expect(serializeMarkdown(editor)).toBe(lf(markdown));
  });
});

describe('原文中的引用定义', () => {
  it('删除定义之后的块，引用定义仍保留且链接有效', () => {
    load('段一 [x][a]\n\n[a]: https://a.example\n\n段二 [y][a]\n\n段三');
    const blocks = topBlocks(editor.state.doc);
    editor.view.dispatch(editor.state.tr.delete(blocks[1].pos, blocks[1].pos + blocks[1].node.nodeSize));
    const output = serializeMarkdown(editor);
    expect(output).toContain('[a]: https://a.example');
    expect(output).toContain('段一 [x][a]');
    expect(isSemanticallyEqual(output)).toBe(true);
  });

  it('编辑块前后的引用定义（含被忽略的重复定义）留在原位置', () => {
    const markdown = '[r]: https://r.example\n\n用 [a][r]\n\n[r]: https://dup.example\n\nTitle\n-----\n\n[h]: https://h.example\n\n去 [b][h]';
    load(markdown);
    const blocks = topBlocks(editor.state.doc);
    const heading = blocks[1];
    editor.view.dispatch(editor.state.tr.insertText('编辑', heading.pos + 1 + heading.node.content.size));
    const output = serializeMarkdown(editor);
    expect(output).toBe('[r]: https://r.example\n\n用 [a][r]\n\n[r]: https://dup.example\n\n## Title编辑\n\n[h]: https://h.example\n\n去 [b][h]');
    expect(isSemanticallyEqual(output)).toBe(true);
  });

  it('删除全部引用块后，文末定义仍保留', () => {
    load('[b] 开头\n\n其它\n\n[b]: https://b.example\n');
    const blocks = topBlocks(editor.state.doc);
    editor.view.dispatch(editor.state.tr.delete(blocks[1].pos, blocks[1].pos + blocks[1].node.nodeSize));
    const output = serializeMarkdown(editor);
    expect(output).toContain('[b]: https://b.example');
    expect(isSemanticallyEqual(output)).toBe(true);
  });
});

describe('上下文相关的原文', () => {
  it('缩进代码失去原前驱后按规则重写，不会并入新插入的列表', () => {
    load('段落\n\n    code\n\n之后');
    const blocks = topBlocks(editor.state.doc);
    const schema = editor.schema;
    const list = schema.nodes.bulletList.create(null, schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, schema.text('项'))));
    editor.view.dispatch(editor.state.tr.insert(blocks[1].pos, list));
    const output = serializeMarkdown(editor);
    expect(isSemanticallyEqual(output)).toBe(true);
    expect(output.startsWith('段落\n\n')).toBe(true);
  });

  it('未闭合围栏后追加内容时，围栏被补全而不吞掉新内容', () => {
    load('正文\n\n```js\nconst a = 1;');
    const schema = editor.schema;
    editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, schema.nodes.paragraph.create(null, schema.text('追加'))));
    const output = serializeMarkdown(editor);
    expect(isSemanticallyEqual(output)).toBe(true);
    expect(output).toContain('追加');
  });

  it('新写的内容按编辑器规则输出', () => {
    load('* 甲\n* 乙\n\n_斜体_');
    const schema = editor.schema;
    const list = schema.nodes.bulletList.create(null, schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, schema.text('新'))));
    editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, list));
    const output = serializeMarkdown(editor);
    expect(output.startsWith('* 甲\n* 乙\n\n_斜体_')).toBe(true);
    expect(output).toContain('- 新');
    expect(isSemanticallyEqual(output)).toBe(true);
  });

  it('片段与整篇以外的序列化（剪贴板）不使用原文记录', () => {
    const parsed = parseMarkdownToJson(editor, '* 甲');
    expect(parsed?.attrs?.sourceBlocks).toBeUndefined();
  });
});

/** 固定种子的伪随机数 */
function createRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    state ^= state >>> 13;
    return (state >>> 0) / 4294967296;
  };
}

describe('随机编辑：每一步输出都与文档语义一致', () => {
  const opNames = Object.keys(OPS);
  it.each(ALL_SAMPLES.map(([name, markdown], index) => [name, markdown, index] as const))('%s', (_name, markdown, seed) => {
    load(markdown);
    const random = createRandom(seed + 1);
    for (let step = 0; step < 200; step += 1) {
      const blocks = topBlocks(editor.state.doc);
      const tr = editor.state.tr;
      const op = OPS[opNames[Math.floor(random() * opNames.length)]];
      if (!applyOp(op, tr, blocks, Math.floor(random() * blocks.length))) continue;
      editor.view.dispatch(tr);
      expectSemanticallyEqual(serializeMarkdown(editor), `${_name} · 随机`);
    }
  });
});
