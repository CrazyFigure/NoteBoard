// Markdown 原文保留测试语料：覆盖各类规范 / 非规范写法，并按大小与组成生成长文档。
import { detailsSourceBlock } from '../../../src/features/editor-md/detailsExtension';
import { columnsSourceSnippet } from '../../../src/features/editor-md/columnsExtension';
import { calloutSourceSnippet } from '../../../src/features/editor-md/calloutExtension';

export type CorpusSample = [name: string, markdown: string];

/** 编辑器序列化器本身就会输出的规范写法 */
export const CANONICAL_SAMPLES: CorpusSample[] = [
  ['标题与段落', '# 标题\n\n正文段落，含 **粗体**、*斜体*、`代码` 与 [链接](https://example.com)。\n\n## 二级标题\n\n第二段'],
  ['无序列表', '- 第一项\n- 第二项\n  - 子项\n- 第三项'],
  ['有序列表', '1. 一\n2. 二\n3. 三'],
  ['任务列表', '- [ ] 待办\n- [x] 完成'],
  ['引用', '> 引用第一段\n>\n> 引用第二段'],
  ['围栏代码', '```ts\nconst a: number = 1;\nconsole.log(a);\n```'],
  ['对齐表格', '| 名称 | 说明 |\n| ---- | ---- |\n| 一   | 甲   |\n| 二   | 乙   |'],
  ['分隔线', '上文\n\n---\n\n下文'],
  ['图片', '![图片](img/a.png "标题")'],
  ['行内公式与块公式', '质能方程 $E=mc^2$\n\n$$\n\\sum_i x_i\n$$'],
  ['Mermaid', '```mermaid\ngraph TD\n  A --> B\n```'],
  ['GitHub 提示块', '> [!NOTE]\n> 提示内容'],
  ['双链', '参见 [[笔记]] 与 [[笔记|别名]]，嵌入 ![[图片.png]]'],
  ['脚注', '正文[^1]\n\n[^1]: 脚注内容'],
  ['折叠块', detailsSourceBlock('**折叠内容**\n\n- 子项')],
  ['分栏', columnsSourceSnippet(2)],
  ['标注块', calloutSourceSnippet()],
  ['紧凑块间距', '# 标题\n正文紧跟标题\n- 列表紧跟段落'],
  ['HTML 块', '<div class="custom">\n\n**保留 HTML**\n\n</div>'],
  ['居中段落', '<div align="center">\n\n居中段落\n\n</div>'],
];

/** 编辑器会改写（规范化）的写法：必须在不编辑时逐字保留 */
export const NONCANONICAL_SAMPLES: CorpusSample[] = [
  ['星号列表', '* 甲\n* 乙\n* 丙'],
  ['加号嵌套列表', '+ 一\n   + 三空格子项\n+ 二'],
  ['括号有序列表', '1) 一\n2) 二'],
  ['重复编号', '1. a\n1. b\n1. c'],
  ['Setext 标题', 'Title\n=====\n\nSub\n---\n\n正文'],
  ['分隔线变体', 'a\n\n***\n\nb\n\n___\n\nc\n\n- - -\n\nd'],
  ['下划线强调', '_斜体_ 与 __粗体__ 与 ___二者___'],
  ['引用式链接（定义在后）', 'See [docs][ref] and [ref].\n\n[ref]: https://example.com "Title"'],
  ['引用式链接（定义在前）', '[home]: https://home.example\n\n回到 [首页][home]。'],
  ['引用定义夹在中间', '段一 [x][a]\n\n[a]: https://a.example\n\n段二 [y][a]'],
  ['重复标签的引用定义', '[d]: https://one.example\n\n用 [x][d]\n\n[d]: https://two.example\n  "第二个标题"\n\n尾'],
  ['自动链接', '<https://example.com> 与 www.example.com'],
  ['缩进代码', '段落\n\n    code line\n    more\n\n之后'],
  ['波浪线围栏', '~~~python\nprint(1)\n~~~'],
  ['紧凑表格', '|a|b|\n|-|-|\n|1|2|'],
  ['错位表格', '| a | b |\n|:--|--:|\n| long cell | x |'],
  ['无首尾竖线表格', 'a | b\n--- | ---\n1 | 2'],
  ['HTML 与行内 HTML', '<div class="x">\n<p>hi</p>\n</div>\n\ntext <span style="color:red">red</span> <kbd>Ctrl</kbd>'],
  ['HTML 注释', '<!-- 注释 -->\n\n正文'],
  ['徽章', '[![badge](https://img.shields.io/x.svg)](https://x.example) ![alt](a.png \'t\')'],
  ['紧凑 front matter', '---\ntitle: x & y\n---\n# Heading\ntext'],
  ['惰性续行引用', '> quote line\ncontinued lazily\n\n> another'],
  ['硬换行', 'line one  \nline two\\\nline three'],
  ['行尾空格', 'para with trailing   \n\nnext   '],
  ['制表符', '-\ttab item\n\n\tindented code with tab'],
  ['多个空行', 'a\n\n\n\nb\n\n\n\n\nc'],
  ['文首空行', '\n\n\n# Title\n\ntext'],
  ['文末多个换行', 'end\n\n\n'],
  ['空白行含空格', 'a\n   \n\t\nb'],
  ['实体', '&copy; &nbsp; &#169; &amp; 与字面 & < >'],
  ['转义', '\\*not em\\* 与 1\\. not list 与 \\# no'],
  ['中英混排与表情', '中文**粗体**和_斜体_ 😀 混排 English'],
  ['星号任务列表', '* [ ] todo\n* [x] done'],
  ['混合嵌套', '1. a\n   * b\n     1. c\n2. d'],
  ['闭合井号标题', '## Title ##\n\n# Another #'],
  ['尖括号链接与单引号标题', '[a](<b c> \'title\') 与 [d](e "f")'],
  ['列表松散间距', '- a\n\n- b\n\n\n- c'],
  ['引用内列表', '> * a\n> * b\n>\n> text'],
  ['Windows 路径', '见 C:\\Users\\x\\file.md 与 [文件](C:\\Docs\\a.md)'],
  ['大写提示块', '> [!warning]\n> careful'],
  ['紧凑代码围栏', 'text\n```\ncode\n```\ntext'],
];

/** 只能出现在文末 / 文首或会影响拼接的样例，单独测试，不参与长文档拼接 */
export const STANDALONE_SAMPLES: CorpusSample[] = [
  ['未闭合围栏', '正文\n\n```js\nconst a = 1;\nlet b'],
  ['CRLF 换行', '# T\r\n\r\n* a\r\n* b\r\n\r\ntext\r\n'],
  ['无结尾换行', 'no newline at end'],
  ['单个换行结尾', 'one\n'],
  ['只有引用定义', '[a]: https://a.example'],
];

export const ALL_SAMPLES: CorpusSample[] = [...CANONICAL_SAMPLES, ...NONCANONICAL_SAMPLES, ...STANDALONE_SAMPLES];

/** 文档组成 */
export type CorpusComposition = 'canonical' | 'noncanonical' | 'extreme';

/** 极端组成：超长单列表、超长表格、海量短段落、大段代码块交替出现 */
function extremeChunk(seed: number): string {
  switch (seed % 4) {
    case 0:
      return Array.from({ length: 400 }, (_, index) => `* 列表项 ${seed}-${index} 含 _强调_`).join('\n');
    case 1:
      return ['|a|b|c|', '|-|-|-|', ...Array.from({ length: 300 }, (_, index) => `|${seed}|行 ${index}|**x**|`)].join('\n');
    case 2:
      return Array.from({ length: 300 }, (_, index) => `短段 ${seed}-${index}`).join('\n\n');
    default:
      return ['```', ...Array.from({ length: 400 }, (_, index) => `line ${seed}-${index} = value * 2 // _x_`), '```'].join('\n');
  }
}

/** 拼接语料直到达到目标字符数；以带序号的标题分隔，保证各块内容不完全重复。 */
export function generateDocument(composition: CorpusComposition, targetChars: number): string {
  return `${generateSections(composition, targetChars).join('\n\n')}\n`;
}

/** 生成各节原文（generateDocument 以空行连接并补末尾换行） */
export function generateSections(composition: CorpusComposition, targetChars: number): string[] {
  const parts: string[] = [];
  let size = 0;
  let index = 0;
  const pool = composition === 'canonical' ? CANONICAL_SAMPLES : NONCANONICAL_SAMPLES;
  while (size < targetChars) {
    const heading = composition === 'noncanonical' ? `Section ${index}\n----------` : `## 第 ${index} 节`;
    const body = composition === 'extreme' ? extremeChunk(index) : pool[index % pool.length][1].replace(/^\n+/, '').replace(/\n+$/, '');
    const chunk = `${heading}\n\n${body}`;
    parts.push(chunk);
    size += chunk.length + 2;
    index += 1;
  }
  return parts;
}
