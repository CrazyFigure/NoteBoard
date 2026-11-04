// 块级分词器按需逐行读取：与整篇 split 的结果完全一致，且只读到块结束处
import { describe, expect, it } from 'vitest';
import { TaskList } from '@tiptap/extension-list';
import { Editor } from '@tiptap/core';
import { SourceLines } from '../../src/features/editor-md/sourceLines';
import { taskListScanLimit } from '../../src/features/editor-md/markdownListSpacing';
import { matchDetailsBlock } from '../../src/features/editor-md/detailsCore';
import { matchCalloutBlock, renderCalloutOpenTag } from '../../src/features/editor-md/calloutCore';
import { matchColumnsBlock, COLUMNS_OPEN_TAG } from '../../src/features/editor-md/columnsCore';
import { matchBlockFormat } from '../../src/features/editor-md/blockFormat';
import { buildExtensions } from '../../src/features/editor-md/extensions';

// 固定种子的伪随机数，失败可复现
function createRandom(seed: number) {
  let state = seed;
  return () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
}

describe('SourceLines', () => {
  it('行划分、slice 与 prefix 与 split 结果一致', () => {
    const random = createRandom(42);
    const pieces = ['', 'a', ' ', '\t', 'xyz', '中文'];
    for (let round = 0; round < 2000; round += 1) {
      let source = '';
      const length = Math.floor(random() * 12);
      for (let index = 0; index < length; index += 1) {
        source += pieces[Math.floor(random() * pieces.length)] + (random() < 0.6 ? '\n' : '');
      }
      const lines = source.split('\n');
      const reader = new SourceLines(source);
      // 乱序访问，确认按需定位不依赖顺序
      for (let probe = 0; probe < 20; probe += 1) {
        const index = Math.floor(random() * (lines.length + 3)) - 1;
        expect(reader.has(index)).toBe(index >= 0 && index < lines.length);
        expect(reader.at(index)).toBe(index >= 0 ? lines[index] : undefined);
      }
      for (let count = 1; count <= lines.length; count += 1) {
        expect(reader.prefix(count)).toBe(lines.slice(0, count).join('\n') + (count < lines.length ? '\n' : ''));
      }
      expect(reader.slice(1, lines.length + 2)).toEqual(lines.slice(1, lines.length + 2));
    }
  });
});

describe('块级分词器只读到块结束处', () => {
  // 块之后跟一段很长的剩余全文：结果与只有块本身时一致（行为不依赖剩余部分的长度）
  const tail = `\n\n${'后续正文\n\n'.repeat(5000)}`;
  const callout = renderCalloutOpenTag('blue', 'info');
  const column = '<div class="nb-column" style="flex: 50; min-width: 0;">';
  const cases: Array<[string, (src: string) => unknown, string]> = [
    ['折叠块', matchDetailsBlock, '<details>\n<summary>标题</summary>\n\n正文\n\n</details>'],
    ['高亮块', matchCalloutBlock, `${callout}\n\n内容\n\n</div>`],
    ['分栏', matchColumnsBlock, `${COLUMNS_OPEN_TAG}\n${column}\n\na\n\n</div>\n${column}\n\nb\n\n</div>\n</div>`],
    ['对齐块', matchBlockFormat, '<div align="center">\n\n居中\n\n</div>'],
  ];
  for (const [name, match, block] of cases) {
    it(name, () => {
      const alone = match(block) as { raw: string } | null;
      const followed = match(block + tail) as { raw: string } | null;
      expect(alone).not.toBeNull();
      expect(followed).toEqual({ ...alone, raw: `${block}\n` });
    });
  }
});

describe('任务列表截取范围', () => {
  const editor = new Editor({ element: null, extensions: buildExtensions('task-scan'), content: '' });
  const manager = (editor.storage as unknown as { markdown: { manager: { createLexer(): unknown; createTokenizerHelpers(lexer: unknown): unknown } } }).markdown.manager;
  const official = (TaskList.config.markdownTokenizer as { tokenize: (src: string, tokens: unknown[], lexer: unknown) => unknown }).tokenize;
  const tokenize = (src: string) => official.call({}, src, [], manager.createTokenizerHelpers(manager.createLexer()));

  it('官方 tokenizer 在截取范围内与整段剩余全文上的结果完全一致', () => {
    const random = createRandom(20261104);
    const vocabulary = [
      '', '', '  ', '\t', 'text', '正文', '  indented', '    deep', '\tcode', '# h', '```', '1. one',
      '- [ ] a', '- [x] b', '* [ ] c', '+ [X] d', '  - [ ] nested', '    - [x] deeper', '\t- [ ] tab', '- [ ]', '- [ ]  ', '- item', ' ',
    ];
    let checked = 0;
    for (let round = 0; round < 3000; round += 1) {
      const lines: string[] = [];
      const count = 1 + Math.floor(random() * 16);
      for (let index = 0; index < count; index += 1) lines.push(vocabulary[Math.floor(random() * vocabulary.length)]);
      const doc = lines.join('\n') + (random() < 0.5 ? '\n' : '');
      // 每个行首都作为一次分词的剩余全文
      const starts = [0];
      for (let index = doc.indexOf('\n'); index >= 0; index = doc.indexOf('\n', index + 1)) starts.push(index + 1);
      for (const start of starts) {
        const src = doc.slice(start);
        expect(tokenize(src.slice(0, taskListScanLimit(src)))).toEqual(tokenize(src));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10000);
  });

  it('列表结束后的长正文不在截取范围内', () => {
    const src = `- [ ] a\n- [x] b\n  - [ ] c\n\n后文\n${'更多正文\n'.repeat(1000)}`;
    expect(src.slice(0, taskListScanLimit(src))).toBe('- [ ] a\n- [x] b\n  - [ ] c\n');
  });
});
