// 含空格的图片地址通过真实主线程和后台扩展解析，验证节点、源码保留和编辑后重新打开。
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { buildCoreExtensions } from '../../src/features/editor-md/extensions/core';
import { createIsolatedMarkdownParser } from '../../src/features/editor-md/markdownBlockStart';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { resolveRelativeDocPath } from '../../src/features/editor-md/linkHandler';

// 路径落盘语义随宿主平台切换，图片语法解析本身始终使用同一套规则。
const platform = vi.hoisted(() => ({ windows: true }));
vi.mock('../../src/core/platform', async (original) => ({
  ...await original<typeof import('../../src/core/platform')>(),
  get USES_WINDOWS_PATHS() { return platform.windows; },
}));
afterEach(() => { platform.windows = true; });

const editors = [buildCoreExtensions(), buildExtensions('image-paths')]
  .map((extensions) => new Editor({ element: null, extensions, content: '' }));
afterAll(() => editors.forEach((editor) => editor.destroy()));

const paths = [
  '../../asserts/images/win10_win11 修复文件资源管理器不显示图片预览问题/5247f306948308b81791b2aa914e94dd58144616.webp',
  './images/my photo.png',
  './images/two  spaces/图片.png',
  './images/全角　空格/图片.png',
  './images/nonbreaking\u00a0space/图片.png',
  './images/tab\tname/图片.png',
  './images/folder (v1 (copy))/图片 1.png',
  './images/100% done/图片.png',
  './images/already%20encoded/图片 1.png',
  String.raw`C:\My Notes\_images\图片 1.png`,
  String.raw`..\My Notes\_images\图片 1.png`,
  String.raw`\\server\My Notes\图片 1.png`,
  'C:/My Notes/图片 1.png',
  '/Users/user/My Notes/图片 1.png',
  '/home/user/My Notes/图片 1.png',
  '/storage/emulated/0/My Notes/图片 1.png',
  '/var/mobile/My Notes/图片 1.png',
  'file:///C:/My Notes/图片 1.png',
  'file:///Users/user/My Notes/图片 1.png',
];

describe.each(editors.map((editor, index) => ({ editor, kind: index === 0 ? '后台' : '主线程' })))('$kind 图片空格路径', ({ editor }) => {
  it.each(paths)('解析并原样保存 %s', (src) => {
    const markdown = `![图片](${src})\n`;
    expect(parseMarkdown(editor, markdown)).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe('image');
    expect(editor.state.doc.firstChild?.attrs).toMatchObject({ src, alt: '图片' });
    expect(serializeMarkdown(editor)).toBe(markdown);
    editor.state.doc.check();
  });

  it.each(['"图片说明"', "'图片说明'", '(图片说明)', '"说明带 \\"引号\\" 和 )"'])('保留标题 %s', (title) => {
    const markdown = `![图 [片]](./my images/图片.png ${title})`;
    expect(parseMarkdown(editor, markdown)).toBe(true);
    expect(editor.state.doc.firstChild?.attrs).toMatchObject({ src: './my images/图片.png', alt: '图 [片]' });
    expect(editor.state.doc.firstChild?.attrs.title).toBe(title.slice(1, -1).replace(/\\"/g, '"'));
    expect(serializeMarkdown(editor)).toBe(markdown);
  });

  it('图片编辑后以标准尖括号地址保存，再次打开保持路径', () => {
    expect(parseMarkdown(editor, '![原说明](./my images/图片 (1).png)')).toBe(true);
    editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, {
      ...editor.state.doc.firstChild!.attrs, alt: '新说明',
    }));
    const markdown = serializeMarkdown(editor);
    expect(markdown).toBe('![新说明](<./my images/图片 (1).png>)');
    expect(parseMarkdown(editor, markdown)).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.src).toBe('./my images/图片 (1).png');
  });

  it('支持带链接图片、嵌套容器及同一段中的多张图片', () => {
    const markdown = '[![图](./my images/图片.png)](https://example.com "链接说明")\n\n'
      + '> ![引用](./my images/引用.png)\n\n'
      + '- ![列表](./my images/列表.png)\n\n'
      + '![甲](./my images/甲.png) ![乙](./my images/乙.png)';
    expect(parseMarkdown(editor, markdown)).toBe(true);
    const sources: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') sources.push(node.attrs.src);
    });
    expect(sources).toEqual(['./my images/图片.png', './my images/引用.png', './my images/列表.png', './my images/甲.png', './my images/乙.png']);
    expect(editor.state.doc.firstChild?.firstChild?.attrs).toMatchObject({ href: 'https://example.com', linkTitle: '链接说明' });
    expect(serializeMarkdown(editor)).toBe(markdown);
  });
});

describe('图片兼容规则的语法边界', () => {
  const parser = createIsolatedMarkdownParser();

  it.each([
    String.raw`\![图](./my images/图片.png)`,
    '`![图](./my images/图片.png)`',
    '```md\n![图](./my images/图片.png)\n```',
    '[普通链接](./my images/图片.png)',
    '![图](./my images/未闭合.png',
    '![图](./my images/(未闭合.png)',
    '![图](./my images/\n图片.png)',
  ])('保留转义、代码、普通链接及不完整语法 %s', (markdown) => {
    expect(parser.parse(markdown)).not.toContain('<img');
  });

  it('保持标准地址、编码空格和引用式图片语法', () => {
    const tokens = parser.lexer('![甲](<./my images/甲.png> "说明")\n\n![乙](./my%20images/乙.png)\n\n![丙][图]\n\n[图]: <./my images/丙.png>');
    const images = tokens.flatMap((token) => token.type === 'paragraph' && 'tokens' in token ? token.tokens ?? [] : []);
    expect(images.map((token) => token.type === 'image' && token.href)).toEqual([
      './my images/甲.png', './my%20images/乙.png', './my images/丙.png',
    ]);
  });
});

describe.each(['Windows', 'macOS', 'Linux', 'Android', 'iOS'])('%s 图片路径解析', (system) => {
  it.each(['目录 含空格/图片 1.png', '100% done/图片.png', 'already%20encoded/图片 1.png'])('解析到实际文件地址 %s', (path) => {
    platform.windows = system === 'Windows';
    const base = platform.windows ? 'C:\\My Notes\\docs' : '/My Notes/docs';
    const parser = createIsolatedMarkdownParser();
    const block = parser.lexer(`![图](../${path})`)[0];
    if (block.type !== 'paragraph') throw new Error('图片应位于段落 token 中');
    const image = block.tokens?.[0];
    if (image?.type !== 'image') throw new Error('地址应识别为图片');
    const expected = `/My Notes/${path.replace('%20', ' ')}`;
    expect(resolveRelativeDocPath(base, image.href)).toBe(platform.windows ? `C:${expected.replace(/\//g, '\\')}` : expected);
  });
});
