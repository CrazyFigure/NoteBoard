// Markdown 原文图片引用扫描与改写：三种写法、标题、代码块跳过、只改地址片段
import { describe, expect, it } from 'vitest';
import { isLocalImageSrc, rewriteImageRefs, scanImageRefs } from '../../src/features/editor-md/imageRefs';

const srcs = (markdown: string) => scanImageRefs(markdown).map((ref) => ref.src);

describe('scanImageRefs', () => {
  it('识别标准、带标题、尖括号与 HTML 写法', () => {
    const markdown = [
      '![a](./img/a.png)',
      '![b](./img/b.png "标题")',
      '![c](<./img/my c.png>)',
      '<img src="./img/d.png" width="50%">',
      "<img alt='x' src='./img/e.png'>",
    ].join('\n');
    expect(srcs(markdown)).toEqual(['./img/a.png', './img/b.png', './img/my c.png', './img/d.png', './img/e.png']);
  });

  it('替代文字中的嵌套方括号与带空格的裸地址', () => {
    expect(srcs('![图 [片]](./my images/图片.png)')).toEqual(['./my images/图片.png']);
    expect(srcs('![x](./folder (v1 (copy))/图片 1.png)')).toEqual(['./folder (v1 (copy))/图片 1.png']);
  });

  it('同一行多张图片与链接包裹的图片', () => {
    expect(srcs('[![a](./img/a.png)](https://x.com) 和 ![b](img/b.png)')).toEqual(['./img/a.png', 'img/b.png']);
  });

  it('忽略网络地址、Base64 与锚点', () => {
    expect(srcs('![a](https://x.com/a.png) ![b](data:image/png;base64,AAA) <img src="http://x/y.png"> ![c](#top)')).toEqual([]);
  });

  it('保留 Windows 绝对路径与 file 地址', () => {
    expect(srcs('![a](C:\\pics\\a.png) ![b](file:///C:/pics/b.png)')).toEqual(['C:\\pics\\a.png', 'file:///C:/pics/b.png']);
  });

  it('跳过围栏代码块、缩进代码块、行内代码与 front matter', () => {
    const markdown = [
      '---',
      'cover: ![x](./img/fm.png)',
      '---',
      '```md',
      '![code](./img/code.png)',
      '```',
      '',
      '    ![indent](./img/indent.png)',
      '',
      '`![inline](./img/inline.png)` ![real](./img/real.png)',
      '- 列表',
      '    ![list](./img/list.png)',
    ].join('\n');
    expect(srcs(markdown)).toEqual(['./img/real.png', './img/list.png']);
  });

  it('反斜杠转义的 \\![ 不是图片', () => {
    expect(srcs('\\![a](./img/a.png)')).toEqual([]);
  });
});

describe('rewriteImageRefs', () => {
  it('只替换地址片段，标题、尺寸与其余原文保持不变', () => {
    const markdown = [
      '# 标题',
      '![a](./img/a.png "说明")',
      '<img src="./img/a.png" width="50%" align="left">',
      '![b](./img/b.png)',
      '```',
      '![a](./img/a.png)',
      '```',
    ].join('\r\n');
    const { text, count } = rewriteImageRefs(markdown, new Map([['./img/a.png', '../assets/a.png']]));
    expect(count).toBe(2);
    expect(text).toBe([
      '# 标题',
      '![a](../assets/a.png "说明")',
      '<img src="../assets/a.png" width="50%" align="left">',
      '![b](./img/b.png)',
      '```',
      '![a](./img/a.png)',
      '```',
    ].join('\r\n'));
  });

  it('新地址含空格时 Markdown 写法补尖括号、HTML 写法转义', () => {
    const { text } = rewriteImageRefs(
      '![a](./img/a.png)\n<img src="./img/a.png">',
      new Map([['./img/a.png', '../my assets/a&b.png']]),
    );
    expect(text).toBe('![a](<../my assets/a&b.png>)\n<img src="../my assets/a&amp;b.png">');
  });

  it('尖括号原地址整体替换', () => {
    const { text } = rewriteImageRefs('![c](<./img/my c.png>)', new Map([['./img/my c.png', '../assets/c.png']]));
    expect(text).toBe('![c](../assets/c.png)');
  });

  it('改写后的原文再次扫描得到新地址', () => {
    const { text } = rewriteImageRefs('![a](./img/a.png)', new Map([['./img/a.png', '../assets/a.png']]));
    expect(srcs(text)).toEqual(['../assets/a.png']);
  });
});

describe('isLocalImageSrc', () => {
  it.each([
    ['./a.png', true],
    ['a.png', true],
    ['/home/u/a.png', true],
    ['C:/a.png', true],
    ['file:///a.png', true],
    ['https://a.png', false],
    ['asset://localhost/a', false],
    ['blob:xxx', false],
    ['', false],
  ])('%j → %s', (src, expected) => {
    expect(isLocalImageSrc(src)).toBe(expected);
  });
});
