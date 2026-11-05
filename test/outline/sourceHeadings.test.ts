// NoteBoard 大纲 - 源码标题提取测试
// 源码模式（含不挂载可视化内核的大文档）直接从原文行提取标题，位置用于跳转与重命名

import { describe, it, expect } from 'vitest';
import { extractSourceHeadings } from '@/features/outline/sourceHeadings';

function extract(markdown: string) {
  return extractSourceHeadings(markdown.split('\n'));
}

/** 按提取结果的文字范围替换，模拟大纲重命名 */
function rename(markdown: string, index: number, value: string): string {
  const heading = extract(markdown)[index];
  return markdown.slice(0, heading.textFrom) + value + markdown.slice(heading.textTo);
}

describe('extractSourceHeadings', () => {
  it('提取 ATX 标题的级别、文字与行首位置', () => {
    const markdown = '# 一级\n\n正文\n\n## 二级 ##\n###### 六级\n####### 不是标题';
    expect(extract(markdown)).toEqual([
      { id: 'h-0', level: 1, text: '一级', pos: 0, textFrom: 2, textTo: 4 },
      { id: 'h-10', level: 2, text: '二级', pos: 10, textFrom: 13, textTo: 15 },
      { id: 'h-19', level: 6, text: '六级', pos: 19, textFrom: 26, textTo: 28 },
    ]);
  });

  it('跳过空标题、无空格的井号与缩进代码', () => {
    expect(extract('#\n## \n#标签\n    # 缩进代码\n   # 三格缩进')).toEqual([
      expect.objectContaining({ level: 1, text: '三格缩进' }),
    ]);
  });

  it('跳过围栏代码内的井号行，闭合围栏须同字符且不短于开启', () => {
    const markdown = '````md\n# 代码里\n```\n# 仍在代码里\n````\n# 外面\n~~~\n# 波浪围栏\n~~~\n## 结束';
    expect(extract(markdown).map((h) => h.text)).toEqual(['外面', '结束']);
  });

  it('跳过文首 front matter，YAML 下的 --- 不被当成 Setext 标题', () => {
    const markdown = '---\ntitle: 测试\n---\n\n# 正文标题';
    expect(extract(markdown).map((h) => h.text)).toEqual(['正文标题']);
  });

  it('首个内容行不是 YAML 键时不视为 front matter', () => {
    expect(extract('---\n# 标题\n---').map((h) => h.text)).toEqual(['标题']);
  });

  it('识别 Setext 标题（多行段落合并为标题文字）', () => {
    const markdown = '主标题\n===\n\n第一行\n第二行\n---\n';
    expect(extract(markdown)).toEqual([
      { id: 'h-0', level: 1, text: '主标题', pos: 0, textFrom: 0, textTo: 3 },
      { id: 'h-9', level: 2, text: '第一行 第二行', pos: 9, textFrom: 9, textTo: 16 },
    ]);
  });

  it('列表、引用、表格之后的 --- 是分隔线而不是标题', () => {
    expect(extract('- 列表项\n---\n\n> 引用\n---\n\n| a |\n---\n\n\n---')).toEqual([]);
  });

  it('段落被列表中断后，下划线不会把之前的段落变成标题', () => {
    expect(extract('段落\n- 列表\n---')).toEqual([]);
  });

  it('分隔线不开启段落，其后的段落仍可成为 Setext 标题', () => {
    expect(extract('***\n内容\n---').map((h) => [h.level, h.text, h.pos])).toEqual([[2, '内容', 4]]);
    expect(extract('正文\n\n---\n标题\n---').map((h) => h.text)).toEqual(['标题']);
  });

  it('标题文字去掉常见行内标记', () => {
    const markdown = '# **重点** 与 `code`、[链接](https://a.b)、[[笔记|别名]]、\\#号 ~~删~~';
    expect(extract(markdown)[0].text).toBe('重点 与 code、链接、别名、#号 删');
  });

  it('兼容 CRLF 行尾', () => {
    const markdown = '# 标题\r\n\r\n段落\r\n---\r\n';
    const headings = extract(markdown);
    expect(headings.map((h) => [h.level, h.text])).toEqual([[1, '标题'], [2, '段落']]);
    expect(markdown.slice(headings[1].textFrom, headings[1].textTo)).toBe('段落');
  });

  it('文字范围只覆盖标题文字，重命名保留标记符与闭合井号', () => {
    expect(rename('## 旧标题 ##\n', 0, '新标题')).toBe('## 新标题 ##\n');
    expect(rename('正文\n\n  旧标题  \n===\n', 0, '新标题')).toBe('正文\n\n  新标题  \n===\n');
  });

  it('大文档线性扫描', () => {
    const chapter = '## 章节\n\n' + '正文内容。'.repeat(200) + '\n\n```\n# 代码\n```\n\n';
    const markdown = chapter.repeat(2_000);
    const headings = extract(markdown);
    expect(markdown.length).toBeGreaterThan(2_000_000);
    expect(headings).toHaveLength(2_000);
    expect(headings[1999].pos).toBe(chapter.length * 1999);
  });
});
