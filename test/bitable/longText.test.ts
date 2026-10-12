// NoteBoard 多维表格多行文本字段单元测试
// 覆盖配置解析、Markdown 预览文本折算、粘贴归一、剪贴板格式化与文档解析容错

import { describe, test, expect } from 'vitest';
import {
  coerceCellValue,
  formatCellValue,
  firstLineOf,
  previewLongText,
  resolveLongTextConfig,
  stripMarkdown,
} from '@/features/bitable/bitableUtils';
import { parseBitableDocument, serializeBitableDocument } from '@/features/bitable/bitableConverter';
import { renderBitableMarkdown } from '@/features/bitable/BitableMarkdown';
import { DEFAULT_LONG_TEXT_CONFIG, type BitableColumn } from '@/features/bitable/bitableTypes';

const longTextCol: BitableColumn = {
  id: 'c_notes',
  key: 'notes',
  name: '任务说明',
  type: 'longText',
};

describe('多行文本字段配置解析', () => {
  test('未配置时回落到默认值（仅首行、非 Markdown）', () => {
    expect(resolveLongTextConfig(longTextCol)).toEqual(DEFAULT_LONG_TEXT_CONFIG);
  });

  test('部分配置只覆盖给定项，其余沿用默认值', () => {
    const cfg = resolveLongTextConfig({ ...longTextCol, longText: { markdown: true } });
    expect(cfg).toEqual({ displayMode: 'firstLine', markdown: true });
  });

  test('完整配置原样生效', () => {
    const cfg = resolveLongTextConfig({
      ...longTextCol,
      longText: { displayMode: 'full', markdown: true },
    });
    expect(cfg).toEqual({ displayMode: 'full', markdown: true });
  });
});

describe('多行文本预览文本折算', () => {
  test('firstLineOf 跳过开头的空行', () => {
    expect(firstLineOf('\n\n  第一行内容\n第二行')).toBe('第一行内容');
  });

  test('firstLineOf 对全空内容返回空串', () => {
    expect(firstLineOf('   \n  \n')).toBe('');
  });

  test('stripMarkdown 剥离标题、加粗、行内代码与链接标记', () => {
    const md = '## 标题\n**加粗** 与 `code` 和 [链接](https://example.com)';
    expect(stripMarkdown(md)).toBe('标题 加粗 与 code 和 链接');
  });

  test('stripMarkdown 整体移除代码围栏，不残留反引号', () => {
    const md = '说明文字\n\n```ts\nconst a = 1;\n```\n\n结尾';
    const text = stripMarkdown(md);
    expect(text).not.toContain('```');
    expect(text).not.toContain('const');
    expect(text).toBe('说明文字 结尾');
  });

  test('previewLongText 在首行模式下只取首行并去标记', () => {
    const md = '**标题行**\n第二段\n第三段';
    expect(previewLongText(md, { displayMode: 'firstLine', markdown: true })).toBe('标题行');
  });

  test('previewLongText 剥离笔记本扩展语法标记，金额与比较运算保持原样', () => {
    const config = { displayMode: 'firstLine', markdown: true } as const;
    expect(previewLongText('**加粗** ==高亮== ++下划线++ 与公式 $E=mc^2$', config)).toBe('加粗 高亮 下划线 与公式 E=mc^2');
    expect(previewLongText('售价 $5 与 $6，a == b，C++', config)).toBe('售价 $5 与 $6，a == b，C++');
    expect(previewLongText('- [x] 已完成事项', config)).toBe('已完成事项');
  });

  test('previewLongText 跳过独占一行的块标记，落到块内正文', () => {
    const config = { displayMode: 'firstLine', markdown: true } as const;
    expect(previewLongText('> [!TIP]\n> 这是提示块', config)).toBe('这是提示块');
    expect(previewLongText('<div class="nb-callout" data-color="blue">\n\n高亮块内容\n\n</div>', config)).toBe('高亮块内容');
    expect(previewLongText('```mermaid\ngraph TD\n```\n\n图表说明', config)).toBe('图表说明');
    expect(previewLongText('$$\nx^2\n$$', config)).toBe('x^2');
  });

  test('previewLongText 在全显示模式下返回原文', () => {
    const md = '**标题行**\n第二段';
    expect(previewLongText(md, { displayMode: 'full', markdown: true })).toBe(md);
  });

  test('previewLongText 在非 Markdown 列保留首行原样文本', () => {
    // 普通多行文本的 # 只是字符，不应被当成标记剥离
    expect(previewLongText('#1 事项\n其余', { displayMode: 'firstLine', markdown: false })).toBe(
      '#1 事项',
    );
  });

  test('previewLongText 对空值返回空串', () => {
    expect(previewLongText('', { displayMode: 'firstLine', markdown: true })).toBe('');
  });
});

describe('多行文本的粘贴与复制', () => {
  test('coerceCellValue 保留多行文本的换行，不做任何转换', () => {
    const raw = '第一行\n第二行';
    const { value, column } = coerceCellValue(longTextCol, raw);
    expect(value).toBe(raw);
    expect(column).toBeNull();
  });

  test('formatCellValue 把换行压平为空格，避免破坏 TSV 行结构', () => {
    expect(formatCellValue(longTextCol, '第一行\n第二行')).toBe('第一行 第二行');
  });

  test('formatCellValue 对空值返回空串', () => {
    expect(formatCellValue(longTextCol, null)).toBe('');
  });
});

describe('多行文本的 Markdown 渲染', () => {
  test('代码块被渲染为带 hljs 高亮的 pre 结构', () => {
    const html = renderBitableMarkdown('```ts\nconst a = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('hljs');
    expect(html).toContain('const');
  });

  test('原始 HTML 经白名单净化，杜绝脚本注入', () => {
    const html = renderBitableMarkdown('<script>alert(1)</script>\n\n正常文本');
    expect(html).not.toContain('<script>');
    expect(html).toContain('正常文本');
  });

  test('事件属性与非白名单 class 被剔除', () => {
    const html = renderBitableMarkdown('<div class="nb-prompt-overlay nb-callout" onclick="alert(1)">内容</div>');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('nb-prompt-overlay');
    expect(html).toContain('nb-callout');
  });

  test('公式渲染为待排版占位，金额文本不误判', () => {
    const html = renderBitableMarkdown('质能方程 $E=mc^2$，售价 $5 与 $6\n\n$$\n\\frac{a}{b}\n$$');
    expect(html).toContain('<span class="nb-md-math">E=mc^2</span>');
    expect(html).toContain('<div class="nb-md-math">\\frac{a}{b}</div>');
    expect(html).toContain('售价 $5 与 $6');
  });

  test('高亮与下划线使用安全定界，不误伤比较运算与 C++', () => {
    const html = renderBitableMarkdown('==重点== 与 ++下划线++，但 a == b 且 C++ and C++ 保持原样');
    expect(html).toContain('<mark>重点</mark>');
    expect(html).toContain('<u>下划线</u>');
    expect(html).toContain('a == b');
    expect(html).toContain('C++ and C++');
  });

  test('GitHub 提示块与任务列表', () => {
    const html = renderBitableMarkdown('> [!WARNING]\n> 小心\n\n- [ ] 待办\n- [x] 完成');
    expect(html).toContain('nb-md-alert nb-md-alert-warning');
    expect(html).toContain('Warning');
    expect(html).not.toContain('[!WARNING]');
    expect(html).toContain('nb-md-task-list');
    expect(html).toContain('<li class="nb-md-task nb-md-task-checked">');
    expect(html).not.toContain('[x]');
  });

  test('高亮块、分栏、折叠块按 HTML 结构渲染且内部 Markdown 生效', () => {
    const md = [
      '<div class="nb-callout" data-color="blue" style="background: #eff6ff;">',
      '',
      '**提示**内容',
      '',
      '</div>',
      '',
      '<details>',
      '<summary>展开</summary>',
      '',
      '隐藏内容',
      '',
      '</details>',
    ].join('\n');
    const html = renderBitableMarkdown(md);
    expect(html).toContain('class="nb-callout"');
    expect(html).toContain('<strong>提示</strong>');
    expect(html).toContain('<summary>展开</summary>');
    expect(html).toContain('隐藏内容');
  });

  test('图表围栏以占位展示，普通代码块不受影响', () => {
    const html = renderBitableMarkdown('```mermaid\ngraph TD\n  A --> B\n```');
    expect(html).toContain('Mermaid 图表');
    expect(html).not.toContain('graph TD');
  });

  test('常见块级与行内标记正常渲染', () => {
    const html = renderBitableMarkdown('## 标题\n\n**粗体** 与 `code`\n\n- 列表项');
    expect(html).toContain('<h2>');
    expect(html).toContain('<strong>粗体</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>列表项</li>');
  });

  test('单换行按 breaks 规则渲染为换行', () => {
    const html = renderBitableMarkdown('第一行\n第二行');
    expect(html).toContain('<br>');
  });

  test('空内容返回空串且不抛错', () => {
    expect(renderBitableMarkdown('')).toBe('');
  });
});

describe('多行文本列的文档解析容错', () => {
  test('longText 配置缺失时补全默认值', () => {
    const doc = parseBitableDocument(
      JSON.stringify({
        schemaVersion: 1,
        title: '测试表',
        columns: [{ id: 'c1', key: 'notes', name: '说明', type: 'longText' }],
        rows: [],
        views: [{ id: 'v1', name: '表格', type: 'grid' }],
      }),
    );
    expect(doc.columns[0].type).toBe('longText');
    expect(doc.columns[0].longText).toEqual(DEFAULT_LONG_TEXT_CONFIG);
  });

  test('longText 配置部分缺省时按项补全', () => {
    const doc = parseBitableDocument(
      JSON.stringify({
        columns: [
          { id: 'c1', key: 'notes', name: '说明', type: 'longText', longText: { markdown: true } },
        ],
        rows: [],
        views: [{ id: 'v1', name: '表格', type: 'grid' }],
      }),
    );
    expect(doc.columns[0].longText).toEqual({ displayMode: 'firstLine', markdown: true });
  });

  test('非法字段类型回落为单行文本，不把脏数据带进渲染层', () => {
    const doc = parseBitableDocument(
      JSON.stringify({
        columns: [{ id: 'c1', key: 'x', name: '异常列', type: 'notAType' }],
        rows: [],
        views: [{ id: 'v1', name: '表格', type: 'grid' }],
      }),
    );
    expect(doc.columns[0].type).toBe('text');
  });

  test('多行文本列配置可完整往返序列化', () => {
    const original = {
      schemaVersion: 1,
      title: '往返测试',
      columns: [
        {
          id: 'c1',
          key: 'notes',
          name: '说明',
          type: 'longText' as const,
          longText: { displayMode: 'full' as const, markdown: true },
        },
      ],
      rows: [{ id: 'r1', c1: '# 标题\n正文' }],
      views: [{ id: 'v1', name: '表格', type: 'grid' as const }],
    };
    const roundTrip = parseBitableDocument(serializeBitableDocument(original as never));
    expect(roundTrip.columns[0].longText).toEqual({ displayMode: 'full', markdown: true });
    expect(roundTrip.rows[0].c1).toBe('# 标题\n正文');
  });
});
