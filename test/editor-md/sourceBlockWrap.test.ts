// NoteBoard 源码模式选区包裹成块测试：与可视化模式一致，选中内容成为块正文

import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import {
  alertSourceBlock,
  codeSourceBlock,
  quoteSourceBlock,
  wrapSourceLines,
} from '../../src/features/editor-md/sourceBlockWrap';
import { calloutSourceBlock, calloutSourceSnippet, renderCalloutOpenTag } from '../../src/features/editor-md/calloutExtension';
import { DETAILS_SOURCE_SNIPPET, detailsSourceBlock } from '../../src/features/editor-md/detailsExtension';

/** 对 [from, to] 执行包裹，返回结果文本与包裹后选中的文本 */
function apply(source: string, from: number, to: number, builder: (body: string) => string) {
  const edit = wrapSourceLines(Text.of(source.split('\n')), from, to, builder);
  if (!edit) return null;
  const result = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
  return { result, selected: result.slice(edit.anchor, edit.head) };
}

/** 选中 start 文本开头到 end 文本结尾 */
function applyText(source: string, start: string, end: string, builder: (body: string) => string) {
  return apply(source, source.indexOf(start), source.indexOf(end) + end.length, builder);
}

describe('源码模式：选区包裹成块', () => {
  it('选中行内部分文字时按整行包裹为高亮块，与相邻段落空行隔开，并选中新块', () => {
    const preset = { color: 'green', icon: 'check' };
    const block = `${renderCalloutOpenTag('green', 'check')}\n\n选中这一行\n\n</div>`;
    const out = applyText('前文\n选中这一行\n后文', '这一', '这一', (body) => calloutSourceBlock(body, preset));
    expect(out?.result).toBe(`前文\n\n${block}\n\n后文`);
    expect(out?.selected).toBe(block);
  });

  it('多行包裹为提示块，空行保留在同一提示块内', () => {
    const out = applyText('甲\n\n乙', '甲', '乙', (body) => alertSourceBlock('warning', body));
    expect(out?.result).toBe('> [!WARNING]\n> 甲\n>\n> 乙');
  });

  it('选区止于下一行行首时不包含该行', () => {
    expect(apply('甲\n乙', 0, 2, quoteSourceBlock)?.result).toBe('> 甲\n\n乙');
  });

  it('首尾空行不进入正文', () => {
    const source = '\n\n代码\n\n';
    // 选区止于末尾空行的行首，该行不在范围内，末尾换行保留
    expect(apply(source, 0, source.length, codeSourceBlock)?.result).toBe('```\n代码\n```\n');
  });

  it('只选中空行时不包裹', () => {
    expect(apply('甲\n\n\n乙', 2, 3, codeSourceBlock)).toBeNull();
  });

  it('代码块围栏随正文反引号加长', () => {
    expect(codeSourceBlock('a ``` b')).toBe('````\na ``` b\n````');
  });

  it('折叠块写法与可视化模式序列化一致', () => {
    expect(detailsSourceBlock('正文')).toBe('<details>\n<summary>标题</summary>\n\n正文\n\n</details>');
  });

  it('无选区时的示例片段保持不变', () => {
    expect(DETAILS_SOURCE_SNIPPET).toBe('\n<details>\n<summary>标题</summary>\n\n折叠内容\n\n</details>\n\n');
    expect(calloutSourceSnippet()).toBe(`\n${renderCalloutOpenTag('blue', 'lightbulb')}\n\n高亮块内容\n\n</div>\n\n`);
  });
});
