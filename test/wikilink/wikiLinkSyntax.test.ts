// 双链语法：拆分、显示名与原文提取
import { describe, expect, it } from 'vitest';
import {
  extractHeadingSection,
  extractWikiLinks,
  findWikiLinkStart,
  formatWikiLinkInner,
  matchWikiLinkAtStart,
  stripFrontMatter,
  parseWikiLinkInner,
  wikiLinkLabel,
} from '../../src/features/wikilink/wikiLinkSyntax';

describe('parseWikiLinkInner', () => {
  it('拆分目标、标题与显示名', () => {
    expect(parseWikiLinkInner('笔记')).toEqual({ target: '笔记', heading: '', alias: '' });
    expect(parseWikiLinkInner('dir/笔记#第二节|看这里')).toEqual({ target: 'dir/笔记', heading: '第二节', alias: '看这里' });
    expect(parseWikiLinkInner('#本文标题')).toEqual({ target: '', heading: '本文标题', alias: '' });
  });

  it('表格中的 \\| 与 | 等价', () => {
    expect(parseWikiLinkInner('a\\|b')).toEqual({ target: 'a', heading: '', alias: 'b' });
  });

  it('显示文字：显示名优先，目录只显示末段', () => {
    expect(wikiLinkLabel(parseWikiLinkInner('dir/笔记'))).toBe('笔记');
    expect(wikiLinkLabel(parseWikiLinkInner('笔记#小节'))).toBe('笔记 › 小节');
    expect(wikiLinkLabel(parseWikiLinkInner('#小节'))).toBe('小节');
    expect(wikiLinkLabel(parseWikiLinkInner('笔记|别名'))).toBe('别名');
  });

  it('format 与 parse 互逆', () => {
    const parts = { target: 'a/b', heading: 'h', alias: 'x' };
    expect(parseWikiLinkInner(formatWikiLinkInner(parts))).toEqual(parts);
  });
});

describe('matchWikiLinkAtStart', () => {
  it('只匹配开头的完整双链', () => {
    expect(matchWikiLinkAtStart('[[a b]] rest')).toEqual({ raw: '[[a b]]', inner: 'a b', embed: false });
    expect(matchWikiLinkAtStart('x [[a]]')).toBeNull();
    expect(matchWikiLinkAtStart('[[  ]]')).toBeNull();
    expect(matchWikiLinkAtStart('[[a\nb]]')).toBeNull();
    expect(matchWikiLinkAtStart('[[a [b] ]]')).toBeNull();
  });
});

describe('嵌入写法', () => {
  it('匹配 ![[...]] 并标记嵌入', () => {
    expect(matchWikiLinkAtStart('![[图.png|300]] 后')).toEqual({ raw: '![[图.png|300]]', inner: '图.png|300', embed: true });
    expect(matchWikiLinkAtStart('[[a]]')?.embed).toBe(false);
    expect(findWikiLinkStart('前文![[a]]')).toBe(2);
    expect(findWikiLinkStart('前文[[a]]')).toBe(2);
  });

  it('提取时区分嵌入并包含 ! 的偏移', () => {
    const [link] = extractWikiLinks('x ![[笔记#节]]');
    expect(link).toMatchObject({ inner: '笔记#节', embed: true, from: 2, to: 11 });
  });

  it('截取标题小节到下一个同级标题', () => {
    const markdown = '# 总\n\n## 甲\n甲内容\n### 甲子\n子内容\n## 乙\n乙内容';
    expect(extractHeadingSection(markdown, '甲')).toBe('## 甲\n甲内容\n### 甲子\n子内容');
    expect(extractHeadingSection(markdown, '乙')).toBe('## 乙\n乙内容');
    expect(extractHeadingSection(markdown, '不存在')).toBeNull();
  });

  it('去掉文首 front matter', () => {
    expect(stripFrontMatter('---\ntitle: x\n---\n\n正文')).toBe('正文');
    expect(stripFrontMatter('正文\n---')).toBe('正文\n---');
  });
});

describe('extractWikiLinks', () => {
  it('跳过 front matter 中的方括号', () => {
    expect(extractWikiLinks('---\nrelated: [[元数据]]\n---\n[[正文]]').map((link) => link.inner)).toEqual(['正文']);
  });

  it('提取行号与所在行', () => {
    const links = extractWikiLinks('标题\n见 [[甲]] 与 [[乙|别名]]\n');
    expect(links.map((link) => [link.inner, link.line])).toEqual([['甲', 1], ['乙|别名', 1]]);
    expect(links[0].lineText).toBe('见 [[甲]] 与 [[乙|别名]]');
  });

  it('跳过围栏代码、行内代码与转义', () => {
    const markdown = [
      '```md',
      '[[代码块内]]',
      '```',
      '`[[行内代码]]` 与 \\[[转义]] 与 [[真链接]]',
      '~~~~',
      '```',
      '[[仍在波浪围栏内]]',
      '~~~~',
      '[[围栏后]]',
    ].join('\n');
    expect(extractWikiLinks(markdown).map((link) => link.inner)).toEqual(['真链接', '围栏后']);
  });
});
